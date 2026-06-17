import { describe, expect, test } from "vitest";
import { parseSseBlock, parseSseStream, parseSseText } from "./sse";

describe("SSE parser", () => {
  test("parses named JSON event frames", () => {
    expect(parseSseBlock('event: event\ndata: {"kind":"durable","seq":4}\n')).toEqual({
      event: "event",
      data: { kind: "durable", seq: 4 },
      raw: 'event: event\ndata: {"kind":"durable","seq":4}\n',
    });
  });

  test("preserves multiline data and heartbeat comments", () => {
    expect(parseSseText(": heartbeat 1\n\nevent: error\ndata: first\ndata: second\n")).toEqual([
      { event: "heartbeat", data: null, raw: ": heartbeat 1" },
      { event: "error", data: "first\nsecond", raw: "event: error\ndata: first\ndata: second\n" },
    ]);
  });

  test("streams chunked frames", async () => {
    const encoder = new TextEncoder();
    const frames: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: snapshot\ndata: {"runId"'));
        controller.enqueue(encoder.encode(':"run_1"}\n\nevent: caught-up\ndata: {"ok":true}\n\n'));
        controller.close();
      },
    });

    await parseSseStream(stream, { onMessage: (frame) => frames.push(frame) });

    expect(frames).toEqual([
      {
        event: "snapshot",
        data: { runId: "run_1" },
        raw: 'event: snapshot\ndata: {"runId":"run_1"}',
      },
      { event: "caught-up", data: { ok: true }, raw: 'event: caught-up\ndata: {"ok":true}' },
    ]);
  });
});
