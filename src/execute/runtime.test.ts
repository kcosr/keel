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
