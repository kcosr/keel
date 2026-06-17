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
  });
});

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}
