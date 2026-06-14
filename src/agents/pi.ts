// Pi agent provider (DESIGN.md §10.2) — drives `pi --mode rpc`.
//
// Grounded in the live RPC protocol of @earendil-works/pi-coding-agent v0.79.x:
//   spawn `pi --mode rpc [--no-tools] [--model m] [--session <id>]`
//   → a session is auto-created; `get_state` returns data.sessionId/sessionFile
//   → `{type:"prompt", id, message}` → events → terminal `agent_end{messages}`
//   final text = concat assistant content parts of type "text" (skip "thinking").
// Session token (sessionId) is captured the moment get_state returns — before the
// prompt — so the write-ahead journal row holds it for crash reconnect (§10.4).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveInvocationToolPolicy, resolvedToolPolicyToPiArgs } from "./capabilities.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./defaults.ts";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
  TraceEvent,
} from "./types.ts";

export interface PiProviderOptions {
  /** Working directory (pi scopes sessions by cwd); defaults to process.cwd(). */
  cwd?: string;
  /** Binary name/path (default KEEL_PI_BIN, then "pi"). */
  bin?: string;
  /** Per-call timeout in ms before abort (default 1 hour). */
  timeoutMs?: number;
  /** Extra env passed to the Pi subprocess. */
  env?: Record<string, string>;
  /** Secret-bearing raw Pi JSONL diagnostic log path. Defaults to KEEL_PI_RAW_LOG. */
  rawLogPath?: string;
}

interface PiMessageContent {
  type: string;
  text?: string;
}
interface PiMessage {
  role: string;
  content: PiMessageContent[];
  stopReason?: string;
  errorMessage?: string;
}

export class PiProvider implements AgentProvider {
  readonly name = "pi";
  readonly supportsSessions = true;
  private readonly cwd: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly extraEnv: Record<string, string>;
  private readonly rawLogPath?: string;

  constructor(opts: PiProviderOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.bin = opts.bin ?? process.env.KEEL_PI_BIN ?? "pi";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.extraEnv = opts.env ?? {};
    this.rawLogPath = opts.rawLogPath ?? process.env.KEEL_PI_RAW_LOG;
  }

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    const args = ["--mode", "rpc"];
    args.push(
      ...resolvedToolPolicyToPiArgs(
        resolveInvocationToolPolicy({
          ...(invocation.capabilities ? { capabilities: invocation.capabilities } : {}),
          ...(invocation.toolPolicy ? { toolPolicy: invocation.toolPolicy } : {}),
          ...(invocation.allowTools ? { allowTools: invocation.allowTools } : {}),
          ...(invocation.denyTools ? { denyTools: invocation.denyTools } : {}),
        }),
      ),
    );
    if (invocation.model) args.push("--model", invocation.model);
    if (invocation.reasoning) args.push("--thinking", invocation.reasoning);
    // Reconnect to a prior session (mid-call crash recovery, §10.4).
    if (invocation.resumeToken) args.push("--session", invocation.resumeToken);

