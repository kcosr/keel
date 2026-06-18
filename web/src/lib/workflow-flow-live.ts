import type { EventStreamFrame } from "../api/types";

export type FlowRuntimeState = "not-started" | "running" | "blocked" | "completed" | "failed";

export interface FlowRuntimeOverride {
  state: FlowRuntimeState;
  reason?: string;
}

export type FlowRuntimeOverrides = Map<string, FlowRuntimeOverride>;

export function flowPhaseFromEvents(events: EventStreamFrame[]): string | null {
  let phase: string | null = null;
  for (const event of events) {
    if (event.kind === "control" || event.type !== "phase") continue;
    phase = payloadString(event.payload, "title") ?? phase;
  }
  return phase;
}

export function flowRuntimeFromEvents(events: EventStreamFrame[]): FlowRuntimeOverrides {
  const states: FlowRuntimeOverrides = new Map();
  const blockedKeys = new Set<string>();

  const mark = (key: string | null, state: FlowRuntimeState, reason?: string) => {
    if (!key) return;
    const previous = states.get(key);
    if (previous?.state === "failed") return;
    if (previous?.state === "completed" && (state === "running" || state === "blocked")) return;
    if (previous?.state === "blocked" && state === "running") return;
    states.set(key, reason ? { state, reason } : { state });
  };

  for (const event of events) {
    if (event.kind === "control") continue;
    const key = payloadString(event.payload, "key");
    const stableKey = payloadString(event.payload, "stableKey");

    if (event.type === "agent.event" || event.type === "agent.tool_call") {
      mark(key, "running");
      continue;
    }

    if (event.type === "agent.message" || event.type === "agent.diff") {
      mark(key, "completed");
      continue;
    }

    if (event.type === "step.completed") {
      mark(stableKey, "completed");
      continue;
    }

    if (event.type === "run.parked") {
      const kind = payloadString(event.payload, "kind");
      const parkedKey = key ?? stableKey;
      mark(parkedKey, "blocked", kind ?? "parked");
      if (parkedKey) blockedKeys.add(parkedKey);
      continue;
    }

    if (event.type === "run.resumed") {
      for (const blockedKey of blockedKeys) mark(blockedKey, "completed");
      blockedKeys.clear();
      continue;
    }

    if (
      event.type === "run.failed" ||
      event.type === "step.failed" ||
      event.type === "workspace.diff_error"
    ) {
      mark(key ?? stableKey, "failed");
    }
  }

  return states;
}

function payloadString(payload: unknown, property: string): string | null {
  if (!payload || typeof payload !== "object" || !(property in payload)) return null;
  const value = (payload as Record<string, unknown>)[property];
  return typeof value === "string" && value.length > 0 ? value : null;
}
