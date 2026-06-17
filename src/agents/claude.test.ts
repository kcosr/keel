import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore } from "../journal/store.ts";
import { RealmKernel } from "../kernel/realm/realm-host.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { ClaudeProvider } from "./claude.ts";
import type { AgentHooks, AgentInvocation, AgentProvider, AgentResult } from "./types.ts";
import { AgentProviderRegistry } from "./types.ts";

const RESUME_ID = "11111111-1111-4111-8111-111111111111";
const onceUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/agent-once-claude.workflow.ts", import.meta.url).pathname,
);

class FakeClaudeVendor implements AgentProvider {
  readonly name = "claude";
  readonly calls: AgentInvocation[] = [];
  constructor(private readonly tokenFor: (n: number) => string | undefined = () => "sess") {}

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    const n = this.calls.length;
    this.calls.push({ ...invocation });
    const token = this.tokenFor(n);
    if (token) hooks.onSessionToken?.(token);
    return { text: '{"value":1}', transcript: [], ...(token ? { sessionToken: token } : {}) };
  }
}

function kernel(store: JournalStore, vendor: AgentProvider, extra: Record<string, unknown> = {}) {
  return new RealmKernel(store, {
    idgen: () => "r",
    clock: () => 1,
    rng: () => 0.5,
    agents: new AgentProviderRegistry().register(vendor),
    ...extra,
  });
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met in time");
}

describe("Claude session-resume four-branch table (through the realm)", () => {
  test("branch 1: a completed agent replays — no provider call on resume", async () => {
    const store = JournalStore.memory();
    const vendor = new FakeClaudeVendor();
    const r1 = await kernel(store, vendor).run<{ value: number }>(onceUrl, null, {
      name: "t",
      target: process.cwd(),
    });
    expect(r1.output).toEqual({ value: 1 });
    expect(vendor.calls).toHaveLength(1);

    const r2 = await kernel(store, vendor).rerun<{ value: number }>("r", onceUrl);
    expect(r2.output).toEqual({ value: 1 });
    expect(vendor.calls).toHaveLength(1);
  });

  test("branch 2: pending + token → re-execute with resumeToken set", async () => {
    const store = JournalStore.memory();
    const vendor = new FakeClaudeVendor(() => "sess-abc");
    const k1 = kernel(store, vendor, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "ask") throw new Error("CRASH after token");
      },
    });
    await k1.run(onceUrl, null, { name: "t", target: process.cwd() }).catch(() => null);
    expect(store.getJournalRow("r", "ask", 1)?.status).toBe("pending");
    expect(store.getJournalRow("r", "ask", 1)?.sessionToken).toBe("sess-abc");

    const resumed = await kernel(store, vendor).resume<{ value: number }>("r");
    expect(resumed.output).toEqual({ value: 1 });
    expect(vendor.calls).toHaveLength(2);
    expect(vendor.calls[1]?.resumeToken).toBe("sess-abc");
  });

  test("branch 3: pending + NO token → re-execute fresh (no resumeToken)", async () => {
    const store = JournalStore.memory();
    const vendor = new FakeClaudeVendor((n) => (n === 0 ? undefined : "sess-late"));
    const k1 = kernel(store, vendor, {
      fault: (point: string, key: string) => {
        if (point === "after-pending" && key === "ask") throw new Error("CRASH before token");
      },
    });
    await k1.run(onceUrl, null, { name: "t", target: process.cwd() }).catch(() => null);
    expect(store.getJournalRow("r", "ask", 1)?.sessionToken).toBeNull();

    await kernel(store, vendor).resume("r");
    expect(vendor.calls.at(-1)?.resumeToken).toBeUndefined();
  });

  test("branch 4: a stale carried token is still forwarded (provider decides)", async () => {
    const store = JournalStore.memory();
    const vendor = new FakeClaudeVendor(() => "sess-stale");
    const k1 = kernel(store, vendor, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "ask") throw new Error("CRASH");
      },
    });
    await k1.run(onceUrl, null, { name: "t", target: process.cwd() }).catch(() => null);
    await kernel(store, vendor).resume("r");
    expect(vendor.calls.at(-1)?.resumeToken).toBe("sess-stale");
  });
});

