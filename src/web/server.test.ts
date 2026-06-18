import { describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import { GatewaySocket } from "./server.ts";

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
