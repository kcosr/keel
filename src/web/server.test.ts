import { describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import {
  GatewaySocket,
  disableEventStreamTimeout,
  eventStreamRunId,
  isEventStreamRequest,
} from "./server.ts";

function fakeSocket(): Socket {
  let destroyed = false;
  return {
    get destroyed() {
      return destroyed;
    },
    end() {},
    destroy() {
      destroyed = true;
      return this;
    },
    write(_data: string | Uint8Array, cb?: (err?: Error | null) => void) {
      cb?.(null);
      return true;
    },
  } as unknown as Socket;
}

describe("GatewaySocket", () => {
  test("ignores malformed daemon lines received after close", () => {
    const conn = GatewaySocket.fromConnectedSocketForTest(fakeSocket());
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      conn.close();
      conn.receiveForTest('{"event":{"kind":"durable","payload":"\\{"}}\n');
    } finally {
      console.error = originalError;
    }

    expect(errors.filter((line) => line.includes("gateway invalid json line"))).toEqual([]);
  });
});

describe("isEventStreamRequest", () => {
  test("matches only run event stream GET requests", () => {
    const stream = new Request("http://keel.test/runs/run_1/events");
    const streamWithQuery = new Request("http://keel.test/runs/run_1/events?afterSeq=4");
    const post = new Request("http://keel.test/runs/run_1/events", { method: "POST" });
    const projection = new Request("http://keel.test/api/runs/run_1");
    const nested = new Request("http://keel.test/runs/run_1/events/extra");

    expect(isEventStreamRequest(stream)).toBe(true);
    expect(eventStreamRunId(stream)).toBe("run_1");
    expect(isEventStreamRequest(streamWithQuery)).toBe(true);
    expect(eventStreamRunId(streamWithQuery)).toBe("run_1");
    expect(isEventStreamRequest(post)).toBe(false);
    expect(eventStreamRunId(post)).toBeNull();
    expect(isEventStreamRequest(projection)).toBe(false);
    expect(eventStreamRunId(projection)).toBeNull();
    expect(isEventStreamRequest(nested)).toBe(false);
    expect(eventStreamRunId(nested)).toBeNull();
    expect(eventStreamRunId(new Request("http://keel.test/runs/run_%E2%9C%93/events"))).toBe(
      "run_✓",
    );
  });
});

describe("disableEventStreamTimeout", () => {
  test("disables request timeout only for run event streams", () => {
    const calls: Array<{ request: Request; seconds: number }> = [];
    const server = {
      timeout(request: Request, seconds: number) {
        calls.push({ request, seconds });
      },
    };
    const stream = new Request("http://keel.test/runs/run_1/events");
    const projection = new Request("http://keel.test/api/runs/run_1");
    const post = new Request("http://keel.test/runs/run_1/events", { method: "POST" });

    disableEventStreamTimeout(stream, server);
    disableEventStreamTimeout(projection, server);
    disableEventStreamTimeout(post, server);

    expect(calls).toEqual([{ request: stream, seconds: 0 }]);
  });
});