    const cwd = invocation.cwd ?? this.cwd;
    this.rawLog(invocation.key, "spawn", { bin: this.bin, args, cwd });
    const proc = Bun.spawn([this.bin, ...args], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...this.extraEnv,
        ...(invocation.env ?? {}),
      },
    });

    const transcript: TraceEvent[] = [];
    const pending = new Map<number, (resp: PiResponse) => void>();
    let nextId = 1;
    let agentEnd: { messages: PiMessage[] } | null = null;
    let streamErr: string | null = null;
    let stderrTail = "";

    const send = (cmd: Record<string, unknown>): void => {
      proc.stdin.write(`${JSON.stringify(cmd)}\n`);
      proc.stdin.flush();
    };
    const request = (cmd: Record<string, unknown>): Promise<PiResponse> =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        send({ ...cmd, id });
      });

    // Read stdout line-by-line, routing responses vs events.
    const done = new Promise<void>((resolve) => {
      void (async () => {
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of proc.stdout) {
          const text = dec.decode(chunk as Uint8Array);
          this.rawLog(invocation.key, "stdout", text);
          buf += text;
          let nl: number = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) handleLine(line);
            if (agentEnd) {
              resolve();
              return;
            }
            nl = buf.indexOf("\n");
          }
        }
        resolve();
      })();
    });
    const stderrDone = new Promise<void>((resolve) => {
      void (async () => {
        const dec = new TextDecoder();
        for await (const chunk of proc.stderr) {
          const text = dec.decode(chunk as Uint8Array);
          this.rawLog(invocation.key, "stderr", text);
          stderrTail = tail(`${stderrTail}${text}`);
        }
        resolve();
      })();
    });

    const handleLine = (line: string): void => {
      let msg: PiOut;
      try {
        msg = JSON.parse(line) as PiOut;
      } catch {
        return; // ignore non-JSON noise
      }
      if (msg.type === "response" && typeof msg.id === "number") {
        pending.get(msg.id)?.(msg as PiResponse);
        pending.delete(msg.id);
        return;
      }
      // event
      mapEvent(msg, transcript, hooks);
      if (msg.type === "agent_end") {
        if ((msg as { willRetry?: unknown }).willRetry === true) return;
        agentEnd = { messages: (msg.messages as PiMessage[]) ?? [] };
      }
    };

    const timeout = setTimeout(() => {
      streamErr = `pi agent "${invocation.key}" timed out after ${this.timeoutMs}ms`;
      send({ type: "abort", id: nextId++ });
      proc.kill();
    }, this.timeoutMs);

    // Kill the subprocess if the kernel aborts the attempt (stall handling).
    const onAbort = (): void => {
      streamErr = `pi agent "${invocation.key}" aborted (stall)`;
      proc.kill();
    };
    invocation.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      // 1) session id (write-ahead capture) — available before any model work.
      const state = await this.race(request({ type: "get_state" }), done, proc);
      const sessionId =
        state && typeof state.data === "object" && state.data
          ? (state.data as { sessionId?: string }).sessionId
          : undefined;
      let sessionToken: string | undefined;
      if (sessionId) {
        sessionToken = sessionId;
        hooks.onEvent?.({ type: "session", data: sessionId });
        hooks.onSessionToken?.(sessionId);
      }

      // 2) prompt → stream → agent_end
      send({ type: "prompt", id: nextId++, message: invocation.prompt });
      await Promise.race([done, proc.exited.then(() => undefined)]);
      clearTimeout(timeout);

      if (streamErr) throw new Error(streamErr);
      if (!agentEnd) {
        try {
          proc.kill();
        } catch {
          // already gone
        }
        await Promise.race([stderrDone, Bun.sleep(100)]);
        const suffix = stderrTail ? `; stderr: ${stderrTail.trim()}` : "";
        throw new Error(
          `pi agent "${invocation.key}" ended before agent_end (process exit)${suffix}`,
        );
      }

      const messages = (agentEnd as { messages: PiMessage[] }).messages;
      const finalError = lastAssistantError(messages);
      if (finalError)
        throw new Error(`pi agent "${invocation.key}" ended with error: ${finalError}`);
      const text = lastAssistantText(messages);
      if (!text) throw new Error(`pi agent "${invocation.key}" ended without assistant text`);
      proc.stdin.end();
      proc.kill();
      await stderrDone;
      return { text, transcript, ...(sessionToken ? { sessionToken } : {}) };
    } finally {
      clearTimeout(timeout);
      invocation.abortSignal?.removeEventListener("abort", onAbort);
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
  }

  private async race(
    req: Promise<PiResponse>,
    done: Promise<void>,
    proc: { exited: Promise<number> },
  ): Promise<PiResponse | null> {
    return Promise.race([req, done.then(() => null), proc.exited.then(() => null)]);
  }

  private rawLog(key: string, stream: "spawn" | "stdout" | "stderr", data: unknown): void {
    if (!this.rawLogPath) return;
    try {
      mkdirSync(dirname(this.rawLogPath), { recursive: true });
      appendFileSync(
        this.rawLogPath,
        `${JSON.stringify({ at: new Date().toISOString(), key, stream, data })}\n`,
      );
    } catch {
      // Diagnostic logging must never change provider behavior.
    }
  }
}

interface PiResponse {
  id: number;
  type: "response";
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}
type PiOut = (PiResponse | { type: string; [k: string]: unknown }) & { type: string; id?: number };

/** Concat assistant text parts of the last assistant message; skip thinking. */
function lastAssistantText(messages: PiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    if (m.stopReason === "aborted" && m.content.length === 0) continue;
    let text = "";
    for (const c of m.content) if (c.type === "text" && c.text) text += c.text;
    return text.trim();
  }
  return "";
}

function lastAssistantError(messages: PiMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    if (m.stopReason !== "error") return null;
    return m.errorMessage || "unknown provider error";
  }
  return null;
}

function tail(text: string, max = 4000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

/** Map a pi event onto Keel's TraceEvent vocabulary for transcript capture. */
function mapEvent(msg: PiOut, transcript: TraceEvent[], hooks: AgentHooks): void {
  let ev: TraceEvent | null = null;
  switch (msg.type) {
    case "message_update": {
      const inner = (msg as { assistantMessageEvent?: { type?: string; delta?: string } })
        .assistantMessageEvent;
      if (inner?.type === "text_delta") ev = { type: "text", data: inner.delta };
      else if (inner?.type === "thinking_delta") ev = { type: "reasoning", data: inner.delta };
      break;
    }
    case "tool_execution_start":
      ev = { type: "tool_call", data: msg };
      break;
    case "tool_execution_end":
      ev = { type: "tool_result", data: msg };
      break;
    case "auto_retry_start":
      ev = { type: "wait", data: msg };
      break;
    case "agent_end":
      if ((msg as { willRetry?: unknown }).willRetry === true) {
        const messages =
          ((msg as { messages?: unknown }).messages as PiMessage[] | undefined) ?? [];
        const error = lastAssistantError(messages);
        ev = { type: "error", data: { retrying: true, ...(error ? { message: error } : {}) } };
      }
      break;
    default:
      break;
  }
  if (ev) {
    transcript.push(ev);
    hooks.onEvent?.(ev);
  }
}
