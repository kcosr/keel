import { ArchiveX, Copy, GitMerge, RefreshCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, type KeelWebClient } from "../api/client";
import type { RunWorkspaceDiff, RunWorkspaceView } from "../api/types";
import {
  Button,
  CommandCopyButton,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  StatusPill,
  Tabs,
  TextInput,
  copyTextToClipboard,
  formatTime,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { type DiffMode, DiffView } from "../components/diff";
import { useAsync } from "../hooks/use-async";

type WorkspaceStatusFilter =
  | "all"
  | "pending_review"
  | "diff_error"
  | "cleanup_error"
  | "abandoned"
  | "merged"
  | "discarded"
  | "removed"
  | "creating"
  | "idle";

type WorkspaceAction = "merge" | "discard" | "gc";

const STATUS_FILTERS: WorkspaceStatusFilter[] = [
  "all",
  "pending_review",
  "diff_error",
  "cleanup_error",
  "abandoned",
  "merged",
  "discarded",
  "removed",
  "creating",
  "idle",
];

export function WorkspacesScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const listState = useAsync(() => client.listWorkspaces(), [client, refreshKey]);
  const workspaces = listState.data?.workspaces ?? [];
  const mutationAuthorized = listState.data?.mutationAuthorized === true;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<WorkspaceStatusFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("unified");
  const [pendingAction, setPendingAction] = useState<WorkspaceAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return workspaces
      .slice()
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .filter((workspace) => status === "all" || workspace.status === status)
      .filter((workspace) => {
        if (!needle) return true;
        return [
          workspace.workspaceId,
          workspace.runId,
          workspace.key,
          workspace.status,
          workspace.mode,
          workspace.workspacePath,
          workspace.sourcePath,
          workspace.sourceUri,
        ]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(needle));
      });
  }, [workspaces, query, status]);

  useEffect(() => {
    if (selectedKey && rows.some((workspace) => workspaceKey(workspace) === selectedKey)) return;
    setSelectedKey(rows[0] ? workspaceKey(rows[0]) : null);
  }, [rows, selectedKey]);

  const selected = rows.find((workspace) => workspaceKey(workspace) === selectedKey) ?? null;
  const detailState = useAsync(async () => {
    if (!selected) return null;
    const detail = await client.getRunWorkspace(selected.runId, selected.workspaceId);
    const workspace = detail ?? selected;
    const diff = workspace.diffSupported
      ? await client.getRunWorkspaceDiff(workspace.runId, workspace.workspaceId)
      : null;
    return { workspace, diff };
  }, [
    client,
    selected?.runId,
    selected?.workspaceId,
    selected?.updatedAtMs,
    selected?.diffSupported,
  ]);
  const selectedDetailKey = selected ? workspaceKey(selected) : null;
  const loadedDetailKey = detailState.data?.workspace
    ? workspaceKey(detailState.data.workspace)
    : null;
  const detailCurrent = selectedDetailKey !== null && loadedDetailKey === selectedDetailKey;
  const detailStale = detailState.data !== null && !detailCurrent;
  const detailLoading = detailState.loading || detailStale;
  const detail = detailCurrent ? (detailState.data?.workspace ?? selected) : selected;
  const diff = detailCurrent ? (detailState.data?.diff ?? null) : null;
  const summary = useMemo(() => workspaceSummary(workspaces), [workspaces]);

  const runWorkspaceAction = async (action: "merge" | "discard") => {
    if (!detail || !mutationAuthorized || pendingAction) return;
    const supported = action === "merge" ? detail.mergeSupported : detail.discardSupported;
    if (!supported) return;
    const confirmed = confirm(workspaceConfirmation(action, detail));
    if (!confirmed) return;
    setPendingAction(action);
    setActionError(null);
    setActionMessage(null);
    try {
      const next =
        action === "merge"
          ? await client.mergeRunWorkspace(detail.runId, detail.workspaceId)
          : await client.discardRunWorkspace(detail.runId, detail.workspaceId);
      setActionMessage(`${titleCase(action)} completed for ${next.workspaceId}`);
      listState.reload();
      detailState.reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPendingAction(null);
    }
  };

  const runGc = async () => {
    if (!mutationAuthorized || pendingAction) return;
    const confirmed = confirm(
      "Garbage collect merged, discarded, and abandoned retained workspaces? This removes eligible filesystem state and deletes eligible workspace rows.",
    );
    if (!confirmed) return;
    setPendingAction("gc");
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await client.gcWorkspaces();
      setActionMessage(`Garbage collected ${result.removed.length} workspace rows`);
      listState.reload();
      detailState.reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="workspace-screen">
      <div className="workspace-toolbar toolbar">
        <div className="toolbar-left">
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter workspaces"
            aria-label="Filter workspaces"
          />
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value as WorkspaceStatusFilter)}
            aria-label="Workspace status filter"
          >
            {STATUS_FILTERS.map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>
        <div className="toolbar-right">
          <StatusPill tone="waiting">{summary.review} review</StatusPill>
          <StatusPill tone="info">{summary.diffable} diffable</StatusPill>
          <StatusPill tone="neutral">{summary.total} total</StatusPill>
          <StatusPill tone={mutationAuthorized ? "success" : "waiting"}>admin</StatusPill>
          <Button icon={RefreshCw} size="sm" onClick={listState.reload}>
            Refresh
          </Button>
          <Button
            icon={ArchiveX}
            size="sm"
            variant="danger"
            disabled={!mutationAuthorized || pendingAction !== null}
            title={
              mutationAuthorized
                ? "Garbage collect eligible workspaces. CLI: keel workspace gc"
                : "Requires admin authority. CLI: keel workspace gc"
            }
            onClick={() => void runGc()}
          >
            {pendingAction === "gc" ? "GC running" : "GC"}
          </Button>
        </div>
      </div>
      {actionError ? <p className="form-error workspace-action-status">{actionError}</p> : null}
      {actionMessage ? (
        <p className="form-success workspace-action-status">{actionMessage}</p>
      ) : null}
      {!mutationAuthorized && !listState.loading && !listState.error ? (
        <div className="notice-panel">
          Workspace mutation requires admin authority. Merge, discard, and GC controls stay disabled
          without it; use the CLI equivalents below with an admin credential.
        </div>
      ) : null}
      <div className="workspace-layout">
        <section className="workspace-list-pane">
          {listState.loading ? <LoadingState label="Loading workspaces" /> : null}
          {listState.error ? (
            <ErrorState error={listState.error} onRetry={listState.reload} />
          ) : null}
          {!listState.loading && !listState.error ? (
            <DenseTable
              rows={rows}
              rowKey={workspaceKey}
              selectedKey={selectedKey}
              onRowClick={(workspace) => setSelectedKey(workspaceKey(workspace))}
              empty={
                <EmptyState
                  title="No retained workspaces"
                  detail="Adjust filters or provide admin credentials."
                />
              }
              columns={workspaceColumns()}
            />
          ) : null}
        </section>
        <section className="workspace-detail-pane">
          {detail ? (
            <>
              <WorkspaceDetailHeader
                workspace={detail}
                mutationAuthorized={mutationAuthorized}
                pendingAction={pendingAction}
                onMerge={() => void runWorkspaceAction("merge")}
                onDiscard={() => void runWorkspaceAction("discard")}
              />
              {detailLoading ? <LoadingState label="Loading workspace diff" /> : null}
              {detailState.error ? (
                <ErrorState error={detailState.error} onRetry={detailState.reload} />
              ) : null}
              <WorkspaceMetadata workspace={detail} />
              <WorkspaceCommands workspace={detail} mutationAuthorized={mutationAuthorized} />
              {!detail.diffSupported ? (
                <EmptyState
                  title="Diff unavailable"
                  detail="This workspace is direct, removed, or otherwise not diffable."
                />
              ) : null}
              {diff ? (
                <WorkspaceDiffPanel
                  diff={diff}
                  diffMode={diffMode}
                  onDiffModeChange={setDiffMode}
                />
              ) : null}
            </>
          ) : (
            <EmptyState
              title="No workspace selected"
              detail="Select a retained workspace to inspect detail and diff output."
            />
          )}
        </section>
      </div>
    </div>
  );
}

