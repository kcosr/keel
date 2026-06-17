import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../agents/mock.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { hashCapabilityToken } from "../auth/capabilities.ts";
import { JournalStore } from "../journal/store.ts";
import { type KeelWebServer, startWebServer } from "../web/server.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { DaemonClient } from "./client.ts";
import { KeelDaemon } from "./server.ts";

const CLI = new URL("../cli/keel.ts", import.meta.url).pathname;
const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = captureWorkflowFile(new URL("chain.workflow.ts", FIX).pathname);
const onceUrl = captureWorkflowFile(
  new URL("./fixtures/once-pi.workflow.ts", import.meta.url).pathname,
);
const gateUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/gate.workflow.ts", import.meta.url).pathname,
);
const ADMIN_TOKEN = "kc_admin_web_transport_test";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-web-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface SseFrame {
  event: string;
  data: unknown;
  raw: string;
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function jsonFetch(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

function parseSseFrames(text: string): SseFrame[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map(parseSseFrame);
}

function parseSseFrame(block: string): SseFrame {
  const event = block
    .split("\n")
    .find((line) => line.startsWith("event: "))
    ?.slice("event: ".length);
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  return {
    event: event ?? "message",
    data: data ? JSON.parse(data) : null,
    raw: block,
  };
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buf = "";
  readonly frames: SseFrame[] = [];

  constructor(response: Response) {
    if (!response.body) throw new Error("missing response body");
    this.reader = response.body.getReader();
  }

  async waitFor(
    predicate: (frame: SseFrame, frames: SseFrame[]) => boolean,
    opts: { timeoutMs?: number; cancel?: boolean } = {},
  ): Promise<SseFrame[]> {
    const deadline = Date.now() + (opts.timeoutMs ?? 3000);
    while (Date.now() < deadline) {
      const matched = this.drain(predicate);
      if (matched) {
        if (opts.cancel) await this.reader.cancel();
        return this.frames;
      }
      const remaining = Math.max(1, deadline - Date.now());
      const read = await Promise.race([
        this.reader.read(),
        Bun.sleep(remaining).then(() => {
          throw new Error("timed out waiting for SSE frame");
        }),
      ]);
      if (read.done) break;
      this.buf += this.decoder.decode(read.value, { stream: true });
    }
    throw new Error("SSE predicate was not satisfied");
  }

  private drain(predicate: (frame: SseFrame, frames: SseFrame[]) => boolean): boolean {
    let boundary = this.buf.indexOf("\n\n");
    while (boundary >= 0) {
      const block = this.buf.slice(0, boundary);
      this.buf = this.buf.slice(boundary + 2);
      if (block.startsWith(":")) {
        const frame = { event: "heartbeat", data: null, raw: block };
        this.frames.push(frame);
        if (predicate(frame, this.frames)) return true;
      } else if (block.trim()) {
        const frame = parseSseFrame(block);
        this.frames.push(frame);
        if (predicate(frame, this.frames)) return true;
      }
      boundary = this.buf.indexOf("\n\n");
    }
    return false;
  }
}

function startDaemon(opts: { providerDelayMs?: number } = {}): {
  daemon: KeelDaemon;
  socketPath: string;
  dbPath: string;
} {
  const socketPath = join(dir, `${crypto.randomUUID()}.sock`);
  const dbPath = join(dir, `${crypto.randomUUID()}.db`);
  const daemon = new KeelDaemon({
    socketPath,
    dbPath,
    agents: new AgentProviderRegistry().register(
      new MockProvider({
        default: { outputs: ['{"value":1}'], delayMs: opts.providerDelayMs ?? 0 },
      }),
    ),
    adminToken: ADMIN_TOKEN,
  });
  return { daemon, socketPath, dbPath };
}

async function startCliWeb(socketPath: string): Promise<{ url: string; stop(): Promise<void> }> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("KEEL_")),
  ) as Record<string, string>;
  const proc = Bun.spawn(
    [process.execPath, CLI, "web", "--api-only", "--socket", socketPath, "--port", "0"],
    {
      cwd: dir,
      env: baseEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const read = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, deadline - Date.now())).then(() => {
        throw new Error("timed out waiting for keel web");
      }),
    ]);
    if (read.done) break;
    stdout += decoder.decode(read.value, { stream: true });
    const match = /keel web listening on (http:\/\/[^\s]+)/.exec(stdout);
    if (match?.[1]) {
      return {
        url: match[1],
        async stop() {
          proc.kill();
          await proc.exited.catch(() => {});
        },
      };
    }
  }
  proc.kill();
  const stderr = await new Response(proc.stderr).text().catch(() => "");
  throw new Error(`keel web did not start; stdout=${stdout}; stderr=${stderr}`);
}

