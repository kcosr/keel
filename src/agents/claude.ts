// Claude agent provider — drives `claude -p --output-format stream-json`.
//
// Keel treats Claude like any other streaming provider and records the Claude
// session id before model work starts for crash reconnects.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveInvocationToolPolicy, resolvedToolPolicyToClaudeArgs } from "./capabilities.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./defaults.ts";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
  TraceEvent,
} from "./types.ts";

const CLAUDE_EXIT_GRACE_MS = 5_000;
const STDERR_DRAIN_GRACE_MS = 100;

export interface ClaudeProviderOptions {
  /** Working directory; defaults to process.cwd(). */
  cwd?: string;
  /** Claude binary name/path (default KEEL_CLAUDE_BIN, then "claude"). */
  bin?: string;
  /** Per-call timeout in ms before abort (default 1 hour). */
  timeoutMs?: number;
  /** Extra env passed to the Claude process. */
  env?: Record<string, string>;
  /** Secret-bearing raw JSONL diagnostic log path. Defaults to KEEL_CLAUDE_RAW_LOG. */
  rawLogPath?: string;
}

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";
  private readonly cwd: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly extraEnv: Record<string, string>;
  private readonly rawLogPath?: string;

  constructor(opts: ClaudeProviderOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.bin = opts.bin ?? process.env.KEEL_CLAUDE_BIN ?? "claude";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.extraEnv = opts.env ?? {};
    this.rawLogPath = opts.rawLogPath ?? process.env.KEEL_CLAUDE_RAW_LOG;
  }

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    const requestedSessionToken = invocation.resumeToken ?? randomUUID();
    let sessionToken: string | undefined;
    const noteSessionToken = (token: string): void => {
      if (sessionToken === token) return;
      sessionToken = token;
      hooks.onEvent?.({ type: "session", data: token });
      hooks.onSessionToken?.(token);
    };

    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (invocation.resumeToken) {
      args.push("--resume", invocation.resumeToken);
    } else {
      args.push("--session-id", requestedSessionToken);
    }
    if (invocation.model) args.push("--model", invocation.model);
    if (invocation.reasoning) args.push("--effort", invocation.reasoning);
    args.push(
      ...resolvedToolPolicyToClaudeArgs(
        resolveInvocationToolPolicy({
          ...(invocation.capabilities ? { capabilities: invocation.capabilities } : {}),
          ...(invocation.toolPolicy ? { toolPolicy: invocation.toolPolicy } : {}),
          ...(invocation.allowTools ? { allowTools: invocation.allowTools } : {}),
          ...(invocation.denyTools ? { denyTools: invocation.denyTools } : {}),
        }),
      ),
    );
    args.push("--", invocation.prompt);

    noteSessionToken(requestedSessionToken);

    const cwd = invocation.cwd ?? this.cwd;
    this.rawLog(invocation.key, "spawn", { bin: this.bin, args, cwd });
    const proc = Bun.spawn([this.bin, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...this.extraEnv,
        ...(invocation.env ?? {}),
      },
    });

    const transcript: TraceEvent[] = [];
    let streamErr: string | null = null;
    let terminal: ClaudeResultEvent | null = null;
    let lastAssistantText = "";
    let stderrTail = "";

    const handleLine = (line: string): void => {
      let event: ClaudeStreamEvent;
      try {
        event = JSON.parse(line) as ClaudeStreamEvent;
      } catch (err) {
        streamErr = `claude agent "${invocation.key}" emitted invalid JSON: ${String(err)}`;
        proc.kill();
        return;
      }

      const observedSession = stringValue(event.session_id);
      if (observedSession) noteSessionToken(observedSession);

      if (event.type === "result") {
        terminal = event as ClaudeResultEvent;
        if (terminal.is_error || terminal.subtype === "error") {
          const message =
            stringValue(terminal.result) ??
            stringValue((terminal as Record<string, unknown>).error) ??
            "unknown provider error";
          streamErr = `claude agent "${invocation.key}" ended with error: ${message}`;
        }
        return;
      }

      const mapped = mapClaudeEvent(event);
      if (mapped.length > 0) {
        for (const ev of mapped) {
          transcript.push(ev);
          hooks.onEvent?.(ev);
          if (ev.type === "text" && typeof ev.data === "string") {
            lastAssistantText += ev.data;
          }
        }
      }
    };

    const done = new Promise<void>((resolve) => {
      void (async () => {
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of proc.stdout) {
          const text = dec.decode(chunk as Uint8Array);
          this.rawLog(invocation.key, "stdout", text);
          buf += text;
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) handleLine(line);
            if (terminal || streamErr) {
              resolve();
              return;
            }
            nl = buf.indexOf("\n");
          }
        }
        const tailLine = buf.trim();
        if (tailLine && !terminal && !streamErr) handleLine(tailLine);
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

    let processExited = false;
    const exitPromise = proc.exited.then((code) => {
      processExited = true;
      return code;
    });

    const timeout = setTimeout(() => {
      streamErr = `claude agent "${invocation.key}" timed out after ${this.timeoutMs}ms`;
      proc.kill();
    }, this.timeoutMs);
    const onAbort = (): void => {
      streamErr = `claude agent "${invocation.key}" aborted (stall)`;
      proc.kill();
    };
    invocation.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      await Promise.race([done, exitPromise.then(() => undefined)]);
      clearTimeout(timeout);
      const exitCode = await Promise.race([exitPromise, Bun.sleep(50).then(() => null)]);

      if (streamErr) throw new Error(streamErr);
      const resultEvent = terminal as ClaudeResultEvent | null;
      if (!resultEvent) {
        await Promise.race([stderrDone, Bun.sleep(100)]);
        const suffix = stderrTail ? `; stderr: ${stderrTail.trim()}` : "";
        const code = exitCode === null ? "" : ` (exit ${exitCode})`;
        throw new Error(`claude agent "${invocation.key}" ended before result${code}${suffix}`);
      }

      const text = stringValue(resultEvent.result) ?? lastAssistantText.trim();
      if (!text) throw new Error(`claude agent "${invocation.key}" ended without assistant text`);
      const cleanExit = await Promise.race([
        exitPromise,
        Bun.sleep(CLAUDE_EXIT_GRACE_MS).then(() => null),
      ]);
      if (cleanExit === null) {
        proc.kill();
        await Promise.race([exitPromise, Bun.sleep(100)]);
      }
      await Promise.race([stderrDone, Bun.sleep(STDERR_DRAIN_GRACE_MS)]);
      return { text, transcript, ...(sessionToken ? { sessionToken } : {}) };
    } finally {
      clearTimeout(timeout);
      invocation.abortSignal?.removeEventListener("abort", onAbort);
      if (!processExited) {
        try {
          proc.kill();
        } catch {
          // already gone
        }
      }
    }
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

