import { afterEach, describe, expect, test, vi } from "vitest";
import { resetWebDebugCacheForTest } from "../lib/debug";
import { ApiError, KeelWebClient, WEB_RUNS_DEFAULT_LIMIT } from "./client";

describe("KeelWebClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    resetWebDebugCacheForTest();
  });

  test("sends bearer credentials on protected projection requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        runs: [],
      }),
    );
    const client = new KeelWebClient({
      baseUrl: "http://keel.test",
      getCredential: () => "kc_test_token",
      fetchImpl,
    });

    await client.listRuns();

    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(input)).toBe(`http://keel.test/api/runs?limit=${WEB_RUNS_DEFAULT_LIMIT}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer kc_test_token");
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
  });

  test("can request an explicit bounded runs list", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        runs: [],
        page: {
          limit: 25,
          defaultLimit: WEB_RUNS_DEFAULT_LIMIT,
          maxLimit: 500,
          returned: 0,
          total: 0,
          truncated: false,
        },
      }),
    );
    const client = new KeelWebClient({ baseUrl: "http://keel.test", fetchImpl });

    await client.listRuns({ limit: 25 });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://keel.test/api/runs?limit=25");
  });

  test("omits bearer credentials for health", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        ok: true,
        web: { ok: true, apiOnly: false },
        daemon: { reachable: false },
        bundle: { available: true },
      }),
    );
    const client = new KeelWebClient({
      baseUrl: "http://keel.test",
      getCredential: () => "kc_test_token",
      fetchImpl,
    });

    await client.health();

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  test("raises structured HTTP errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: { message: "no capability presented" } }, { status: 401 }),
    );
    const client = new KeelWebClient({ baseUrl: "http://keel.test", fetchImpl });

    await expect(client.listRuns()).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "no capability presented",
    });
  });

  test("preserves HTTP status for RPC errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: { message: "admin required" } }, { status: 403 }),
    );
    const client = new KeelWebClient({ baseUrl: "http://keel.test", fetchImpl });

    await expect(client.rpc("listSchedules")).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      message: "admin required",
    });
  });

  test("uses current RPC shapes for workflow, schedule, profile, and setting detail calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));
    const client = new KeelWebClient({
      baseUrl: "http://keel.test",
      getCredential: () => "kc_admin",
      fetchImpl,
    });

    await client.getSavedWorkflow("review-loop");
    await client.getSavedWorkflowSource({ name: "review-loop", version: 3 });
    await client.launchSavedWorkflow({
      name: "review-loop",
      version: 3,
      input: { n: 1 },
      target: "/tmp/work",
      runName: "manual run",
    });
    await client.getSchedule("hourly");
    await client.getAgentProfile("codex-default");
    await client.checkAgentProfile("codex-default");
    await client.getSetting("agent.defaultTimeoutMs");
    await client.checkSetting("agent.defaultTimeoutMs", 120000);

    const bodies = fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)) as { method: string; params: unknown },
    );
    expect(bodies).toEqual([
      { method: "getSavedWorkflow", params: { name: "review-loop" } },
      {
        method: "getSavedWorkflowSource",
        params: { name: "review-loop", version: 3, all: true, allowDeprecated: true },
      },
      {
        method: "launchSavedWorkflow",
        params: {
          ref: { name: "review-loop", version: 3 },
          input: { n: 1 },
          target: "/tmp/work",
          name: "manual run",
        },
      },
      { method: "getSchedule", params: { name: "hourly", includeSource: true } },
      { method: "getAgentProfile", params: { name: "codex-default" } },
      { method: "checkAgentProfile", params: { name: "codex-default" } },
      { method: "getSetting", params: { key: "agent.defaultTimeoutMs" } },
      { method: "checkSetting", params: { key: "agent.defaultTimeoutMs", value: 120000 } },
    ]);
    for (const body of bodies) expect(JSON.stringify(body)).not.toContain("runSecrets");
  });

  test("uses browser-safe RPC shapes for run mutations", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));
    const client = new KeelWebClient({ baseUrl: "http://keel.test", fetchImpl });

    await client.resumeRun("run_1");
    await client.interruptRun("run_1", "operator review");
    await client.retryRun("run_1");
    await client.rerunRun("run_1");
    await client.rewindRun("run_1", "plan");
    await client.forkRun("run_1", "plan");
    await client.sendSignal("run_1", "continue", { approved: true });

    const bodies = fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)) as { method: string; params: unknown },
    );
    expect(bodies).toEqual([
      { method: "resumeRun", params: { runId: "run_1" } },
      { method: "interruptRun", params: { runId: "run_1", reason: "operator review" } },
      { method: "retryRun", params: { runId: "run_1" } },
      { method: "rerunRun", params: { runId: "run_1", opts: {} } },
      { method: "rewindRun", params: { runId: "run_1", toStableKey: "plan" } },
      { method: "forkRun", params: { runId: "run_1", opts: { atStableKey: "plan" } } },
      {
        method: "sendSignal",
        params: { runId: "run_1", name: "continue", payload: { approved: true } },
      },
    ]);
    for (const body of bodies) expect(JSON.stringify(body)).not.toContain("runSecrets");
  });

  test("uses current RPC shapes for resource mutations", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ result: {} }));
    const client = new KeelWebClient({ baseUrl: "http://keel.test", fetchImpl });

    await client.setSavedWorkflowDisabled("review-loop", true);
    await client.setSavedWorkflowVersionEnabled("review-loop", 3, false);
    await client.deprecateSavedWorkflowVersion("review-loop", 3, "Use version 4");
    await client.deleteSavedWorkflowVersion("review-loop", 2);
    await client.deleteSavedWorkflow("review-loop");
    await client.putSchedule({
      name: "hourly",
      workflowName: "review-loop",
      workflowVersion: 3,
      intervalMs: 3_600_000,
      input: { n: 1 },
      target: "/tmp/work",
    });
    await client.setScheduleEnabled("hourly", false);
    await client.deleteSchedule("hourly");
    await client.checkAgentProfileConfig({ provider: "codex" });
    await client.putAgentProfile({
      name: "codex-default",
      config: { provider: "codex" },
      ifGeneration: 4,
    });
    await client.deleteAgentProfile("codex-default", 4);
    await client.putSetting("agent.timeoutMs", 120_000, 2);
    await client.deleteSetting("agent.timeoutMs", 2);

    const bodies = fetchImpl.mock.calls.map(
      ([, init]) => JSON.parse(String(init?.body)) as { method: string; params: unknown },
    );
    expect(bodies).toEqual([
      { method: "setSavedWorkflowDisabled", params: { name: "review-loop", disabled: true } },
      {
        method: "setSavedWorkflowVersionEnabled",
        params: { name: "review-loop", version: 3, enabled: false },
      },
      {
        method: "deprecateSavedWorkflowVersion",
        params: { name: "review-loop", version: 3, message: "Use version 4" },
      },
      { method: "deleteSavedWorkflowVersion", params: { name: "review-loop", version: 2 } },
      { method: "deleteSavedWorkflow", params: { name: "review-loop" } },
      {
        method: "putSchedule",
        params: {
          name: "hourly",
          savedRef: { name: "review-loop", version: 3 },
          intervalMs: 3_600_000,
          input: { n: 1 },
          target: "/tmp/work",
        },
      },
      { method: "setScheduleEnabled", params: { name: "hourly", enabled: false } },
      { method: "deleteSchedule", params: { name: "hourly" } },
      { method: "checkAgentProfile", params: { config: { provider: "codex" } } },
      {
        method: "putAgentProfile",
        params: {
          name: "codex-default",
          config: { provider: "codex" },
          ifGeneration: 4,
        },
      },
      {
        method: "deleteAgentProfile",
        params: { name: "codex-default", ifGeneration: 4 },
      },
      {
        method: "putSetting",
        params: { key: "agent.timeoutMs", value: 120000, ifGeneration: 2 },
      },
      { method: "deleteSetting", params: { key: "agent.timeoutMs", ifGeneration: 2 } },
    ]);
  });

  test("watches run events with cursor query and authorization header", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('event: snapshot\ndata: {"runId":"run_1"}\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const frames: unknown[] = [];
    const client = new KeelWebClient({
      baseUrl: "http://keel.test",
      getCredential: () => "kc_run_token",
      fetchImpl,
    });

    const stop = client.watchRunEvents("run_1", {
      cursor: { kind: "after-seq", seq: 7 },
      onFrame: (frame) => frames.push(frame),
    });

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    stop();

    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(input)).toBe("http://keel.test/runs/run_1/events?afterSeq=7");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer kc_run_token");
    expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
  });

  test("reconnects watched events from the last durable cursor", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      const call = fetchImpl.mock.calls.length;
      const body =
        call === 1
          ? 'event: event\ndata: {"kind":"durable","seq":8,"type":"phase","payload":{},"atMs":1}\n\n'
          : 'event: caught-up\ndata: {"kind":"control","type":"caught-up","cursor":{"kind":"after-seq","runId":"run_1","seq":8}}\n\nevent: closed\ndata: {"kind":"control","type":"closed","cursor":{"kind":"after-seq","runId":"run_1","seq":8},"status":"finished"}\n\n';
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const frames: unknown[] = [];
    const statuses: unknown[] = [];
    const client = new KeelWebClient({ baseUrl: "http://keel.test", fetchImpl });

    const stop = client.watchRunEvents("run_1", {
      reconnectDelayMs: 0,
      onFrame: (frame) => frames.push(frame),
      onStatus: (status) => statuses.push(status),
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    stop();

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "http://keel.test/runs/run_1/events?tail=100",
    );
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      "http://keel.test/runs/run_1/events?afterSeq=8",
    );
    expect(statuses).toContainEqual({ state: "caught-up", cursor: { kind: "after-seq", seq: 8 } });
    expect(statuses).toContainEqual({
      state: "closed",
      cursor: { kind: "after-seq", seq: 8 },
      reason: "finished",
    });
  });

  test("suppresses heartbeat keepalives from watched event callbacks", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(': heartbeat 1\n\nevent: event\ndata: {"seq":1}\n\n'),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const frames: unknown[] = [];
    const client = new KeelWebClient({ baseUrl: "http://keel.test", fetchImpl });

    const stop = client.watchRunEvents("run_1", {
      onFrame: (frame) => frames.push(frame),
    });

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    stop();

    expect(frames).toEqual([
      { event: "event", data: { seq: 1 }, raw: 'event: event\ndata: {"seq":1}' },
    ]);
  });

  test("event debug summaries omit raw streamed agent text", async () => {
    const marker = "raw-secret-debug-marker";
    localStorage.setItem("keelDebug", "events");
    resetWebDebugCacheForTest();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: event\ndata: {"kind":"ephemeral","type":"agent.event","payload":{"key":"review","event":{"type":"reasoning","data":"${marker}"}},"atMs":1}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const frames: unknown[] = [];
    const client = new KeelWebClient({ baseUrl: "http://keel.test", fetchImpl });

    const stop = client.watchRunEvents("run_1", {
      onFrame: (frame) => frames.push(frame),
    });

    await vi.waitFor(() => expect(frames).toHaveLength(1));
    stop();

    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).not.toContain(marker);
    expect(logged).toContain(`"dataLength":${marker.length}`);
    expect(logged).toContain('"innerType":"reasoning"');
  });
});

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}