describe("web transport", () => {
  test("health does not expose daemon socket paths when the daemon is unreachable", async () => {
    const missingSocket = join(dir, "missing", "keel.sock");
    const web = startWebServer({ socketPath: missingSocket, port: 0, apiOnly: true });
    try {
      const health = await jsonFetch(`${web.url}/health`);
      expect(health.status).toBe(200);
      expect(health.body.daemon).toEqual({
        reachable: false,
        error: { message: "daemon unreachable" },
      });
      expect(JSON.stringify(health.body)).not.toContain(dir);
      expect(JSON.stringify(health.body)).not.toContain("keel.sock");
    } finally {
      web.stop(true);
    }
  });

  test("forwards RPC through the daemon gateway, fails launch closed, and serves projections", async () => {
    const { daemon, socketPath, dbPath } = startDaemon();
    await daemon.start();
    const web = startWebServer({ socketPath, port: 0, apiOnly: true });
    try {
      const health = await jsonFetch(`${web.url}/health`);
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({
        ok: true,
        daemon: { reachable: true, ok: true, ownerId: daemon.ownerId },
      });

      const launchBody = {
        method: "launchRun",
        params: { ...chainUrl, input: { n: 1 }, target: dir, name: "web-launch" },
      };
      const denied = await jsonFetch(`${web.url}/rpc`, {
        method: "POST",
        body: JSON.stringify(launchBody),
      });
      expect(denied.status).toBe(401);
      expect(denied.body.error).toMatchObject({
        code: "permission_denied",
        action: "admin",
        resource: { kind: "daemon" },
      });

      const launched = await jsonFetch(`${web.url}/rpc`, {
        method: "POST",
        headers: auth(ADMIN_TOKEN),
        body: JSON.stringify(launchBody),
      });
      expect(launched.status).toBe(200);
      expect(launched.body.result.capability).toStartWith("kc_run_");
      const runId = launched.body.result.runId as string;
      const runCap = launched.body.result.capability as string;
      const store = JournalStore.open(dbPath);
      try {
        store.appendEvent(runId, "phase", { title: "kc_run_projection_secret" }, Date.now());
      } finally {
        store.close();
      }

      const unknown = await jsonFetch(`${web.url}/rpc`, {
        method: "POST",
        headers: auth(ADMIN_TOKEN),
        body: JSON.stringify({ id: "caller-id", method: "missingOperation", params: {} }),
      });
      expect(unknown.status).toBe(400);
      expect(unknown.body.id).toBe("caller-id");
      expect(unknown.body.error.message).toBe("unknown method missingOperation");

      const invalidToken = await jsonFetch(`${web.url}/api/runs`, {
        headers: auth("kc_run_invalid_web_transport"),
      });
      expect(invalidToken.status).toBe(401);

      const insufficientToken = await jsonFetch(`${web.url}/api/runs`, {
        headers: auth(runCap),
      });
      expect(insufficientToken.status).toBe(403);

      const missingRun = await jsonFetch(`${web.url}/rpc`, {
        method: "POST",
        headers: auth(ADMIN_TOKEN),
        body: JSON.stringify({ method: "retryRun", params: { runId: "run_missing_web" } }),
      });
      expect(missingRun.status).toBe(404);

      const redactedRpcError = await jsonFetch(`${web.url}/rpc`, {
        method: "POST",
        body: JSON.stringify({ method: "getRun", params: { runId: "kc_run_rpc_secret" } }),
      });
      expect(redactedRpcError.status).toBe(401);
      expect(JSON.stringify(redactedRpcError.body)).toContain("«redacted-capability»");
      expect(JSON.stringify(redactedRpcError.body)).not.toContain("kc_run_rpc_secret");

      const runs = await jsonFetch(`${web.url}/api/runs`, { headers: auth(ADMIN_TOKEN) });
      expect(runs.status).toBe(200);
      expect(runs.body.runs[0]).toMatchObject({
        runId,
        run: { runId, workflowName: "web-launch", phase: "«redacted-capability»" },
        workspaceSummary: { count: 0 },
      });
      expect(JSON.stringify(runs.body)).not.toContain("kc_run_projection_secret");

      const detail = await jsonFetch(`${web.url}/api/runs/${runId}`, { headers: auth(runCap) });
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        run: { runId, phase: "«redacted-capability»" },
        rawEvents: { href: `/runs/${runId}/events` },
        eventCursor: { kind: "after-seq", runId },
      });
      expect(JSON.stringify(detail.body)).not.toContain("kc_run_projection_secret");
      expect(Array.isArray(detail.body.availableCommands)).toBe(true);

      const redactedProjectionError = await jsonFetch(
        `${web.url}/api/runs/kc_run_projection_error_secret`,
      );
      expect(redactedProjectionError.status).toBe(401);
      expect(JSON.stringify(redactedProjectionError.body)).toContain("«redacted-capability»");
      expect(JSON.stringify(redactedProjectionError.body)).not.toContain(
        "kc_run_projection_error_secret",
      );

      const workspaces = await jsonFetch(`${web.url}/api/workspaces`, {
        headers: auth(ADMIN_TOKEN),
      });
      expect(workspaces.status).toBe(200);
      expect(workspaces.body.workspaces).toEqual([]);

      const system = await jsonFetch(`${web.url}/api/system`, { headers: auth(ADMIN_TOKEN) });
      expect(system.status).toBe(200);
      expect(system.body.warnings[0]).toContain("daemon version");
    } finally {
      web.stop(true);
      daemon.stop();
    }
  });

  test("streams snapshot, durable backfill, caught-up adapter frame, closed frame, and reconnect cursors", async () => {
    const { daemon, socketPath } = startDaemon();
    await daemon.start();
    const web = startWebServer({ socketPath, port: 0, apiOnly: true });
    const client = await DaemonClient.connect(socketPath);
    try {
      const launched = await client.launchRun({ ...chainUrl, input: { n: 2 }, target: dir });
      await client.authenticate(launched.capability as string);
      await client.waitForRun(launched.runId);

      const response = await fetch(`${web.url}/runs/${launched.runId}/events?from=beginning`, {
        headers: auth(launched.capability as string),
      });
      expect(response.status).toBe(200);
      const frames = parseSseFrames(await response.text());
      const names = frames.map((frame) => frame.event);
      expect(names[0]).toBe("snapshot");
      expect(names.filter((name) => name === "caught-up")).toHaveLength(1);
      expect(names).toContain("closed");

      const eventTypes = frames
        .filter((frame) => frame.event === "event")
        .map((frame) => (frame.data as { type: string }).type);
      expect(eventTypes[0]).toBe("run.started");
      expect(eventTypes).toContain("run.finished");
      expect(names.indexOf("caught-up")).toBeGreaterThan(
        frames.findIndex(
          (frame) =>
            frame.event === "event" && (frame.data as { type: string }).type === "run.finished",
        ),
      );
      expect(names.indexOf("closed")).toBeGreaterThan(names.indexOf("caught-up"));

      const caughtUp = frames.find((frame) => frame.event === "caught-up")?.data as {
        cursor: { seq: number };
      };
      const reconnected = await fetch(
        `${web.url}/runs/${launched.runId}/events?afterSeq=${caughtUp.cursor.seq}`,
        { headers: auth(launched.capability as string) },
      );
      const reconnectFrames = parseSseFrames(await reconnected.text());
      expect(reconnectFrames.filter((frame) => frame.event === "event")).toEqual([]);
      expect(reconnectFrames.map((frame) => frame.event)).toEqual([
        "snapshot",
        "caught-up",
        "closed",
      ]);

      const badCursor = await fetch(`${web.url}/runs/${launched.runId}/events?afterSeq=abc`, {
        headers: auth(launched.capability as string),
      });
      expect(badCursor.status).toBe(400);

      const redactedPreflight = await jsonFetch(
        `${web.url}/runs/kc_run_event_preflight_secret/events?from=beginning`,
      );
      expect(redactedPreflight.status).toBe(401);
      expect(JSON.stringify(redactedPreflight.body)).toContain("«redacted-capability»");
      expect(JSON.stringify(redactedPreflight.body)).not.toContain("kc_run_event_preflight_secret");
    } finally {
      client.close();
      web.stop(true);
      daemon.stop();
    }
  });

  test("sends heartbeat frames, surfaces auth revocation, and cleans up on stream cancel", async () => {
    const { daemon, socketPath, dbPath } = startDaemon({ providerDelayMs: 1000 });
    await daemon.start();
    const web = startWebServer({ socketPath, port: 0, apiOnly: true, heartbeatMs: 20 });
    const client = await DaemonClient.connect(socketPath);
    const launchedRunIds: string[] = [];
    try {
      const launched = await client.launchRun({ ...onceUrl, input: null, target: dir });
      launchedRunIds.push(launched.runId);
      const response = await fetch(`${web.url}/runs/${launched.runId}/events?from=beginning`, {
        headers: auth(launched.capability as string),
      });
      expect(response.status).toBe(200);
      const setupReader = new SseReader(response);
      const setupFrames = await setupReader.waitFor(
        (_frame, frames) =>
          frames.some((frame) => frame.event === "heartbeat") &&
          frames.some((frame) => frame.event === "caught-up"),
        { cancel: true },
      );
      expect(setupFrames.at(0)?.event).toBe("snapshot");

      const revoked = await client.launchRun({ ...onceUrl, input: null, target: dir });
      launchedRunIds.push(revoked.runId);
      const revokedResponse = await fetch(
        `${web.url}/runs/${revoked.runId}/events?from=beginning`,
        {
          headers: auth(revoked.capability as string),
        },
      );
      expect(revokedResponse.status).toBe(200);
      const revokedReader = new SseReader(revokedResponse);
      const beforeRevoke = await revokedReader.waitFor((frame) => frame.event === "caught-up");
      expect(beforeRevoke.map((frame) => frame.event)).toContain("caught-up");
      const store = JournalStore.open(dbPath);
      try {
        const cap = store.getCapabilityByHash(hashCapabilityToken(revoked.capability as string));
        store.revokeCapability(cap?.id as string, Date.now());
      } finally {
        store.close();
      }
      const afterRevoke = await revokedReader.waitFor(
        (frame) => frame.event === "authorization.failed",
        { cancel: true },
      );
      expect(afterRevoke.at(-1)).toMatchObject({ event: "authorization.failed" });

      const liveClosed = await client.launchRun({ ...onceUrl, input: null, target: dir });
      launchedRunIds.push(liveClosed.runId);
      const liveClosedResponse = await fetch(
        `${web.url}/runs/${liveClosed.runId}/events?from=beginning`,
        { headers: auth(liveClosed.capability as string) },
      );
      const liveClosedReader = new SseReader(liveClosedResponse);
      const liveClosedFrames = await liveClosedReader.waitFor((frame) => frame.event === "closed", {
        cancel: true,
      });
      expect(liveClosedFrames.map((frame) => frame.event)).toContain("closed");
      expect(
        liveClosedFrames.some(
          (frame) =>
            frame.event === "event" && (frame.data as { type?: string }).type === "run.finished",
        ),
      ).toBe(true);
    } finally {
      await client.authenticate(ADMIN_TOKEN).catch(() => {});
      await Promise.allSettled(launchedRunIds.map((runId) => client.waitForRun(runId)));
      client.close();
      web.stop(true);
      daemon.stop();
    }
  });

  test("projects approvals and serves static assets with SPA fallback", async () => {
    const { daemon, socketPath } = startDaemon();
    await daemon.start();
    const assetsDir = join(dir, "dist");
    mkdirSync(join(assetsDir, "assets"), { recursive: true });
    writeFileSync(join(assetsDir, "index.html"), "<main>Keel</main>\n");
    writeFileSync(join(assetsDir, "assets", "app.js"), "window.keel = true;\n");
    const web: KeelWebServer = startWebServer({ socketPath, port: 0, assetsDir });
    const client = await DaemonClient.connect(socketPath);
    try {
      const launched = await client.launchRun({ ...gateUrl, input: null, target: dir });
      await client.authenticate(launched.capability as string);
      await client.waitForRun(launched.runId);

      const approvals = await jsonFetch(`${web.url}/api/approvals`, {
        headers: auth(ADMIN_TOKEN),
      });
      expect(approvals.status).toBe(200);
      expect(approvals.body.approvals[0]).toMatchObject({
        runId: launched.runId,
        gateId: "approve-deploy",
        requiredAuthority: "admin",
      });

      const asset = await fetch(`${web.url}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("window.keel");
      const fallback = await fetch(`${web.url}/runs/${launched.runId}`);
      expect(fallback.status).toBe(200);
      expect(await fallback.text()).toContain("Keel");
      const spa = await fetch(`${web.url}/dashboard`);
      expect(spa.status).toBe(200);
      expect(await spa.text()).toContain("Keel");
    } finally {
      client.close();
      web.stop(true);
      daemon.stop();
    }
  });

  test("keel web --api-only serves health, projections, events, and fail-closed auth", async () => {
    const { daemon, socketPath } = startDaemon();
    await daemon.start();
    const client = await DaemonClient.connect(socketPath);
    const web = await startCliWeb(socketPath);
    try {
      const launched = await client.launchRun({ ...chainUrl, input: { n: 1 }, target: dir });
      await client.authenticate(launched.capability as string);
      await client.waitForRun(launched.runId);

      const health = await jsonFetch(`${web.url}/health`);
      expect(health.status).toBe(200);
      expect(health.body.daemon).toMatchObject({ reachable: true, ownerId: daemon.ownerId });

      const unauthorized = await jsonFetch(`${web.url}/api/runs`);
      expect(unauthorized.status).toBe(401);

      const runs = await jsonFetch(`${web.url}/api/runs`, { headers: auth(ADMIN_TOKEN) });
      expect(runs.status).toBe(200);
      expect(runs.body.runs.some((run: { runId: string }) => run.runId === launched.runId)).toBe(
        true,
      );

      const detail = await jsonFetch(`${web.url}/api/runs/${launched.runId}`, {
        headers: auth(launched.capability as string),
      });
      expect(detail.status).toBe(200);
      expect(detail.body.run.runId).toBe(launched.runId);

      const events = await fetch(`${web.url}/runs/${launched.runId}/events?tail=1`, {
        headers: auth(launched.capability as string),
      });
      expect(events.status).toBe(200);
      expect(parseSseFrames(await events.text()).map((frame) => frame.event)).toEqual([
        "snapshot",
        "event",
        "caught-up",
        "closed",
      ]);
    } finally {
      await web.stop();
      client.close();
      daemon.stop();
    }
  });
});