function WorkspaceDetailHeader({
  workspace,
  mutationAuthorized,
  pendingAction,
  onMerge,
  onDiscard,
}: {
  workspace: RunWorkspaceView;
  mutationAuthorized: boolean;
  pendingAction: WorkspaceAction | null;
  onMerge(): void;
  onDiscard(): void;
}) {
  return (
    <div className="workspace-detail-head">
      <div className="workspace-title-block">
        <h2 className="mono">{workspace.workspaceId}</h2>
        <span>
          <a className="inline-link mono" href={`#/runs/${encodeURIComponent(workspace.runId)}`}>
            {workspace.runId}
          </a>{" "}
          / {workspace.key}
        </span>
      </div>
      <div className="btn-row">
        <Button
          icon={GitMerge}
          variant="primary"
          disabled={!mutationAuthorized || !workspace.mergeSupported || pendingAction !== null}
          title={workspaceMutationTitle(workspace, mutationAuthorized, "merge")}
          onClick={onMerge}
        >
          {pendingAction === "merge" ? "Merging" : "Merge"}
        </Button>
        <Button
          icon={Trash2}
          variant="danger"
          disabled={!mutationAuthorized || !workspace.discardSupported || pendingAction !== null}
          title={workspaceMutationTitle(workspace, mutationAuthorized, "discard")}
          onClick={onDiscard}
        >
          {pendingAction === "discard" ? "Discarding" : "Discard"}
        </Button>
      </div>
    </div>
  );
}

