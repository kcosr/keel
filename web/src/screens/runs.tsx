import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { RunListItem, RunStatus } from "../api/types";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  StatusPill,
  TextInput,
  Toggle,
  formatDuration,
  formatTime,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

const STATUS_FILTERS: Array<RunStatus | "all"> = [
  "all",
  "running",
  "waiting-human",
  "waiting-signal",
  "waiting-timer",
  "interrupted",
  "finished",
  "failed",
  "cancelled",
  "continued",
];

export function RunsScreen({
  client,
  globalSearch,
  refreshKey,
}: {
  client: KeelWebClient;
  globalSearch: string;
  refreshKey: number;
}) {
  const [status, setStatus] = useState<RunStatus | "all">("all");
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [localSearch, setLocalSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const runsState = useAsync(() => client.listRuns(), [client, refreshKey]);

  const rows = useMemo(() => {
    const query = [globalSearch, localSearch].join(" ").trim().toLowerCase();
    return (runsState.data?.runs ?? [])
      .slice()
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .filter((run) => status === "all" || run.status === status)
      .filter((run) => !blockedOnly || run.blockage !== null)
      .filter((run) => {
        if (!query) return true;
        return [run.runId, run.workflowName, run.runTarget, run.blockage?.context]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(query));
      });
  }, [runsState.data, status, blockedOnly, globalSearch, localSearch]);

  useEffect(() => {
    if (selectedId && rows.some((run) => run.runId === selectedId)) return;
    setSelectedId(rows[0]?.runId ?? null);
  }, [rows, selectedId]);

  const selected = rows.find((run) => run.runId === selectedId) ?? null;
  const counts = summarizeRuns(runsState.data?.runs ?? []);

  return (
    <div className="content-split runs-screen">
      <div className="content-scroll">
        <div className="toolbar">
          <div className="toolbar-left">
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value as RunStatus | "all")}
            >
              {STATUS_FILTERS.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </Select>
            <TextInput
              value={localSearch}
              onChange={(event) => setLocalSearch(event.target.value)}
              placeholder="Filter runs"
              aria-label="Filter runs"
            />
            <Toggle label="Blocked" checked={blockedOnly} onChange={setBlockedOnly} />
          </div>
          <div className="toolbar-right">
            <StatusPill tone="running">{counts.active} active</StatusPill>
            <StatusPill tone="waiting">{counts.blocked} blocked</StatusPill>
            <Button icon={RefreshCw} size="sm" onClick={runsState.reload}>
              Refresh
            </Button>
          </div>
        </div>
        {runsState.loading ? <LoadingState label="Loading runs" /> : null}
        {runsState.error ? <ErrorState error={runsState.error} onRetry={runsState.reload} /> : null}
        {!runsState.loading && !runsState.error ? (
          <DenseTable
            rows={rows}
            rowKey={(run) => run.runId}
            selectedKey={selectedId}
            onRowClick={(run) => setSelectedId(run.runId)}
            empty={
              <EmptyState
                title="No runs found"
                detail="Adjust filters or provide an admin credential."
              />
            }
            columns={columns()}
          />
        ) : null}
      </div>
      <RunInspector run={selected} />
    </div>
  );
}

function RunInspector({ run }: { run: RunListItem | null }) {
  if (!run) {
    return (
      <Inspector title="Run inspector" subtitle="No run selected">
        <EmptyState
          title="No run selected"
          detail="Select a row to inspect run status and commands."
        />
      </Inspector>
    );
  }

  return (
    <Inspector
      title={<span className="mono">{run.runId}</span>}
      subtitle={run.workflowName ?? "unnamed workflow"}
      status={
        <StatusPill tone={toneForStatus(run.status)} dot>
          {run.status}
        </StatusPill>
      }
      footer={
        <div className="btn-row">
          <Button icon={ExternalLink} variant="primary" onClick={() => navigateToRun(run.runId)}>
            Open
          </Button>
          <Button icon={Copy} onClick={() => copyText(run.runId)}>
            Copy id
          </Button>
        </div>
      }
    >
      <dl className="kv-list">
        <div className="kv-row">
          <dt>Created</dt>
          <dd>{formatTime(run.createdAtMs)}</dd>
        </div>
        <div className="kv-row">
          <dt>Duration</dt>
          <dd>{formatDuration(run.createdAtMs, run.finishedAtMs)}</dd>
        </div>
        <div className="kv-row">
          <dt>Target</dt>
          <dd className="mono">{run.runTarget ?? "-"}</dd>
        </div>
        <div className="kv-row">
          <dt>Nodes</dt>
          <dd>{run.run?.nodes.length ?? 0}</dd>
        </div>
        <div className="kv-row">
          <dt>Workspaces</dt>
          <dd>{run.workspaceSummary.count}</dd>
        </div>
      </dl>
      {run.blockage ? (
        <section className="inspector-section">
          <h3>Blockage</h3>
          <p>{run.blockage.context}</p>
          <StatusPill tone={toneForStatus(run.blockage.reason)}>{run.blockage.reason}</StatusPill>
        </section>
      ) : null}
    </Inspector>
  );
}

function columns(): Array<Column<RunListItem>> {
  return [
    {
      key: "status",
      header: "Status",
      width: "150px",
      render: (run) => (
        <StatusPill tone={toneForStatus(run.status)} dot>
          {run.status}
        </StatusPill>
      ),
    },
    {
      key: "workflow",
      header: "Workflow",
      render: (run) => (
        <div className="cell-stack">
          <strong>{run.workflowName ?? "unnamed"}</strong>
          <span className="mono">{run.runId}</span>
        </div>
      ),
    },
    {
      key: "target",
      header: "Target",
      render: (run) => <span className="mono text-truncate">{run.runTarget ?? "-"}</span>,
    },
    {
      key: "blockage",
      header: "Blockage",
      render: (run) =>
        run.blockage ? (
          <span className="text-truncate">{run.blockage.context}</span>
        ) : (
          <span className="muted">-</span>
        ),
    },
    {
      key: "age",
      header: "Duration",
      width: "110px",
      render: (run) => formatDuration(run.createdAtMs, run.finishedAtMs),
    },
    {
      key: "stats",
      header: "Nodes",
      width: "88px",
      align: "right",
      render: (run) => run.run?.nodes.length ?? 0,
    },
  ];
}

function summarizeRuns(runs: RunListItem[]): { active: number; blocked: number } {
  return {
    active: runs.filter((run) => run.status === "running" || run.status.startsWith("waiting"))
      .length,
    blocked: runs.filter((run) => run.blockage !== null).length,
  };
}

function navigateToRun(runId: string): void {
  window.location.hash = `#/runs/${encodeURIComponent(runId)}`;
}

function copyText(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}
