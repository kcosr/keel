import type { TraceEvent } from "../agents/types.ts";
import type { Json } from "../hash.ts";
import { RUN_FINISHED_INLINE_OUTPUT_BYTES } from "./output.ts";

export interface DurableAgentEvent {
  type:
    | "agent.message"
    | "agent.tool_call"
    | "agent.tool_result"
    | "agent.diff"
    | "workspace.diff_error";
  payload: Json;
}

export function finalAgentMessageEvents(
  key: string,
  attempt: number,
  text: string,
): DurableAgentEvent[] {
  if (text.length === 0) return [];
  return [
    {
      type: "agent.message",
      payload: { key, attempt, ...boundedField("text", text) },
    },
  ];
}

export function durableAgentToolEvent(
  key: string,
  attempt: number,
  event: TraceEvent,
): DurableAgentEvent | null {
  if (event.type !== "tool_call" && event.type !== "tool_result") return null;
  return {
    type: event.type === "tool_call" ? "agent.tool_call" : "agent.tool_result",
    payload: {
      key,
      attempt,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...boundedField("data", event.data ?? null),
    },
  };
}

function boundedField(name: "text" | "data", value: unknown): { [key: string]: Json } {
  const json = JSON.stringify(value ?? null);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength <= RUN_FINISHED_INLINE_OUTPUT_BYTES) {
    return { [name]: (value ?? null) as Json };
  }
  return { omitted: true, byteLength };
}