function WorkspaceMetadata({ workspace }: { workspace: RunWorkspaceView }) {
  return (
    <section className="panel workspace-metadata">
      <div className="workspace-meta-strip">
        <StatusPill tone={toneForStatus(workspace.status)}>{workspace.status}</StatusPill>
        <StatusPill tone="neutral">{workspace.mode}</StatusPill>
        <StatusPill tone={workspace.diffSupported ? "info" : "neutral"}>
          {workspace.diffSupported ? "diffable" : "no diff"}
        </StatusPill>
        <StatusPill tone={workspace.mergeSupported ? "success" : "neutral"}>
          {workspace.mergeSupported ? "mergeable" : "merge blocked"}
        </StatusPill>
      </div>
      <div className="workspace-meta-grid">
        <MetadataItem label="Owner" value={`${workspace.ownerKind}:${workspace.key}`} />
        <MetadataItem label="Setup" value={workspaceSetupSummary(workspace)} />
        <MetadataItem
          label="Run"
          value={
            <a className="inline-link mono" href={`#/runs/${encodeURIComponent(workspace.runId)}`}>
              {workspace.runId}
            </a>
          }
        />
        <MetadataItem label="Updated" value={formatTime(workspace.updatedAtMs)} />
        <MetadataItem label="Source" value={workspace.sourceKind ?? "-"} />
        <MetadataItem label="Base" value={stringField(workspace, "baseCommit")} mono />
        <MetadataItem
          label="Lifecycle"
          value={`merged ${formatTime(workspace.mergedAtMs)} / discarded ${formatTime(
            workspace.discardedAtMs,
          )}`}
        />
        <MetadataItem
          label="Source path"
          value={workspace.sourcePath ?? workspace.sourceUri ?? "-"}
          mono
          wide
        />
        <MetadataItem label="Workspace path" value={workspace.workspacePath} mono wide />
      </div>
    </section>
  );
}

function MetadataItem({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={`workspace-meta-item ${wide ? "workspace-meta-wide" : ""}`}>
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined}>{value}</strong>
    </div>
  );
}

function WorkspaceCommands({
  workspace,
  mutationAuthorized,
}: {
  workspace: RunWorkspaceView;
  mutationAuthorized: boolean;
}) {
  return (
    <section className="panel workspace-command-panel">
      <div className="panel-heading">
        <h2>CLI Equivalents</h2>
        <button
          className="inline-link workspace-copy-id"
          type="button"
          onClick={() => void copyTextToClipboard(workspace.workspaceId)}
        >
          <Copy size={13} />
          Copy workspace id
        </button>
      </div>
      <div className="command-copy-grid">
        <CommandCopyButton
          label="Copy show command"
          command={`keel workspace show ${workspace.runId} ${workspace.workspaceId}`}
        />
        <CommandCopyButton
          label="Copy diff command"
          command={`keel workspace diff ${workspace.runId} ${workspace.workspaceId}`}
          detail={workspace.diffSupported ? null : "This workspace does not support diff."}
        />
        <CommandCopyButton
          label="Copy merge command"
          command={`keel workspace merge ${workspace.runId} ${workspace.workspaceId}`}
          detail={
            !mutationAuthorized
              ? "Requires admin authority."
              : !workspace.mergeSupported
                ? "Workspace is not currently mergeable."
                : null
          }
        />
        <CommandCopyButton
          label="Copy discard command"
          command={`keel workspace discard ${workspace.runId} ${workspace.workspaceId}`}
          detail={
            !mutationAuthorized
              ? "Requires admin authority."
              : !workspace.discardSupported
                ? "Workspace is not currently discardable."
                : null
          }
        />
        <CommandCopyButton label="Copy GC command" command="keel workspace gc" />
      </div>
    </section>
  );
}