type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  session_id?: unknown;
  message?: unknown;
  result?: unknown;
  is_error?: unknown;
  [key: string]: unknown;
};

type ClaudeResultEvent = ClaudeStreamEvent & {
  type: "result";
  result?: unknown;
  is_error?: unknown;
};

function mapClaudeEvent(event: ClaudeStreamEvent): TraceEvent[] {
  switch (event.type) {
    case "assistant":
      return mapAssistantMessage(event.message);
    case "user":
      return mapUserMessage(event.message);
    case "rate_limit_event":
      return [{ type: "wait", data: event }];
    default:
      return [];
  }
}

function mapAssistantMessage(message: unknown): TraceEvent[] {
  const content = contentBlocks(message);
  const events: TraceEvent[] = [];
  for (const block of content) {
    const type = stringValue(block.type);
    if (type === "text") {
      const text = stringValue(block.text);
      if (text) events.push({ type: "text", data: text });
    } else if (type === "thinking") {
      const thinking = stringValue(block.thinking) ?? stringValue(block.text);
      if (thinking) events.push({ type: "reasoning", data: thinking });
    } else if (type === "tool_use") {
      events.push({ type: "tool_call", data: block });
    }
  }
  return events;
}

function mapUserMessage(message: unknown): TraceEvent[] {
  const content = contentBlocks(message);
  const events: TraceEvent[] = [];
  for (const block of content) {
    if (stringValue(block.type) === "tool_result") {
      events.push({ type: "tool_result", data: block });
    }
  }
  return events;
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tail(text: string, max = 4000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}
