import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { KeelWebClient } from "../api/client";
import type {
  SavedWorkflowSourceView,
  SavedWorkflowSummary,
  SavedWorkflowView,
} from "../api/types";
import { WorkflowsScreen } from "./workflows";

describe("WorkflowsScreen", () => {
  test("loads saved workflow detail, source, and launch through RPC client methods", async () => {
    const launchSavedWorkflow = vi.fn<KeelWebClient["launchSavedWorkflow"]>(async () => ({
      runId: "run_launched",
      attachCursor: { kind: "after-seq", runId: "run_launched", seq: 0 },
    }));
    const client = {
      listSavedWorkflows: vi.fn(async () => [workflowSummary()]),
      getSavedWorkflow: vi.fn(async () => workflowDetail()),
      getSavedWorkflowSource: vi.fn(async () => workflowSource()),
      launchSavedWorkflow,
    } as unknown as KeelWebClient;

    render(<WorkflowsScreen client={client} refreshKey={0} />);

    await screen.findByText("review-loop");
    await waitFor(() => expect(client.getSavedWorkflow).toHaveBeenCalledWith("review-loop"));
    await waitFor(() =>
      expect(client.getSavedWorkflowSource).toHaveBeenCalledWith({
        name: "review-loop",
        version: 2,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /source/i }));
    expect(await screen.findByText(/export default async function review/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /launch/i }));
    const launchButtons = screen.getAllByRole("button", { name: "Launch" });
    fireEvent.click(launchButtons[launchButtons.length - 1] as HTMLButtonElement);
    await waitFor(() =>
      expect(launchSavedWorkflow).toHaveBeenCalledWith({
        name: "review-loop",
        version: 2,
        input: { n: 2 },
        target: "/tmp/work",
        runName: null,
      }),
    );
    expect(JSON.stringify(launchSavedWorkflow.mock.calls[0]?.[0])).not.toContain("runSecrets");
    expect(await screen.findByText("run_launched")).toBeInTheDocument();
  });
});

function workflowSummary(): SavedWorkflowSummary {
  return {
    name: "review-loop",
    title: "Review loop",
    description: "Run review workflow",
    tags: ["review"],
    createdAtMs: 1,
    updatedAtMs: 2,
    disabledAtMs: null,
    deletedAtMs: null,
    latestVersion: 2,
    latestDefinitionHash: "wf_hash_v2",
    versions: [workflowVersion(2)],
  };
}

function workflowDetail(): SavedWorkflowView {
  return {
    ...workflowSummary(),
    versions: [workflowVersion(1), workflowVersion(2)],
  };
}

function workflowVersion(version: number) {
  return {
    name: "review-loop",
    version,
    definitionHash: `wf_hash_v${version}`,
    workflowName: "review",
    inputSchema: null,
    inputSchemaSet: false,
    defaultInput: { n: 2 },
    defaultInputSet: true,
    defaultTarget: "/tmp/work",
    metadata: null,
    sourceProvenance: null,
    createdBy: null,
    createdAtMs: version,
    enabled: true,
    deprecatedAtMs: null,
    deprecationMessage: null,
    deletedAtMs: null,
  };
}

function workflowSource(): SavedWorkflowSourceView {
  return {
    name: "review-loop",
    version: 2,
    definitionHash: "wf_hash_v2",
    entry: "workflow.ts",
    files: [
      {
        path: "workflow.ts",
        entry: true,
        code: "export default async function review() { return 1; }\n",
      },
    ],
  };
}