function WorkspaceDiffPanel({
  diff,
  diffMode,
  onDiffModeChange,
}: {
  diff: RunWorkspaceDiff;
  diffMode: DiffMode;
  onDiffModeChange(mode: DiffMode): void;
}) {
  const changes = diffChanges(diff);
  return (
    <section className="workspace-diff-panel">
      <div className="workspace-diff-head">
        <div>
          <h2>Diff</h2>
          <span className="muted">
            {diff.diffKind} from {diff.baseLabel} to {diff.workspaceLabel}
          </span>
        </div>
        <Tabs<DiffMode>
          tabs={[
            { id: "unified", label: "Unified" },
            { id: "split", label: "Split" },
          ]}
          active={diffMode}
          onChange={onDiffModeChange}
        />
      </div>
      <div className="workspace-diff-grid">
        <aside className="workspace-file-list">
          <div className="workspace-file-summary">
            <StatusPill tone="neutral">{changes.length} files</StatusPill>
            <span>
              <span className="diff-stat-add">+{diff.added.length}</span>{" "}
              <span className="diff-stat-del">-{diff.deleted.length}</span>
            </span>
          </div>
          <div className="workspace-file-tree">
            {changes.map((change) => (
              <div className="workspace-file-row" key={`${change.status}:${change.path}`}>
                <span className={`workspace-file-badge workspace-file-${change.status}`}>
                  {statusGlyph(change.status)}
                </span>
                <span className="mono text-truncate">{change.path}</span>
              </div>
            ))}
            {changes.length === 0 ? <span className="muted">No changed paths.</span> : null}
          </div>
        </aside>
        <DiffView diff={diff.contentDiff} mode={diffMode} />
      </div>
    </section>
  );
}

function workspaceColumns(): Array<Column<RunWorkspaceView>> {
  return [
    {
      key: "workspace",
      header: "Workspace",
      render: (workspace) => (
        <span className="cell-stack">
          <strong className="mono">{workspace.workspaceId}</strong>
          <span>{workspace.key}</span>
        </span>
      ),
    },
    {
      key: "run",
      header: "Run",
      width: "155px",
      render: (workspace) => <span className="mono text-truncate">{workspace.runId}</span>,
    },
    { key: "mode", header: "Mode", width: "92px", render: (workspace) => workspace.mode },
    {
      key: "status",
      header: "Status",
      width: "145px",
      render: (workspace) => (
        <StatusPill tone={toneForStatus(workspace.status)}>{workspace.status}</StatusPill>
      ),
    },
  ];
}

function workspaceKey(workspace: RunWorkspaceView): string {
  return `${workspace.runId}:${workspace.workspaceId}`;
}

function workspaceSetupSummary(workspace: RunWorkspaceView): string {
  if (workspace.setupStatus === "none") return "none";
  const finished =
    workspace.setupFinishedAtMs !== null
      ? ` finished ${formatTime(workspace.setupFinishedAtMs)}`
      : "";
  return `${workspace.setupStatus}${finished}`;
}

function workspaceSummary(workspaces: RunWorkspaceView[]): {
  total: number;
  review: number;
  diffable: number;
} {
  return {
    total: workspaces.length,
    review: workspaces.filter((workspace) => workspace.status === "pending_review").length,
    diffable: workspaces.filter((workspace) => workspace.diffSupported).length,
  };
}

function diffChanges(diff: RunWorkspaceDiff): Array<{
  path: string;
  status: "added" | "modified" | "deleted" | "type_changed";
}> {
  if (diff.fileChanges.length > 0) {
    return diff.fileChanges.map((change) => ({ path: change.path, status: change.status }));
  }
  return [
    ...diff.modified.map((path) => ({ path, status: "modified" as const })),
    ...diff.added.map((path) => ({ path, status: "added" as const })),
    ...diff.deleted.map((path) => ({ path, status: "deleted" as const })),
  ];
}

function statusGlyph(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "type_changed":
      return "T";
    default:
      return "M";
  }
}

function stringField(workspace: RunWorkspaceView, key: string): string {
  const value = workspace[key];
  if (value === null || value === undefined) return "-";
  return typeof value === "string" ? value : String(value);
}

function workspaceMutationTitle(
  workspace: RunWorkspaceView,
  mutationAuthorized: boolean,
  action: "merge" | "discard",
): string {
  if (!mutationAuthorized) {
    return `Requires admin authority. CLI: keel workspace ${action} ${workspace.runId} ${workspace.workspaceId}`;
  }
  const supported = action === "merge" ? workspace.mergeSupported : workspace.discardSupported;
  if (!supported)
    return `Workspace is not currently ${action === "merge" ? "mergeable" : "discardable"}`;
  return `${titleCase(action)} retained workspace ${workspace.workspaceId}. CLI: keel workspace ${action} ${workspace.runId} ${workspace.workspaceId}`;
}

function workspaceConfirmation(action: "merge" | "discard", workspace: RunWorkspaceView): string {
  if (action === "merge") {
    return `Merge workspace ${workspace.workspaceId} from run ${workspace.runId} into its source? This writes retained changes to the target source.`;
  }
  return `Discard workspace ${workspace.workspaceId} from run ${workspace.runId}? This removes retained filesystem state and cannot be undone.`;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
