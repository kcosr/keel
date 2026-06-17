import { describe, expect, test, vi } from "vitest";
import { ApiError, KeelWebClient } from "./client";

describe("KeelWebClient", () => {
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

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer kc_test_token");
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
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
});

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}
