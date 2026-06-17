import { describe, expect, test } from "vitest";
import type { EventStreamFrame } from "../api/types";
import { flowPhaseFromEvents, flowRuntimeFromEvents } from "./workflow-flow-live";

describe("flowRuntimeFromEvents", () => {
  test("returns the latest streamed phase title", () => {
    const phase = flowPhaseFromEvents([
      durable(1, "phase", { title: "parallel inputs" }),
      ephemeral("agent.event", { key: "proposal", event: { type: "text", data: "draft" } }),
      durable(2, "phase", { title: "synthesis" }),
    ]);

    expect(phase).toBe("synthesis");
  });

  test("derives running, blocked, resumed, and completed states from keyed events", () => {
    const states = flowRuntimeFromEvents([
      ephemeral("agent.event", { key: "proposal", event: { type: "text", data: "draft" } }),
      durable(1, "run.parked", { kind: "human", key: "approve-proposal" }),
      durable(2, "run.resumed", {}),
      durable(3, "step.completed", { stableKey: "proposal", effectType: "agent" }),
    ]);

    expect(states.get("proposal")?.state).toBe("completed");
    expect(states.get("approve-proposal")?.state).toBe("completed");
  });

  test("skips run-level failures when no operation key is available", () => {
    const states = flowRuntimeFromEvents([durable(1, "run.failed", { message: "boom" })]);

    expect(states.size).toBe(0);
  });
});

function durable(seq: number, type: string, payload: unknown): EventStreamFrame {
  return { kind: "durable", seq, type, payload, atMs: seq };
}

function ephemeral(type: string, payload: unknown): EventStreamFrame {
  return { kind: "ephemeral", type, payload, atMs: 1 };
}
