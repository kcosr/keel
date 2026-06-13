// Phase 12: the out-of-process daemon + thin clients.
// - multi-client: launch from one connection, observe from a second, resume.
// - CAS ownership fence prevents two daemons double-driving a run.
// - kill -9 the daemon mid-run, restart, and the run recovers and finishes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../agents/mock.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { JournalStore } from "../journal/store.ts";
import { DaemonClient } from "./client.ts";
import { KeelDaemon } from "./server.ts";

const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = new URL("chain.workflow.ts", FIX).pathname;
const TEST_DAEMON = new URL("./test-daemon.ts", import.meta.url).pathname;
const onceUrl = new URL("./fixtures/once-pi.workflow.ts", import.meta.url).pathname;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-daemon-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("daemon multi-client over the socket", () => {
  test("launch from one client, observe + result from a second", async () => {
    const socketPath = join(dir, "k.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "k.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
    });
    await daemon.start();
    try {
      const a = await DaemonClient.connect(socketPath);
      const b = await DaemonClient.connect(socketPath);

      const { runId } = await a.launchRun({
        workflowUrl: chainUrl,
        input: { n: 3 },
        name: "chain",
      });
      const out = await b.waitForRun(runId); // a different connection awaits it
      expect(out.status).toBe("finished");
      expect(out.output).toBe(3);

      const projection = await b.getRun(runId);
      expect(projection?.stats).toEqual({ steps: 3, agents: 0, artifacts: 0 });
      expect((await a.listRuns()).length).toBe(1);
      a.close();
      b.close();
    } finally {
      daemon.stop();
    }
  });
});

describe("scoped-token auth", () => {
  test("a read token may read but not launch; a write token may do both", async () => {
    const socketPath = join(dir, "auth.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "auth.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      tokens: { reader: "read", writer: "write" },
    });
    await daemon.start();
    try {
      // unauthenticated → rejected
      const anon = await DaemonClient.connect(socketPath);
      await expect(anon.listRuns()).rejects.toThrow(/not authenticated/);
      anon.close();

      // a writer seeds a run
      const w = await DaemonClient.connect(socketPath);
      expect((await w.authenticate("writer")).scope).toBe("write");
      const { runId } = await w.launchRun({
        workflowUrl: chainUrl,
        input: { n: 1 },
        name: "chain",
      });
      await w.waitForRun(runId);

      // a reader can read but not launch
      const r = await DaemonClient.connect(socketPath);
      expect((await r.authenticate("reader")).scope).toBe("read");
      expect((await r.getRun(runId))?.status).toBe("finished");
      await expect(
        r.launchRun({ workflowUrl: chainUrl, input: { n: 1 }, name: "chain" }),
      ).rejects.toThrow(/write-scoped/);

      // a bad token is rejected
      const bad = await DaemonClient.connect(socketPath);
      await expect(bad.authenticate("nope")).rejects.toThrow(/invalid token/);
      w.close();
      r.close();
      bad.close();
    } finally {
      daemon.stop();
    }
  });
});

describe("CAS ownership fence", () => {
  test("retrying a missing run reports not found instead of ownership fence", async () => {
    const socketPath = join(dir, "missing.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "missing.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      await expect(c.retryRun("missing")).rejects.toThrow(/run missing not found/);
      c.close();
    } finally {
      daemon.stop();
    }
  });

  test("a fresh owner blocks a second claimant; a stale one is reclaimable", () => {
    const store = JournalStore.open(join(dir, "cas.db"));
    try {
      store.insertRun({
        runId: "r",
        workflowName: "w",
        definitionVersion: "v0",
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 0,
      });
      // daemon A claims with a fresh heartbeat
      expect(store.claimRun("r", "A", 100, 1000)).toBe(true);
      // daemon B cannot claim (A is fresh: heartbeat 1000 >= stale-before 900)
      expect(store.claimRun("r", "B", 900, 2000)).toBe(false);
      expect(store.getRun("r")?.runtimeOwnerId).toBe("A");
      // later, A is stale (heartbeat 1000 < stale-before 5000) → B reclaims
      expect(store.claimRun("r", "B", 5000, 6000)).toBe(true);
      expect(store.getRun("r")?.runtimeOwnerId).toBe("B");
    } finally {
      store.close();
    }
  });

  test("a second daemon's resumeRun is rejected while the owner is live", async () => {
    const dbPath = join(dir, "fence.db");
    const onceUrl2 = onceUrl;
    // daemon A owns a (paused) run with a fresh heartbeat
    const a = new KeelDaemon({
      socketPath: join(dir, "a.sock"),
      dbPath,
      ownerId: "A",
      agents: new AgentProviderRegistry().register(new MockProvider()),
      heartbeatMs: 10_000,
    });
    await a.start();
    const ca = await DaemonClient.connect(join(dir, "a.sock"));
    const { runId } = await ca.launchRun({ workflowUrl: onceUrl2, input: null, name: "once" });
    await ca.waitForRun(runId); // finishes; A owns it with a fresh heartbeat

    // mark it running again (simulate a non-terminal owned run) for the fence test
    const probe = JournalStore.open(dbPath);
    probe.updateRun(runId, { status: "running" });
    probe.close();

    // daemon B (different owner) pointed at the same DB cannot drive it
    const b = new KeelDaemon({
      socketPath: join(dir, "b.sock"),
      dbPath,
      ownerId: "B",
      agents: new AgentProviderRegistry().register(new MockProvider()),
      heartbeatMs: 10_000,
    });
    await b.start();
    const cb = await DaemonClient.connect(join(dir, "b.sock"));
    await expect(cb.resumeRun(runId)).rejects.toThrow(/ownership fence/);

    ca.close();
    cb.close();
    a.stop();
    b.stop();
  });
});