describe("ClaudeProvider", () => {
  test("abortSignal kills an active Claude subprocess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-claude-abort-"));
    try {
      const bin = join(dir, "fake-claude");
      const spawned = join(dir, "spawned");
      const aborted = join(dir, "aborted");
      await Bun.write(
        bin,
        `#!/bin/sh
printf 1 > ${spawned}
trap 'printf 1 > ${aborted}; exit 0' TERM
while true; do sleep 0.1; done
`,
      );
      chmodSync(bin, 0o755);
      const provider = new ClaudeProvider({ bin, timeoutMs: 10_000 });
      const controller = new AbortController();
      const running = provider.generate(
        {
          key: "claude-abort",
          provider: "claude",
          prompt: "hello",
          cwd: dir,
          toolPolicy: "none",
          abortSignal: controller.signal,
        },
        {},
      );
      await until(() => existsSync(spawned));
      controller.abort();
      await expect(running).rejects.toThrow(/aborted/);
      await until(() => existsSync(aborted));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses KEEL_CLAUDE_BIN when bin is not passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-claude-env-bin-"));
    const previous = process.env.KEEL_CLAUDE_BIN;
    try {
      const bin = join(dir, "fake-claude");
      const argsPath = join(dir, "args.json");
      await writeFakeClaude(bin, argsPath);
      process.env.KEEL_CLAUDE_BIN = bin;

      const provider = new ClaudeProvider({ timeoutMs: 5_000 });
      const result = await provider.generate(
        { key: "claude-env", provider: "claude", prompt: "env", cwd: dir, toolPolicy: "none" },
        {},
      );

      expect(result.text).toBe("final answer");
      expect(JSON.parse(readFileSync(argsPath, "utf8"))).toContain("env");
    } finally {
      process.env.KEEL_CLAUDE_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawns claude in stream-json mode and maps events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-claude-provider-"));
    try {
      const bin = join(dir, "fake-claude");
      const argsPath = join(dir, "args.json");
      await writeFakeClaude(bin, argsPath);

      const events: unknown[] = [];
      const tokens: string[] = [];
      const provider = new ClaudeProvider({ bin, timeoutMs: 5_000 });
      const result = await provider.generate(
        {
          key: "claude",
          provider: "claude",
          prompt: "hello",
          cwd: dir,
          model: "sonnet",
          reasoning: "high",
          toolPolicy: "read-only",
          allowTools: ["Bash"],
          denyTools: ["Glob"],
        },
        {
          onEvent: (event) => events.push(event),
          onSessionToken: (token) => tokens.push(token),
        },
      );

      expect(result.text).toBe("final answer");
      expect(result.sessionToken).toBeTruthy();
      const sessionToken = result.sessionToken ?? "";
      expect(tokens).toEqual([sessionToken]);
      expect(events).toContainEqual({ type: "session", data: sessionToken });
      expect(events).toContainEqual({ type: "reasoning", data: "thinking" });
      expect(events).toContainEqual({ type: "text", data: "hello " });
      expect(events).toContainEqual({
        type: "tool_call",
        toolCallId: "toolu_1",
        data: { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
      });
      expect(events).toContainEqual({
        type: "tool_result",
        toolCallId: "toolu_1",
        data: { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
      });
      expect(events).toContainEqual({
        type: "wait",
        data: { type: "rate_limit_event", session_id: sessionToken },
      });

      const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
      expect(args).toContain("--session-id");
      expect(args).not.toContain("--resume");
      expect(args).toContain("--model");
      expect(args).toContain("sonnet");
      expect(args).toContain("--effort");
      expect(args).toContain("high");
      expect(args).toContain("--allowed-tools");
      expect(args).toContain("Read");
      expect(args).toContain("Grep");
      expect(args).toContain("LS");
      expect(args).toContain("Bash");
      expect(args).not.toContain("Glob");
      expect(args).not.toContain("--permission-mode");
      expect(args.at(-2)).toBe("--");
      expect(args.at(-1)).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resumes with the carried Claude session token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-claude-resume-"));
    try {
      const bin = join(dir, "fake-claude");
      const argsPath = join(dir, "args.json");
      await writeFakeClaude(bin, argsPath);

      const tokens: string[] = [];
      const provider = new ClaudeProvider({ bin, timeoutMs: 5_000 });
      const result = await provider.generate(
        {
          key: "claude-resume",
          provider: "claude",
          prompt: "resume",
          cwd: dir,
          resumeToken: RESUME_ID,
          toolPolicy: "none",
        },
        { onSessionToken: (token) => tokens.push(token) },
      );

      expect(result.sessionToken).toBe(RESUME_ID);
      expect(tokens).toEqual([RESUME_ID]);
      const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      expect(args).toContain("--resume");
      expect(args[args.indexOf("--resume") + 1]).toBe(RESUME_ID);
      expect(args).not.toContain("--session-id");
      expect(args).toContain("--allowed-tools");
      expect(args[args.indexOf("--allowed-tools") + 1]).toBe("");
      expect(args).not.toContain("--permission-mode");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails promptly when a streamed session token hook rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-claude-token-hook-"));
    try {
      const bin = join(dir, "fake-claude");
      const argsPath = join(dir, "args.json");
      await Bun.write(
        bin,
        `#!${process.execPath}
const args = process.argv.slice(2);
await Bun.write(${JSON.stringify(argsPath)}, JSON.stringify(args));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "rotated-session" }));
await Bun.sleep(1000);
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "rotated-session", result: "final answer" }));
`,
      );
      chmodSync(bin, 0o755);

      const provider = new ClaudeProvider({ bin, timeoutMs: 5_000 });
      const started = Date.now();
      await expect(
        provider.generate(
          {
            key: "claude-token-hook",
            provider: "claude",
            prompt: "resume",
            cwd: dir,
            resumeToken: RESUME_ID,
            toolPolicy: "none",
          },
          {
            onSessionToken: (token) => {
              if (token !== RESUME_ID) throw new Error(`mismatched token ${token}`);
            },
          },
        ),
      ).rejects.toThrow(/mismatched token rotated-session/);
      expect(Date.now() - started).toBeLessThan(800);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("propagates streamed event hook failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-claude-event-hook-"));
    try {
      const bin = join(dir, "fake-claude");
      const argsPath = join(dir, "args.json");
      await writeFakeClaude(bin, argsPath);

      const provider = new ClaudeProvider({ bin, timeoutMs: 5_000 });
      await expect(
        provider.generate(
          {
            key: "claude-event-hook",
            provider: "claude",
            prompt: "hook",
            cwd: dir,
            toolPolicy: "none",
          },
          {
            onEvent: (event) => {
              if (event.type === "tool_call") throw new Error("durable append failed");
            },
          },
        ),
      ).rejects.toThrow(/durable append failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses resolved invocation capabilities instead of the derived policy label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-claude-resolved-caps-"));
    try {
      const bin = join(dir, "fake-claude");
      const argsPath = join(dir, "args.json");
      await writeFakeClaude(bin, argsPath);

      const provider = new ClaudeProvider({ bin, timeoutMs: 5_000 });
      await provider.generate(
        {
          key: "claude-resolved-caps",
          provider: "claude",
          prompt: "caps",
          cwd: dir,
          toolPolicy: "workspace-write",
          capabilities: {
            fs: "read",
            network: ["api.example.com"],
            shell: false,
            secrets: [],
          },
        },
        {},
      );

      const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      expect(args).toContain("Read");
      expect(args).toContain("Grep");
      expect(args).toContain("Glob");
      expect(args).toContain("LS");
      expect(args).toContain("WebFetch");
      expect(args).toContain("WebSearch");
      expect(args).not.toContain("Edit");
      expect(args).not.toContain("Write");
      expect(args).not.toContain("Bash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("waits for Claude process cleanup after the terminal result event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-claude-cleanup-"));
    try {
      const bin = join(dir, "fake-claude");
      const argsPath = join(dir, "args.json");
      const cleanupPath = join(dir, "cleanup");
      await writeFakeClaude(bin, argsPath, cleanupPath);

      const provider = new ClaudeProvider({ bin, timeoutMs: 5_000 });
      const result = await provider.generate(
        {
          key: "claude-cleanup",
          provider: "claude",
          prompt: "cleanup",
          cwd: dir,
          toolPolicy: "none",
        },
        {},
      );

      expect(result.text).toBe("final answer");
      expect(readFileSync(cleanupPath, "utf8")).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not hang if a Claude descendant keeps stderr open after success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-claude-stderr-open-"));
    try {
      const bin = join(dir, "fake-claude");
      const argsPath = join(dir, "args.json");
      await Bun.write(
        bin,
        `#!${process.execPath}
const args = process.argv.slice(2);
await Bun.write(${JSON.stringify(argsPath)}, JSON.stringify(args));
Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 1000)"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
});
const sessionId = args[args.indexOf("--session-id") + 1] ?? "missing-session";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "final answer" }));
process.exit(0);
`,
      );
      chmodSync(bin, 0o755);

      const provider = new ClaudeProvider({ bin, timeoutMs: 5_000 });
      const started = Date.now();
      const result = await provider.generate(
        {
          key: "claude-stderr-open",
          provider: "claude",
          prompt: "stderr-open",
          cwd: dir,
          toolPolicy: "none",
        },
        {},
      );

      expect(result.text).toBe("final answer");
      expect(Date.now() - started).toBeLessThan(800);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function writeFakeClaude(bin: string, argsPath: string, cleanupPath?: string): Promise<void> {
  await Bun.write(
    bin,
    `#!${process.execPath}
const args = process.argv.slice(2);
await Bun.write(${JSON.stringify(argsPath)}, JSON.stringify(args));
function argValue(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const sessionId = argValue("--resume") ?? argValue("--session-id") ?? "missing-session";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
console.log(JSON.stringify({
  type: "assistant",
  session_id: sessionId,
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "thinking" },
      { type: "text", text: "hello " },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } }
    ]
  }
}));
console.log(JSON.stringify({
  type: "user",
  session_id: sessionId,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] }
}));
console.log(JSON.stringify({ type: "rate_limit_event", session_id: sessionId }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "final answer" }));
${cleanupPath ? `await Bun.sleep(25);\nawait Bun.write(${JSON.stringify(cleanupPath)}, "done");` : ""}
`,
  );
  chmodSync(bin, 0o755);
}

// ---- LIVE smoke (configured real Claude backend). Gated: KEEL_LIVE=1 bun test ----

const LIVE = process.env.KEEL_LIVE === "1";
describe.if(LIVE)("LIVE claude smoke", () => {
  test("a real configured Claude agent produces structured output", async () => {
    const { executeAgent } = await import("./execute.ts");
    const provider = new ClaudeProvider({ timeoutMs: 120_000 });
    const tokens: string[] = [];
    const exec = await executeAgent(
      provider,
      {
        key: "live-claude-1",
        provider: "claude",
        prompt: 'Return ONLY this JSON and nothing else: {"value": 42}',
        cwd: process.cwd(),
        toolPolicy: "none",
      },
      { onSessionToken: (t) => tokens.push(t) },
      {
        jsonSchema: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "number" } },
        },
      },
    );

    expect(exec.output).toEqual({ value: 42 });
    expect(tokens.length).toBe(1);
    expect(exec.sessionToken).toBeTruthy();
  }, 130_000);

  test("a small real Claude run through the daemon completes and replays on resume", async () => {
    const { KeelDaemon } = await import("../daemon/server.ts");
    const { DaemonClient } = await import("../daemon/client.ts");
    const { AgentProviderRegistry } = await import("./types.ts");
    const liveUrl = captureWorkflowFile(
      new URL("../kernel/realm/fixtures/agent-live-claude.workflow.ts", import.meta.url).pathname,
    );
    const dir = mkdtempSync(join(tmpdir(), "keel-live-claude-daemon-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const inner = new ClaudeProvider({ timeoutMs: 120_000 });
    let calls = 0;
    const provider: AgentProvider = {
      name: "claude",
      generate(invocation, hooks) {
        calls++;
        return inner.generate(invocation, hooks);
      },
    };
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(provider),
    });
    await daemon.start();
    let client: InstanceType<typeof DaemonClient> | null = null;
    try {
      client = await DaemonClient.connect(socketPath);
      const { runId, capability } = await client.launchRun({
        ...liveUrl,
        input: null,
        name: "live-claude",
      });
      await client.authenticate(capability as string);
      const outcome = await client.waitForRun(runId);
      expect(outcome.status).toBe("finished");
      expect(outcome.output).toBe(12);
      expect(calls).toBe(2);

      await client.resumeRun(runId);
      const replay = await client.waitForRun(runId);
      expect(replay.status).toBe("finished");
      expect(replay.output).toBe(12);
      expect(calls).toBe(2);
    } finally {
      client?.close();
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 260_000);

  test("a real configured Claude retry resumes the previous backend session", async () => {
    const { executeAgent } = await import("./execute.ts");
    const nonce = `keel${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const inner = new ClaudeProvider({ timeoutMs: 120_000 });
    const calls: AgentInvocation[] = [];
    const provider: AgentProvider = {
      name: "claude",
      generate(invocation, hooks) {
        calls.push({ ...invocation });
        if (calls.length === 1) {
          return inner.generate(
            {
              ...invocation,
              prompt: `Remember this code word for later in this conversation: ${nonce}. Then reply exactly: {"wrong":true}`,
              toolPolicy: "none",
            },
            hooks,
          );
        }
        expect(invocation.resumeToken).toBeTruthy();
        return inner.generate(
          {
            ...invocation,
            prompt:
              'What exact code word did I ask you to remember earlier in this conversation? Return ONLY one JSON object with exactly one string field named "code".',
            toolPolicy: "none",
          },
          hooks,
        );
      },
    };

    const exec = await executeAgent(
      provider,
      {
        key: "live-claude-retry-resume",
        provider: "claude",
        prompt: "retry-resume",
        cwd: process.cwd(),
        toolPolicy: "none",
      },
      {},
      {
        maxRetries: 1,
        jsonSchema: {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: { code: { type: "string" } },
        },
      },
    );

    expect(exec.output).toEqual({ code: nonce });
    expect(exec.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.resumeToken).toBeUndefined();
    expect(calls[1]?.resumeToken).toBeTruthy();
  }, 180_000);
});
