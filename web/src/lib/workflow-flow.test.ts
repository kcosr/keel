import { describe, expect, test } from "vitest";
import type { WorkflowFlowOperation, WorkflowFlowView } from "../api/types";
import { layoutFlow } from "./workflow-flow";
import type { FlowRuntimeOverrides } from "./workflow-flow-live";

function op(
  id: string,
  parallelLane = 0,
  kind: WorkflowFlowOperation["kind"] = "step",
): WorkflowFlowOperation {
  return {
    id,
    kind,
    key: { kind: "literal", text: `"${id}"`, static: true, value: id },
    containers: ["parallel"],
    parallelLane,
  };
}

describe("layoutFlow", () => {
  test("stacks deterministic Promise.all lanes before joining", () => {
    const flow: WorkflowFlowView = {
      entry: { name: null, async: true, params: [] },
      diagnostics: [],
      operations: [
        op("proposal", 0),
        op("approve-proposal", 0),
        op("review", 1),
        op("approve-review", 1),
      ],
    };

    const layout = layoutFlow(flow, { nodes: [], phase: null, finished: false });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("proposal")?.x).toBe(byId.get("approve-proposal")?.x);
    expect(byId.get("review")?.x).toBe(byId.get("approve-review")?.x);
    expect(byId.get("proposal")?.x).not.toBe(byId.get("review")?.x);
    expect(byId.get("approve-proposal")?.y).toBeGreaterThan(byId.get("proposal")?.y ?? 0);
    expect(byId.get("approve-review")?.y).toBeGreaterThan(byId.get("review")?.y ?? 0);

    const join = layout.nodes.find((node) => node.kind === "join");
    expect(join?.y).toBeGreaterThan(byId.get("approve-proposal")?.y ?? 0);
    expect(join?.y).toBeGreaterThan(byId.get("approve-review")?.y ?? 0);
    expect(layout.edges).toContainEqual(
      expect.objectContaining({ from: "proposal", to: "approve-proposal", kind: "seq" }),
    );
    expect(layout.edges).toContainEqual(
      expect.objectContaining({ from: "review", to: "approve-review", kind: "seq" }),
    );
  });

  test("uses live runtime overrides before projection nodes are refreshed", () => {
    const flow: WorkflowFlowView = {
      entry: { name: null, async: true, params: [] },
      diagnostics: [],
      operations: [op("proposal", 0, "agent"), op("approve-proposal", 0, "human")],
    };
    const overrides: FlowRuntimeOverrides = new Map([
      ["proposal", { state: "running" }],
      ["approve-proposal", { state: "blocked", reason: "human" }],
    ]);

    const layout = layoutFlow(flow, { nodes: [], phase: null, finished: false, overrides });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("proposal")).toMatchObject({
      tone: "running",
      matched: true,
      state: "running",
    });
    expect(byId.get("approve-proposal")).toMatchObject({
      tone: "waiting",
      matched: true,
      state: "blocked",
    });
  });
});