describe("daemon supervisor tick over the socket", () => {
  test("a run parked on ctx.sleep is woken by the daemon's supervisor and finishes", async () => {
    const socketPath = join(dir, "sup.sock");
    const napUrl = new URL("../kernel/realm/fixtures/nap.workflow.ts", import.meta.url).pathname;
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "sup.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 150, // tick fast so the test stays short
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId } = await c.launchRun({ workflowUrl: napUrl, input: null, name: "nap" });
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-timer");
      // the nap sleeps 1000ms real-time; the supervisor wakes it once due
      await until(async () => (await c.getRun(runId))?.status === "finished", 4000);
      expect((await c.getRun(runId))?.status).toBe("finished");
      c.close();
    } finally {
      daemon.stop();
    }
  }, 10000);
});

describe("HITL over the socket", () => {
  test("a run parks on ctx.human and a decideApproval over the socket finishes it", async () => {
    const socketPath = join(dir, "h.sock");
    const gateUrl = new URL("../kernel/realm/fixtures/gate.workflow.ts", import.meta.url).pathname;
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "h.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100_000, // don't auto-tick; drive the decision explicitly
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId } = await c.launchRun({ workflowUrl: gateUrl, input: null, name: "gate" });
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-human");
      expect((await c.getBlockage(runId)).reason).toBe("waiting_human");

      const out = await c.decideApproval(runId, "approve-deploy", { status: "approved" });
      expect(out.status).toBe("finished");
      expect((await c.getRun(runId))?.status).toBe("finished");
      c.close();
    } finally {
      daemon.stop();
    }
  });
});

describe("kill -9 daemon recovery", () => {
  test("a run in flight when the daemon dies is recovered on restart", async () => {
    const socketPath = join(dir, "r.sock");
    const dbPath = join(dir, "r.db");
    const env = {
      ...process.env,
      KEEL_SOCKET: socketPath,
      KEEL_DB: dbPath,
      KEEL_DELAY: "4000", // the agent sleeps 4s, so we can kill mid-flight
    };

    // 1) start daemon, launch a run, wait until the agent is pending, then SIGKILL.
    const d1 = Bun.spawn(["bun", TEST_DAEMON], { env, stdout: "pipe", stderr: "pipe" });
    await waitForLine(d1.stdout, "READY");
    const c1 = await DaemonClient.connect(socketPath);
    const { runId } = await c1.launchRun({ workflowUrl: onceUrl, input: null, name: "once" });
    // poll until the agent row is pending (mid-flight)
    await until(
      async () => (await c1.getRun(runId))?.nodes.some((n) => n.status === "pending"),
      4000,
    );
    c1.close();
    d1.kill("SIGKILL");
    await d1.exited;

    // the run is left non-terminal with a pending agent
    const mid = JournalStore.open(dbPath);
    expect(mid.getRun(runId)?.status).toBe("running");
    expect(mid.getJournalRow(runId, "ask", 1)?.status).toBe("pending");
    mid.close();

    // wait past the stale-owner window (3 * heartbeatMs = 600ms) so the dead
    // daemon's claim is reclaimable.
    await Bun.sleep(800);

    // 2) restart a fresh daemon with NO delay → recovery resumes to completion.
    const d2 = Bun.spawn(["bun", TEST_DAEMON], {
      env: { ...env, KEEL_DELAY: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(d2.stdout, "READY");
    const c2 = await DaemonClient.connect(socketPath);
    try {
      await until(async () => (await c2.getRun(runId))?.status === "finished", 8000);
      const final = await c2.getRun(runId);
      expect(final?.status).toBe("finished");
      expect(final?.nodes.find((n) => n.stableKey === "ask")?.status).toBe("completed");
    } finally {
      c2.close();
      d2.kill("SIGTERM");
      await d2.exited;
    }
  }, 30000);
});

async function waitForLine(stream: ReadableStream, prefix: string): Promise<void> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk as Uint8Array);
    if (buf.includes(prefix)) return;
  }
  throw new Error(`stream ended before "${prefix}"`);
}

async function until(cond: () => Promise<boolean | undefined>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met in time");
}
