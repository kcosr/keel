import { describe, expect, test } from "bun:test";
import type { Socket } from "bun";
import type { GatewayEventFrame } from "./gateway.ts";
import { SocketGatewaySession } from "./server.ts";

class PartialWriteSocket {
  readonly chunks: Uint8Array[] = [];

  constructor(private readonly maxBytesPerWrite: number) {}

  write(data: string | BufferSource, byteOffset = 0, byteLength?: number): number {
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const requested = byteLength ?? bytes.byteLength - byteOffset;
    const written = Math.min(this.maxBytesPerWrite, requested);
    this.chunks.push(bytes.slice(byteOffset, byteOffset + written));
    return written;
  }

  text(): string {
    return new TextDecoder().decode(Buffer.concat(this.chunks));
  }
}

describe("SocketGatewaySession", () => {
  test("keeps flushing a frame when Bun accepts only a partial socket write", async () => {
    const socket = new PartialWriteSocket(7);
    const session = new SocketGatewaySession(socket as unknown as Socket<undefined>);
    const event: GatewayEventFrame = {
      subId: "sub",
      kind: "durable",
      seq: 1,
      type: "agent.diff",
      payload: { diff: "hello snowman ☃\n".repeat(40) },
      atMs: 123,
    };
    const frame = { event };

    session.sendEvent(event);
    await Bun.sleep(0);

    expect(socket.text()).toBe(`${JSON.stringify(frame)}\n`);
    expect(JSON.parse(socket.text()).event.payload.diff).toContain("☃");
  });
});
