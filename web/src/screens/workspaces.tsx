import { useEffect, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { RunWorkspaceView } from "../api/types";
import {
  EmptyState,
  ErrorState,
  JsonBlock,
  LoadingState,
  StatusPill,
  formatTime,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

export function WorkspacesScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const state = useAsync(() => client.listWorkspaces(), [client, refreshKey]);
  const workspaces = state.data?.workspaces ?? [];
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  useEffect(() => {
    if (
      selectedWorkspaceId &&
      workspaces.some((workspace) => workspace.workspaceId === selectedWorkspaceId)
    ) {
      return;
    }
    setSelectedWorkspaceId(workspaces[0]?.workspaceId ?? null);
  }, [workspaces, selectedWorkspaceId]);
  const selected =
    workspaces.find((workspace) => workspace.workspaceId === selectedWorkspaceId) ?? null;

  return (
    <div className="content-split">
      <div className="content-scroll">
        {state.loading ? <LoadingState label="Loading workspaces" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error ? (
          <DenseTable
            rows={workspaces}
            rowKey={(workspace) => workspace.workspaceId}
            selectedKey={selectedWorkspaceId}
            onRowClick={(workspace) => setSelectedWorkspaceId(workspace.workspaceId)}
            empty={<EmptyState title="No retained workspaces" />}
            columns={workspaceColumns()}
          />
        ) : null}
      </div>
      <Inspector title="Workspace" subtitle={selected?.workspaceId ?? "No workspace"}>
        {selected ? <JsonBlock value={selected} /> : <EmptyState title="No workspace selected" />}
      </Inspector>
    </div>
  );
}

function workspaceColumns(): Array<Column<RunWorkspaceView>> {
  return [
    {
      key: "id",
      header: "Workspace",
      render: (workspace) => <span className="mono">{workspace.workspaceId}</span>,
    },
    {
      key: "run",
      header: "Run",
      width: "180px",
      render: (workspace) => <span className="mono">{workspace.runId}</span>,
    },
    { key: "mode", header: "Mode", width: "100px", render: (workspace) => workspace.mode },
    {
      key: "status",
      header: "Status",
      width: "120px",
      render: (workspace) => (
        <StatusPill tone={toneForStatus(workspace.status)}>{workspace.status}</StatusPill>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      width: "190px",
      render: (workspace) => formatTime(workspace.updatedAtMs),
    },
    {
      key: "path",
      header: "Path",
      render: (workspace) => <span className="mono text-truncate">{workspace.workspacePath}</span>,
    },
  ];
}
