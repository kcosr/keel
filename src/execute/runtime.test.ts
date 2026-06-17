import { describe, expect, test } from "bun:test";
import type { DaemonClient } from "../daemon/client.ts";
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

describe("execute runtime events", () => {
  test("uses request-object cursors and ends when a live run parks", async () => {
    const calls: string[] = [];
    const client = {
      async authenticate(token: string) {
        calls.push(`authenticate:${token}`);
        return { ok: true };
      },
      subscribeEvents(
        req: Parameters<DaemonClient["subscribeEvents"]>[0],
        onEvent: Parameters<DaemonClient["subscribeEvents"]>[1],
        _onError?: Parameters<DaemonClient["subscribeEvents"]>[2],
        onCaughtUp?: Parameters<DaemonClient["subscribeEvents"]>[3],
      ) {
        calls.push(`subscribe:${JSON.stringify(req)}`);
        queueMicrotask(() => {
          onCaughtUp?.({
            subId: "sub_parked",
            cursor: { kind: "after-seq", runId: "run_events", seq: 0 },
            closedStatus: null,
          });
          onEvent({
            kind: "durable",
            seq: 1,
            type: "run.parked",
            payload: { kind: "human" },
            atMs: 1,
          });
        });
        return () => calls.push("unsubscribe");
      },
    } as Partial<DaemonClient> as DaemonClient;

    const keel = createExecuteKeel({
      client,
      credential: "kc_admin_execute_events_test",
      cwd: "/repo",
      args: [],
      state: null,
      env: {},
    });

    const events = [];
    for await (const event of keel.events({
      runId: "run_events",
      cursor: { kind: "tail", count: 0 },
    })) {
      events.push(event.type);
    }

    expect(events).toEqual(["run.parked"]);
    expect(calls).toEqual([
      "authenticate:kc_admin_execute_events_test",
      'subscribe:{"runId":"run_events","cursor":{"kind":"tail","count":0}}',
      "unsubscribe",
    ]);
  });

  test("ends after catch-up when the cursor skips an already closed run", async () => {
    const calls: string[] = [];
    const client = {
      async authenticate(token: string) {
        calls.push(`authenticate:${token}`);
        return { ok: true };
      },
      subscribeEvents(
        req: Parameters<DaemonClient["subscribeEvents"]>[0],
        _onEvent: Parameters<DaemonClient["subscribeEvents"]>[1],
        _onError?: Parameters<DaemonClient["subscribeEvents"]>[2],
        onCaughtUp?: Parameters<DaemonClient["subscribeEvents"]>[3],
      ) {
        calls.push(`subscribe:${JSON.stringify(req)}`);
        queueMicrotask(() => {
          onCaughtUp?.({
            subId: "sub_closed",
            cursor: { kind: "after-seq", runId: "run_closed", seq: 3 },
            closedStatus: "finished",
          });
        });
        return () => calls.push("unsubscribe");
      },
    } as Partial<DaemonClient> as DaemonClient;

    const keel = createExecuteKeel({
      client,
      credential: "kc_admin_execute_events_test",
      cwd: "/repo",
      args: [],
      state: null,
      env: {},
    });

    const events = [];
    for await (const event of keel.events({ runId: "run_closed", cursor: { kind: "now" } })) {
      events.push(event.type);
    }

    expect(events).toEqual([]);
    expect(calls).toEqual([
      "authenticate:kc_admin_execute_events_test",
      'subscribe:{"runId":"run_closed","cursor":{"kind":"now"}}',
      "unsubscribe",
    ]);
  });
});
