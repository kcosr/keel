import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { WorkflowFlowView } from "../api/types";
import { WorkflowFlow } from "./workflow-flow";

describe("WorkflowFlow", () => {
  test("does not mark return nodes completed on failed terminal runs", () => {
    render(
      <WorkflowFlow flow={flow()} nodes={[]} phase={null} runStatus="failed" runtime={new Map()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /return/i }));

    expect(screen.getByText("not started")).toBeInTheDocument();
    expect(screen.queryByText("completed")).not.toBeInTheDocument();
  });
});

function flow(): WorkflowFlowView {
  return {
    entry: { name: "wf", async: true, params: [] },
    input: null,
    diagnostics: [],
    operations: [
      {
        id: "phase_1",
        kind: "phase",
        title: { kind: "literal", text: '"build"', static: true, value: "build" },
        containers: [],
      },
      {
        id: "return_2",
        kind: "return",
        result: { kind: "identifier", text: "result", static: false },
        containers: [],
      },
    ],
  };
}
