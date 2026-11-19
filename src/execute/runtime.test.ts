import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { DaemonClient } from "../daemon/client.ts";
import type { EventEnvelope, EventStreamFrame } from "../rpc/contract.ts";
import { createExecuteKeel } from "./runtime.ts";

describe("execute runtime schedule reads", () => {
  test("listSchedules and getSchedule use the control credential", async () => {
    const calls: string[] = [];
    const client = {
      async authenticate(token: string) {
        calls.push(`authenticate:${token}`);
        return { ok: true };
      },
      async listSchedules(opts = {}) {
        calls.push(`listSchedules:${JSON.stringify(opts)}`);
        return [
          {
            name: "hourly",
            enabled: true,
            workflowRef: "wf_sha256_hourly",
            definitionState: "available",
            workflowName: "hourly",
            workflowKind: "source",
            target: "/repo",
            intervalMs: 60_000,
            nextFireMs: 100,
            lastRunId: null,
            lastRunStatus: null,
            lastFailedAtMs: null,
            lastError: { kind: "none" },
          },
        ];
      },
      async getSchedule(req: { name: string; includeSource?: boolean }) {
        calls.push(`getSchedule:${JSON.stringify(req)}`);
        return {
          name: req.name,
          enabled: false,
          workflowRef: "wf_sha256_missing",
          definitionState: "missing",
          workflowName: null,
          workflowKind: null,
          target: null,
          intervalMs: 60_000,
          nextFireMs: 100,
          lastRunId: null,
          lastRunStatus: null,
          lastFailedAtMs: null,
          lastError: { kind: "none" },
          input: null,
          inputJson: null,
          ...(req.includeSource ? { source: null } : {}),
        };
      },
    } as Partial<DaemonClient> as DaemonClient;

    const keel = createExecuteKeel({
      client,
      credential: "kc_admin_execute_schedule_test",
      cwd: "/repo",
      args: [],
      state: null,
      env: {},
    });

    expect((await keel.listSchedules({ includeDisabled: false }))[0]?.name).toBe("hourly");
    expect(await keel.getSchedule("missing", { includeSource: true })).toMatchObject({
      name: "missing",
      source: null,
    });
    expect(calls).toEqual([
      "authenticate:kc_admin_execute_schedule_test",
      'listSchedules:{"includeDisabled":false}',
      "authenticate:kc_admin_execute_schedule_test",
      'getSchedule:{"name":"missing","includeSource":true}',
    ]);
  });
});

const runId = "run_events";
const cursor = { kind: "after-seq", runId, seq: 1 } as const;
const caughtUp = { kind: "control", type: "caught-up", cursor } as const;

function durable(seq: number, type: string): EventEnvelope {
  return { kind: "durable", seq, type, payload: {}, atMs: seq };
}

function eventFixture(...frames: Array<EventStreamFrame | Error>) {
  const calls: string[] = [];
  const client = {
    async authenticate(token: string) {
      calls.push(`authenticate:${token}`);
      return { ok: true };
    },
    subscribeEvents(
      ...[req, onEvent, onError, , onControl]: Parameters<DaemonClient["subscribeEvents"]>
    ) {
      calls.push(`subscribe:${JSON.stringify(req)}`);
      queueMicrotask(() => {
        for (const frame of frames) {
          if (frame instanceof Error) onError?.(frame);
          else if (frame.kind === "control") onControl?.(frame);
          else onEvent(frame);
        }
      });
      return () => calls.push("unsubscribe");
    },
  } as Partial<DaemonClient> as DaemonClient;
  return { keel: executeWithClient(client, "kc_admin_execute_events_test"), calls };
}

function executeWithClient(client: DaemonClient, credential?: string) {
  return createExecuteKeel({ client, credential, cwd: "/repo", args: [], state: null, env: {} });
}

describe("execute runtime events", () => {
  test("uses request-object cursors and ends when a live run parks", async () => {
    const { keel, calls } = eventFixture(caughtUp, durable(2, "run.parked"));

    expect(
      await Array.fromAsync(keel.events({ runId, cursor: { kind: "tail", count: 0 } })),
    ).toEqual([durable(2, "run.parked")]);
    expect(calls).toEqual([
      "authenticate:kc_admin_execute_events_test",
      'subscribe:{"runId":"run_events","cursor":{"kind":"tail","count":0},"includeControlFrames":true}',
      "unsubscribe",
    ]);
  });

  test("yields historical parks and resumes before stopping at the live boundary", async () => {
    const park = durable(1, "run.parked");
    const resume = durable(2, "run.resumed");
    const finish = durable(3, "run.finished");
    const { keel, calls } = eventFixture(
      park,
      resume,
      { ...caughtUp, cursor: { ...cursor, seq: 2 } },
      finish,
    );

    expect(await Array.fromAsync(keel.events({ runId }))).toEqual([park, resume, finish]);
    expect(calls.at(-1)).toBe("unsubscribe");
  });

  test("ends after catch-up when the cursor skips an already closed run", async () => {
    const { keel, calls } = eventFixture(caughtUp, {
      kind: "control",
      type: "closed",
      cursor,
      status: "finished",
    });

    expect(await Array.fromAsync(keel.events({ runId, cursor: { kind: "now" } }))).toEqual([]);
    expect(calls.at(-1)).toBe("unsubscribe");
  });

  test("surfaces subscription rejection and authorization revocation", async () => {
    const rejected = eventFixture(new Error("subscription rejected"));
    await expect(Array.fromAsync(rejected.keel.events({ runId }))).rejects.toThrow(
      "subscription rejected",
    );
    expect(rejected.calls.at(-1)).toBe("unsubscribe");

    const revoked = eventFixture(caughtUp, {
      kind: "control",
      type: "authorization.failed",
      cursor,
      payload: { message: "run capability revoked" },
    });
    await expect(Array.fromAsync(revoked.keel.events({ runId }))).rejects.toThrow(
      "run capability revoked",
    );
    expect(revoked.calls.at(-1)).toBe("unsubscribe");
  });

  test("rejects a live iterator when its daemon socket closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-events-"));
    const socketPath = join(dir, "events.sock");
    const connected = Promise.withResolvers<Socket<undefined>>();
    const subId = "sub_events";
    const started = durable(1, "run.started");
    let buffer = "";
    const server = Bun.listen<undefined>({
      unix: socketPath,
      socket: {
        open: (socket) => connected.resolve(socket),
        data(socket, data) {
          buffer += data.toString();
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const request = JSON.parse(buffer.slice(0, newline));
          socket.write(
            [
              { event: { subId, ...started } },
              { event: { subId, ...caughtUp } },
              { id: request.id, result: { subId, cursor, closedStatus: null } },
            ]
              .map((frame) => `${JSON.stringify(frame)}\n`)
              .join(""),
          );
        },
      },
    });
    let client: DaemonClient | undefined;
    try {
      client = await DaemonClient.connect(socketPath);
      const events = executeWithClient(client).events({ runId })[Symbol.asyncIterator]();
      expect(await events.next()).toEqual({ value: started, done: false });
      const next = events.next();
      (await connected.promise).terminate();
      await expect(next).rejects.toThrow("daemon connection closed");
    } finally {
      client?.close();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
