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
import { hashCapabilityToken } from "../auth/capabilities.ts";
import { JournalStore } from "../journal/store.ts";
import { DaemonClient } from "./client.ts";
import { KeelDaemon } from "./server.ts";

const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = new URL("chain.workflow.ts", FIX).pathname;
const TEST_DAEMON = new URL("./test-daemon.ts", import.meta.url).pathname;
const onceUrl = new URL("./fixtures/once-pi.workflow.ts", import.meta.url).pathname;
const napUrl = new URL("../kernel/realm/fixtures/nap.workflow.ts", import.meta.url).pathname;
const ADMIN_TOKEN = "kc_admin_test";

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
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const a = await DaemonClient.connect(socketPath);
      const b = await DaemonClient.connect(socketPath);

      const { runId, capability } = await a.launchRun({
        workflowUrl: chainUrl,
        input: { n: 3 },
        name: "chain",
      });
      expect(capability?.startsWith("kc_run_")).toBe(true);
      await expect(b.waitForRun(runId)).rejects.toThrow(/no capability presented/);
      await b.authenticate(capability as string);
      const out = await b.waitForRun(runId); // a different connection awaits it
      expect(out.status).toBe("finished");
      expect(out.output).toBe(3);

      const projection = await b.getRun(runId);
      expect(projection?.stats).toEqual({ steps: 3, agents: 0, artifacts: 0 });
      await a.authenticate(ADMIN_TOKEN);
      expect((await a.listRuns()).length).toBe(1);
      a.close();
      b.close();
    } finally {
      daemon.stop();
    }
  });
});

describe("capability auth", () => {
  test("a run capability scopes access to one run; admin is required for daemon-wide list", async () => {
    const socketPath = join(dir, "auth.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "auth.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      // unauthenticated → rejected
      const anon = await DaemonClient.connect(socketPath);
      await expect(anon.listRuns()).rejects.toThrow(/no capability presented/);
      anon.close();

      const launcher = await DaemonClient.connect(socketPath);
      const first = await launcher.launchRun({
        workflowUrl: chainUrl,
        input: { n: 1 },
        name: "chain",
      });
      expect(first.capability?.startsWith("kc_run_")).toBe(true);
      await launcher.authenticate(first.capability as string);
      await launcher.waitForRun(first.runId);

      const second = await launcher.launchRun({
        workflowUrl: chainUrl,
        input: { n: 2 },
        name: "chain",
      });
      await launcher.authenticate(second.capability as string);
      await launcher.waitForRun(second.runId);

      const scoped = await DaemonClient.connect(socketPath);
      await scoped.authenticate(first.capability as string);
      expect((await scoped.getRun(first.runId))?.status).toBe("finished");
      await expect(scoped.getRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.getBlockage(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.waitForRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.resumeRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.retryRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.rewindRun(second.runId, "compute")).rejects.toThrow(/different resource/);
      await expect(scoped.forkRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.sendSignal(second.runId, "go", null)).rejects.toThrow(
        /different resource/,
      );
      await expect(scoped.listRuns()).rejects.toThrow(/admin/);

      const admin = await DaemonClient.connect(socketPath);
      await admin.authenticate(ADMIN_TOKEN);
      expect((await admin.listRuns()).map((r) => r.runId).sort()).toEqual(
        [first.runId, second.runId].sort(),
      );
      launcher.close();
      scoped.close();
      admin.close();
    } finally {
      daemon.stop();
    }
  });

  test("revocation interrupts long-lived waits and event streams", async () => {
    const socketPath = join(dir, "revoke.sock");
    const dbPath = join(dir, "revoke.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(
        new MockProvider({ default: { outputs: ['{"value":1}'], delayMs: 1000 } }),
      ),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const client = await DaemonClient.connect(socketPath);
      const { runId, capability } = await client.launchRun({
        workflowUrl: onceUrl,
        input: null,
        name: "once",
      });
      await client.authenticate(capability as string);

      const events: string[] = [];
      const unsubscribe = client.subscribeEvents(runId, 0, (event) => events.push(event.type));
      const waiting = client.waitForRun(runId);
      await Bun.sleep(150);

      const store = JournalStore.open(dbPath);
      const capRow = store.getCapabilityByHash(hashCapabilityToken(capability as string));
      store.revokeCapability(capRow?.id as string, Date.now());
      store.close();

      await expect(waiting).rejects.toThrow(/revoked/);
      await until(() => Promise.resolve(events.includes("authorization.failed")), 2000);
      unsubscribe();
      await client.authenticate(ADMIN_TOKEN);
      await client.waitForRun(runId);
      client.close();
    } finally {
      daemon.stop();
    }
  }, 8000);

  test("long-lived subscriptions keep their original credential after re-authentication", async () => {
    const socketPath = join(dir, "credential-race.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "credential-race.db"),
      agents: new AgentProviderRegistry().register(
        new MockProvider({ default: { outputs: ['{"value":1}'], delayMs: 350 } }),
      ),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const client = await DaemonClient.connect(socketPath);
      const first = await client.launchRun({ workflowUrl: onceUrl, input: null, name: "first" });
      await client.authenticate(first.capability as string);
      const firstEvents: string[] = [];
      const unsubscribe = client.subscribeEvents(first.runId, 0, (event) =>
        firstEvents.push(event.type),
      );
      await until(() => Promise.resolve(firstEvents.includes("run.started")), 2000);

      const second = await client.launchRun({
        workflowUrl: chainUrl,
        input: { n: 2 },
        name: "second",
      });
      await client.authenticate(second.capability as string);
      await client.waitForRun(second.runId);

      await until(() => Promise.resolve(firstEvents.includes("run.finished")), 3000);
      expect(firstEvents).not.toContain("authorization.failed");
      unsubscribe();
      await client.authenticate(first.capability as string);
      await client.waitForRun(first.runId);
      client.close();
    } finally {
      daemon.stop();
    }
  }, 8000);
});

describe("CAS ownership fence", () => {
  test("retrying a missing run reports not found instead of ownership fence", async () => {
    const socketPath = join(dir, "missing.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "missing.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      await c.authenticate(ADMIN_TOKEN);
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
    const { runId, capability } = await ca.launchRun({
      workflowUrl: onceUrl2,
      input: null,
      name: "once",
    });
    await ca.authenticate(capability as string);
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
    await cb.authenticate(capability as string);
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
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "sup.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 150, // tick fast so the test stays short
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        workflowUrl: napUrl,
        input: null,
        name: "nap",
      });
      await c.authenticate(capability as string);
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
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        workflowUrl: gateUrl,
        input: null,
        name: "gate",
      });
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-human");
      expect((await c.getBlockage(runId)).reason).toBe("waiting_human");

      await expect(
        c.decideApproval(runId, "approve-deploy", { status: "approved" }),
      ).rejects.toThrow(/admin/);
      await c.authenticate(ADMIN_TOKEN);
      const out = await c.decideApproval(runId, "approve-deploy", { status: "denied" });
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
    const d1 = Bun.spawn([process.execPath, TEST_DAEMON], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(d1.stdout, "READY");
    const c1 = await DaemonClient.connect(socketPath);
    const { runId, capability } = await c1.launchRun({
      workflowUrl: onceUrl,
      input: null,
      name: "once",
    });
    await c1.authenticate(capability as string);
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
    const d2 = Bun.spawn([process.execPath, TEST_DAEMON], {
      env: { ...env, KEEL_DELAY: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(d2.stdout, "READY");
    const c2 = await DaemonClient.connect(socketPath);
    await c2.authenticate(capability as string);
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
