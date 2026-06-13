// Phase 10: the four-branch session-resume table, exercised through the realm
// with a fake vendor (deterministic), plus a LIVE pi smoke gated by KEEL_LIVE=1.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore } from "../journal/store.ts";
import { RealmKernel } from "../kernel/realm/realm-host.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { PiProvider } from "./pi.ts";
import type { AgentHooks, AgentInvocation, AgentProvider, AgentResult } from "./types.ts";
import { AgentProviderRegistry } from "./types.ts";

const onceUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/agent-once.workflow.ts", import.meta.url).pathname,
);

/** A fake vendor that records every invocation and emits a Pi-like session token. */
class FakeVendor implements AgentProvider {
  readonly name = "pi";
  readonly calls: AgentInvocation[] = [];
  constructor(private readonly tokenFor: (n: number) => string | undefined = () => "sess") {}

  async generate(inv: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    const n = this.calls.length;
    this.calls.push({ ...inv });
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

describe("session-resume four-branch table (through the realm)", () => {
  test("branch 1: a completed agent replays — no provider call on resume", async () => {
    const store = JournalStore.memory();
    const vendor = new FakeVendor();
    const r1 = await kernel(store, vendor).run<{ value: number }>(onceUrl, null, { name: "t" });
    expect(r1.output).toEqual({ value: 1 });
    expect(vendor.calls).toHaveLength(1);

    const r2 = await kernel(store, vendor).rerun<{ value: number }>("r", onceUrl);
    expect(r2.output).toEqual({ value: 1 });
    expect(vendor.calls).toHaveLength(1); // replayed — not called again
  });

  test("branch 2: pending + token → re-execute with resumeToken set", async () => {
    const store = JournalStore.memory();
    const vendor = new FakeVendor(() => "sess-abc");
    // crash at before-commit (after the token was captured)
    const k1 = kernel(store, vendor, {
      fault: (p: string, key: string) => {
        if (p === "before-commit" && key === "ask") throw new Error("CRASH after token");
      },
    });
    await k1.run(onceUrl, null, { name: "t" }).catch(() => null);
    expect(store.getJournalRow("r", "ask", 1)?.status).toBe("pending");
    expect(store.getJournalRow("r", "ask", 1)?.sessionToken).toBe("sess-abc");

    const resumed = await kernel(store, vendor).resume<{ value: number }>("r");
    expect(resumed.output).toEqual({ value: 1 });
    expect(vendor.calls).toHaveLength(2);
    expect(vendor.calls[1]?.resumeToken).toBe("sess-abc"); // reconnect
  });

  test("branch 3: pending + NO token → re-execute fresh (no resumeToken)", async () => {
    const store = JournalStore.memory();
    // crash BEFORE the token is captured (after-pending fault, before generate)
    const vendor = new FakeVendor((n) => (n === 0 ? undefined : "sess-late"));
    const k1 = kernel(store, vendor, {
      fault: (p: string, key: string) => {
        if (p === "after-pending" && key === "ask") throw new Error("CRASH before token");
      },
    });
    await k1.run(onceUrl, null, { name: "t" }).catch(() => null);
    expect(store.getJournalRow("r", "ask", 1)?.sessionToken).toBeNull();

    await kernel(store, vendor).resume("r");
    expect(vendor.calls.at(-1)?.resumeToken).toBeUndefined(); // fresh, no reconnect
  });

  test("branch 4: a stale carried token is still forwarded (provider decides)", async () => {
    const store = JournalStore.memory();
    const vendor = new FakeVendor(() => "sess-stale");
    const k1 = kernel(store, vendor, {
      fault: (p: string, key: string) => {
        if (p === "before-commit" && key === "ask") throw new Error("CRASH");
      },
    });
    await k1.run(onceUrl, null, { name: "t" }).catch(() => null);
    await kernel(store, vendor).resume("r");
    // the kernel forwards the carried token; Pi maps a missing --session to fresh
    expect(vendor.calls.at(-1)?.resumeToken).toBe("sess-stale");
  });
});

describe("PiProvider diagnostics", () => {
  test("uses KEEL_PI_BIN when bin is not passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-pi-env-bin-"));
    const previous = process.env.KEEL_PI_BIN;
    try {
      const bin = join(dir, "fake-pi");
      await Bun.write(
        bin,
        `#!${process.execPath}
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  let nl = buf.indexOf("\\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      const msg = JSON.parse(line);
      if (msg.type === "get_state") {
        console.log(JSON.stringify({ type: "response", id: msg.id, data: { sessionId: "sess-env" } }));
      }
      if (msg.type === "prompt") {
        console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "env-ok" }] }] }));
        process.exit(0);
      }
    }
    nl = buf.indexOf("\\n");
  }
}
`,
      );
      chmodSync(bin, 0o755);
      process.env.KEEL_PI_BIN = bin;

      const provider = new PiProvider();
      const result = await provider.generate(
        { key: "pi-env", provider: "pi", prompt: "hello", toolPolicy: "none" },
        {},
      );

      expect(result.text).toBe("env-ok");
    } finally {
      process.env.KEEL_PI_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("raw log captures spawn metadata plus stdout and stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-pi-raw-log-"));
    try {
      const bin = join(dir, "fake-pi");
      const log = join(dir, "pi.jsonl");
      await Bun.write(
        bin,
        `#!${process.execPath}
console.error("model lookup failed on stderr");
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  let nl = buf.indexOf("\\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      const msg = JSON.parse(line);
      if (msg.type === "get_state") {
        console.log(JSON.stringify({ type: "response", id: msg.id, data: { sessionId: "sess-raw" } }));
      }
      if (msg.type === "prompt") {
        console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }));
        process.exit(0);
      }
    }
    nl = buf.indexOf("\\n");
  }
}
`,
      );
      chmodSync(bin, 0o755);

      const provider = new PiProvider({ bin, rawLogPath: log });
      const result = await provider.generate(
        {
          key: "raw",
          provider: "pi",
          prompt: "hello",
          model: "missing-model",
          toolPolicy: "none",
        },
        {},
      );

      expect(result.text).toBe("ok");
      const rows = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { stream: string; data: unknown });
      expect(rows.some((row) => row.stream === "spawn")).toBe(true);
      expect(rows.some((row) => row.stream === "stdout")).toBe(true);
      expect(rows.some((row) => row.stream === "stderr")).toBe(true);
      expect(JSON.stringify(rows)).toContain("missing-model");
      expect(JSON.stringify(rows)).toContain("model lookup failed on stderr");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses resolved invocation capabilities instead of the derived policy label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-pi-resolved-caps-"));
    try {
      const bin = join(dir, "fake-pi");
      const argsPath = join(dir, "args.json");
      await Bun.write(
        bin,
        `#!${process.execPath}
await Bun.write(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  let nl = buf.indexOf("\\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      const msg = JSON.parse(line);
      if (msg.type === "get_state") {
        console.log(JSON.stringify({ type: "response", id: msg.id, data: { sessionId: "sess-caps" } }));
      }
      if (msg.type === "prompt") {
        console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }));
        process.exit(0);
      }
    }
    nl = buf.indexOf("\\n");
  }
}
`,
      );
      chmodSync(bin, 0o755);

      const provider = new PiProvider({ bin });
      await provider.generate(
        {
          key: "resolved-caps",
          provider: "pi",
          prompt: "hello",
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
      expect(args).toContain("--tools");
      expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,ls");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PiProvider retrying agent_end handling", () => {
  test("waits through retrying agent_end before returning final text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-pi-retry-"));
    try {
      const bin = join(dir, "fake-pi");
      await Bun.write(
        bin,
        `#!${process.execPath}
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  let nl = buf.indexOf("\\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      const msg = JSON.parse(line);
      if (msg.type === "get_state") {
        console.log(JSON.stringify({ type: "response", id: msg.id, data: { sessionId: "sess-retry" } }));
      }
      if (msg.type === "prompt") {
        console.log(JSON.stringify({
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." }],
          willRetry: true,
        }));
        console.log(JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "Connection error." }));
        console.log(JSON.stringify({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        }));
        process.exit(0);
      }
    }
    nl = buf.indexOf("\\n");
  }
}
`,
      );
      chmodSync(bin, 0o755);

      const events: unknown[] = [];
      const provider = new PiProvider({ bin });
      const result = await provider.generate(
        { key: "retry", provider: "pi", prompt: "hello", toolPolicy: "none" },
        { onEvent: (event) => events.push(event) },
      );

      expect(result.text).toBe("done");
      expect(events).toContainEqual({
        type: "error",
        data: { retrying: true, message: "Connection error." },
      });
      expect(events).toContainEqual({
        type: "wait",
        data: {
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1,
          errorMessage: "Connection error.",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws final agent_end provider errors instead of returning empty text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-pi-final-error-"));
    try {
      const bin = join(dir, "fake-pi");
      await Bun.write(
        bin,
        `#!${process.execPath}
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  let nl = buf.indexOf("\\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      const msg = JSON.parse(line);
      if (msg.type === "get_state") {
        console.log(JSON.stringify({ type: "response", id: msg.id, data: { sessionId: "sess-error" } }));
      }
      if (msg.type === "prompt") {
        console.log(JSON.stringify({
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Invalid model." }],
        }));
        process.exit(0);
      }
    }
    nl = buf.indexOf("\\n");
  }
}
`,
      );
      chmodSync(bin, 0o755);

      const provider = new PiProvider({ bin });
      await expect(
        provider.generate(
          { key: "final-error", provider: "pi", prompt: "hello", toolPolicy: "none" },
          {},
        ),
      ).rejects.toThrow('pi agent "final-error" ended with error: Invalid model.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- LIVE smoke (real pi → LLM). Gated: KEEL_LIVE=1 bun test -----------------

const LIVE = process.env.KEEL_LIVE === "1";
describe.if(LIVE)("LIVE pi smoke", () => {
  test("a real pi agent produces structured output", async () => {
    const { PiProvider } = await import("./pi.ts");
    const { executeAgent } = await import("./execute.ts");
    const provider = new PiProvider({ timeoutMs: 120_000 });
    const tokens: string[] = [];
    const exec = await executeAgent(
      provider,
      {
        key: "live-1",
        provider: "pi",
        prompt: 'Return ONLY this JSON and nothing else: {"value": 42}',
        toolPolicy: "read-only",
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
    expect(tokens.length).toBe(1); // session token captured before the answer
    expect(exec.sessionToken).toBeTruthy();
  }, 130_000);

  test("a small real run through the daemon completes durably and replays on resume", async () => {
    const { KeelDaemon } = await import("../daemon/server.ts");
    const { DaemonClient } = await import("../daemon/client.ts");
    const { PiProvider } = await import("./pi.ts");
    const liveUrl = captureWorkflowFile(
      new URL("../kernel/realm/fixtures/agent-live.workflow.ts", import.meta.url).pathname,
    );

    const dir = mkdtempSync(join(tmpdir(), "keel-live-pi-daemon-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const inner = new PiProvider({ timeoutMs: 120_000 });
    let calls = 0;
    const provider: AgentProvider = {
      name: "pi",
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
        name: "live-pi",
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
});
