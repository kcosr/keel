import { useEffect, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { SavedWorkflowSummary } from "../api/types";
import {
  EmptyState,
  ErrorState,
  JsonBlock,
  LoadingState,
  StatusPill,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

export function WorkflowsScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const state = useAsync(() => client.listSavedWorkflows(), [client, refreshKey]);
  const workflows = state.data ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  useEffect(() => {
    if (selectedName && workflows.some((workflow) => workflow.name === selectedName)) return;
    setSelectedName(workflows[0]?.name ?? null);
  }, [workflows, selectedName]);
  const selected = workflows.find((workflow) => workflow.name === selectedName) ?? null;

  return (
    <div className="content-split">
      <div className="content-scroll">
        {state.loading ? <LoadingState label="Loading workflows" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error ? (
          <DenseTable
            rows={workflows}
            rowKey={(workflow) => workflow.name}
            selectedKey={selectedName}
            onRowClick={(workflow) => setSelectedName(workflow.name)}
            empty={
              <EmptyState
                title="No saved workflows"
                detail="Saved workflows are loaded through /rpc."
              />
            }
            columns={workflowColumns()}
          />
        ) : null}
      </div>
      <Inspector title="Workflow" subtitle={selected?.name ?? "No workflow"}>
        {selected ? <JsonBlock value={selected} /> : <EmptyState title="No workflow selected" />}
      </Inspector>
    </div>
  );
}

function workflowColumns(): Array<Column<SavedWorkflowSummary>> {
  return [
    { key: "name", header: "Name", render: (workflow) => <strong>{workflow.name}</strong> },
    {
      key: "title",
      header: "Title",
      render: (workflow) => workflow.title ?? workflow.description ?? "-",
    },
    {
      key: "version",
      header: "Latest",
      width: "90px",
      align: "right",
      render: (workflow) => workflow.latestVersion ?? "-",
    },
    {
      key: "state",
      header: "State",
      width: "120px",
      render: (workflow) => (
        <StatusPill tone={workflow.disabledAtMs !== null ? "neutral" : "success"}>
          {workflow.disabledAtMs !== null ? "disabled" : "enabled"}
        </StatusPill>
      ),
    },
  ];
}
