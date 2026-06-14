import type { TraceEvent } from "../agents/types.ts";
import type { Json } from "../hash.ts";
import { RUN_FINISHED_INLINE_OUTPUT_BYTES } from "./output.ts";

export interface DurableAgentEvent {
  type: "agent.message" | "agent.tool_call" | "agent.tool_result";
  payload: Json;
}

export function consolidatedAgentEvents(
  key: string,
  text: string,
  transcript: TraceEvent[],
): DurableAgentEvent[] {
  const events: DurableAgentEvent[] = [];
  let textBuffer = "";
  let emittedText = false;
  const flushText = (): void => {
    if (textBuffer.length === 0) return;
    events.push({
      type: "agent.message",
      payload: { key, ...boundedField("text", textBuffer) },
    });
    emittedText = true;
    textBuffer = "";
  };
  for (const event of transcript) {
    if (event.type === "text" && typeof event.data === "string") {
      textBuffer += event.data;
    } else if (event.type === "tool_call") {
      flushText();
      events.push({
        type: "agent.tool_call",
        payload: { key, ...boundedField("data", event.data ?? null) },
      });
    } else if (event.type === "tool_result") {
      flushText();
      events.push({
        type: "agent.tool_result",
        payload: { key, ...boundedField("data", event.data ?? null) },
      });
    }
  }
  flushText();
  if (!emittedText && text.length > 0) {
    events.push({
      type: "agent.message",
      payload: { key, ...boundedField("text", text) },
    });
  }
  return events;
}

export function redactTranscript(
  transcript: TraceEvent[],
  redactJson: (json: string) => string,
): TraceEvent[] {
  return transcript.map((event) => JSON.parse(redactJson(JSON.stringify(event))) as TraceEvent);
}

function boundedField(name: "text" | "data", value: unknown): { [key: string]: Json } {
  const json = JSON.stringify(value ?? null);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength <= RUN_FINISHED_INLINE_OUTPUT_BYTES) {
    return { [name]: (value ?? null) as Json };
  }
  return { omitted: true, byteLength };
}
