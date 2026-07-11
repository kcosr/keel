import { Copy, ExternalLink, Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type KeelWebClient, WEB_RUNS_DEFAULT_LIMIT } from "../api/client";
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
  copyTextToClipboard,
  formatDuration,
  formatTime,
  statusLabel,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";
import { useNow } from "../hooks/use-now";

const RUNS_AUTO_REFRESH_MS = 10_000;
const RUNS_PAGE_INCREMENT = 100;

const STATUS_FILTERS: Array<RunStatus | "all"> = [
  "all",
  "running",
  "waiting-human",
  "waiting-signal",
  "waiting-timer",
  "waiting-approval",
  "interrupted",
  "finished",
  "failed",
  "cancelled",
  "continued",
];

interface RunGroup {
  id: "needs-decision" | "active" | "finished";
  title: string;
  rows: RunListItem[];
}

interface RunFilters {
  status: RunStatus | "all";
  target: string;
  blockedOnly: boolean;
  query: string;
  limit: number;
}

export function RunsScreen({
  client,
  refreshKey,
}: {
  client: KeelWebClient;
  refreshKey: number;
}) {
  const initialFilters = useMemo(readRunFilters, []);
  const [status, setStatus] = useState<RunStatus | "all">(initialFilters.status);
  const [target, setTarget] = useState(initialFilters.target);
  const [blockedOnly, setBlockedOnly] = useState(initialFilters.blockedOnly);
  const [localSearch, setLocalSearch] = useState(initialFilters.query);
  const [pageLimit, setPageLimit] = useState(initialFilters.limit);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const runsState = useAsync(
    () => client.listRuns({ limit: pageLimit }),
    [client, pageLimit, refreshKey],
  );
  const nowMs = useNow();

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") runsState.reload();
    };
    const timer = window.setInterval(refresh, RUNS_AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [runsState.reload]);

  useEffect(() => {
    writeRunFilters({ status, target, blockedOnly, query: localSearch, limit: pageLimit });
  }, [status, target, blockedOnly, localSearch, pageLimit]);

  const targetOptions = useMemo(() => targetValues(runsState.data?.runs ?? []), [runsState.data]);

  const rows = useMemo(() => {
    const query = localSearch.trim().toLowerCase();
    return (runsState.data?.runs ?? [])
      .slice()
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .filter((run) => status === "all" || run.status === status)
      .filter((run) => target === "all" || (run.runTarget ?? "untargeted") === target)
      .filter((run) => !blockedOnly || run.blockage !== null)
      .filter((run) => {
        if (!query) return true;
        return [
          run.runId,
          run.workflowName,
          run.runTarget,
          run.blockage?.context,
          run.run?.phase,
          currentNodeLabel(run),
        ]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(query));
      });
  }, [runsState.data, status, target, blockedOnly, localSearch]);

  useEffect(() => {
    if (selectedId && rows.some((run) => run.runId === selectedId)) return;
    setSelectedId(rows[0]?.runId ?? null);
  }, [rows, selectedId]);

  const selected = rows.find((run) => run.runId === selectedId) ?? null;
  const counts = summarizeRuns(runsState.data?.runs ?? []);
  const groups = groupRuns(rows);
  const page = runsState.data?.page ?? null;
  const countScopeLabel = page?.truncated ? " on page" : "";

  return (
    <div className="content-split runs-screen">
      <div className="content-scroll runs-main">
        <div className="toolbar runs-toolbar">
          <div className="toolbar-left runs-filters">
            <div className="runs-search-field">
              <TextInput
                value={localSearch}
                onChange={(event) => setLocalSearch(event.target.value)}
                placeholder="Filter runs"
                aria-label="Filter runs"
              />
            </div>
            <Select
              value={status}
              onChange={(event) => setStatus(event.target.value as RunStatus | "all")}
              aria-label="Status filter"
            >
              {STATUS_FILTERS.map((value) => (
                <option value={value} key={value}>
                  {value === "all" ? "All statuses" : statusLabel(value)}
                </option>
              ))}
            </Select>
            <Select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              aria-label="Target filter"
            >
              <option value="all">all targets</option>
              {targetOptions.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </Select>
            <Toggle label="Blocked" checked={blockedOnly} onChange={setBlockedOnly} />
          </div>
          <div className="toolbar-right runs-summary">
            <span className="runs-live-state">
              <StatusPill tone="running" dot>
                Live
              </StatusPill>
            </span>
            <StatusPill tone="running">
              {counts.active} active{countScopeLabel}
            </StatusPill>
            <StatusPill tone="waiting">
              {counts.blocked} blocked{countScopeLabel}
            </StatusPill>
            <StatusPill tone={page?.truncated ? "waiting" : "neutral"}>
              {page?.truncated ? `${page.returned} shown` : `${counts.total} total`}
            </StatusPill>
            <span className="runs-local-refresh">
              <Button icon={RefreshCw} size="sm" onClick={runsState.reload}>
                {runsState.refreshing ? "Refreshing" : "Refresh"}
              </Button>
            </span>
          </div>
        </div>
        {page?.truncated ? (
          <div className="notice-panel">
            <span>
              Showing the latest {page.returned} of {page.total} runs.
            </span>
            {pageLimit < page.maxLimit ? (
              <Button
                icon={Plus}
                size="sm"
                onClick={() =>
                  setPageLimit(Math.min(page.maxLimit, pageLimit + RUNS_PAGE_INCREMENT))
                }
              >
                Load older runs
              </Button>
            ) : (
              <span>The browser limit of {page.maxLimit} runs has been reached.</span>
            )}
          </div>
        ) : null}
        {runsState.loading && !runsState.data ? <LoadingState label="Loading runs" /> : null}
        {runsState.error && !runsState.data ? (
          <ErrorState error={runsState.error} onRetry={runsState.reload} />
        ) : null}
        {runsState.error && runsState.data ? (
          <div className="form-error" role="alert">
            Refresh failed: {runsState.error.message}
          </div>
        ) : null}
        {runsState.data ? (
          <div className="run-groups">
            {groups.map((group) => (
              <RunGroupTable
                group={group}
                selectedId={selectedId}
                onSelect={(runId) => {
                  if (window.matchMedia?.("(max-width: 980px)").matches) navigateToRun(runId);
                  else setSelectedId(runId);
                }}
                nowMs={nowMs}
                key={group.id}
              />
            ))}
            {rows.length === 0 ? (
              <EmptyState
                title="No runs found"
                detail="Adjust filters or provide an admin credential."
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <RunInspector run={selected} nowMs={nowMs} />
    </div>
  );
}

function RunGroupTable({
  group,
  selectedId,
  onSelect,
  nowMs,
}: {
  group: RunGroup;
  selectedId: string | null;
  onSelect(runId: string): void;
  nowMs: number;
}) {
  if (group.rows.length === 0) return null;

  return (
    <section className="run-group">
      <div className="section-header">
        <div className="section-header-left">
          <h2 className="section-title">{group.title}</h2>
          <StatusPill tone={group.id === "needs-decision" ? "waiting" : "neutral"}>
            {group.rows.length}
          </StatusPill>
        </div>
      </div>
      <DenseTable
        rows={group.rows}
        rowKey={(run) => run.runId}
        selectedKey={selectedId}
        onRowClick={(run) => onSelect(run.runId)}
        columns={columns(nowMs)}
      />
    </section>
  );
}

function RunInspector({ run, nowMs }: { run: RunListItem | null; nowMs: number }) {
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

  const progress = progressForRun(run);

  return (
    <Inspector
      title={<span className="mono">{run.runId}</span>}
      subtitle={run.workflowName ?? "unnamed workflow"}
      status={
        <StatusPill tone={toneForStatus(run.status)} dot>
          {statusLabel(run.status)}
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
      <KeyFacts run={run} nowMs={nowMs} />
      <section className="inspector-section">
        <h3>Progress</h3>
        <div className="progress-bar" aria-label="Run node progress">
          <span style={{ width: `${progress.percent}%` }} />
        </div>
        <p>
          {progress.completed} / {progress.total} projected nodes completed
        </p>
      </section>
      {run.blockage ? (
        <section className="inspector-section">
          <h3>Blockage</h3>
          <p>{run.blockage.context}</p>
          <StatusPill tone={toneForStatus(run.blockage.reason)}>
            {statusLabel(run.blockage.reason)}
          </StatusPill>
        </section>
      ) : null}
      <section className="inspector-section">
        <h3>Latest Nodes</h3>
        <div className="mini-node-list">
          {(run.run?.nodes ?? []).slice(-6).map((node) => (
            <span className="mini-node-row" key={`${node.stableKey}:${node.attempt}`}>
              <span className="mono">{node.stableKey}</span>
              <StatusPill tone={toneForStatus(node.status)}>{statusLabel(node.status)}</StatusPill>
            </span>
          ))}
          {(run.run?.nodes.length ?? 0) === 0 ? <span className="muted">No nodes yet.</span> : null}
        </div>
      </section>
    </Inspector>
  );
}

function KeyFacts({ run, nowMs }: { run: RunListItem; nowMs: number }) {
  return (
    <dl className="kv-list">
      <div className="kv-row">
        <dt>Created</dt>
        <dd>{formatTime(run.createdAtMs)}</dd>
      </div>
      <div className="kv-row">
        <dt>Duration</dt>
        <dd>{formatDuration(run.createdAtMs, run.finishedAtMs, nowMs)}</dd>
      </div>
      <div className="kv-row">
        <dt>Target</dt>
        <dd className="mono">{run.runTarget ?? "-"}</dd>
      </div>
      <div className="kv-row">
        <dt>Current</dt>
        <dd className="mono">{currentNodeLabel(run) ?? run.run?.phase ?? "-"}</dd>
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
  );
}

function columns(nowMs: number): Array<Column<RunListItem>> {
  return [
    {
      key: "run",
      header: "Run",
      width: "156px",
      render: (run) => (
        <div className="run-cell">
          <StatusPill tone={toneForStatus(run.status)} dot>
            {watchableRun(run) ? "live" : "done"}
          </StatusPill>
          <a
            className="mono inline-link"
            href={`#/runs/${encodeURIComponent(run.runId)}`}
            onClick={(event) => event.stopPropagation()}
          >
            {run.runId}
          </a>
        </div>
      ),
    },
    {
      key: "workflow",
      header: "Workflow",
      render: (run) => (
        <div className="cell-stack">
          <strong>{run.workflowName ?? "unnamed"}</strong>
          <span>{run.run?.phase ?? run.run?.definitionVersion ?? "-"}</span>
        </div>
      ),
    },
    {
      key: "target",
      header: "Target",
      width: "124px",
      className: "run-table-secondary",
      render: (run) => <span className="mono text-truncate">{run.runTarget ?? "-"}</span>,
    },
    {
      key: "current",
      header: "Current / Blockage",
      className: "run-table-secondary",
      render: (run) => (
        <div className="cell-stack">
          <span className="text-truncate">
            {run.blockage?.context ?? currentNodeLabel(run) ?? "-"}
          </span>
          {run.blockage?.blockedOn ? (
            <span className="mono">{run.blockage.blockedOn.stableKey}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "136px",
      className: "run-table-compact-hidden",
      render: (run) => (
        <StatusPill tone={toneForStatus(run.status)} dot>
          {statusLabel(run.status)}
        </StatusPill>
      ),
    },
    {
      key: "workspaces",
      header: "Ws",
      width: "58px",
      className: "run-table-compact-hidden",
      align: "right",
      render: (run) => run.workspaceSummary.count,
    },
    {
      key: "age",
      header: "Duration",
      width: "96px",
      render: (run) => formatDuration(run.createdAtMs, run.finishedAtMs, nowMs),
    },
    {
      key: "actions",
      header: "",
      width: "68px",
      className: "run-table-compact-hidden",
      align: "right",
      render: (run) => (
        <div className="row-actions">
          <button
            type="button"
            aria-label={`Copy ${run.runId}`}
            title="Copy run id"
            onClick={(event) => {
              event.stopPropagation();
              void copyTextToClipboard(run.runId);
            }}
          >
            <Copy size={14} />
          </button>
          <button
            type="button"
            aria-label={`Open ${run.runId}`}
            title="Open run"
            onClick={(event) => {
              event.stopPropagation();
              navigateToRun(run.runId);
            }}
          >
            <ExternalLink size={14} />
          </button>
        </div>
      ),
    },
  ];
}

function groupRuns(rows: RunListItem[]): RunGroup[] {
  const groups: RunGroup[] = [
    {
      id: "needs-decision",
      title: "Needs Decision",
      rows: rows.filter(
        (run) => run.status === "waiting-human" || run.blockage?.reason === "waiting_human",
      ),
    },
    {
      id: "active",
      title: "Active",
      rows: rows.filter(
        (run) =>
          !isNeedsDecision(run) &&
          (run.status === "running" ||
            run.status.startsWith("waiting") ||
            run.status === "interrupted"),
      ),
    },
    {
      id: "finished",
      title: "Recently Finished",
      rows: rows.filter((run) =>
        ["finished", "failed", "cancelled", "continued"].includes(run.status),
      ),
    },
  ];
  return groups.sort((a, b) => newestCreatedAt(b.rows) - newestCreatedAt(a.rows));
}

function isNeedsDecision(run: RunListItem): boolean {
  return run.status === "waiting-human" || run.blockage?.reason === "waiting_human";
}

function summarizeRuns(runs: RunListItem[]): { active: number; blocked: number; total: number } {
  return {
    active: runs.filter((run) => watchableRun(run)).length,
    blocked: runs.filter((run) => run.blockage !== null).length,
    total: runs.length,
  };
}

function targetValues(runs: RunListItem[]): string[] {
  return [...new Set(runs.map((run) => run.runTarget ?? "untargeted"))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function currentNodeLabel(run: RunListItem): string | null {
  const pending = run.run?.nodes.find((node) => node.status === "pending");
  if (pending) return pending.stableKey;
  const latest = run.run?.nodes.at(-1);
  return latest?.stableKey ?? null;
}

function progressForRun(run: RunListItem): { completed: number; total: number; percent: number } {
  const nodes = run.run?.nodes ?? [];
  const completed = nodes.filter((node) => node.status === "completed").length;
  const total = nodes.length;
  return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

function watchableRun(run: RunListItem): boolean {
  return (
    run.status === "running" || run.status.startsWith("waiting") || run.status === "interrupted"
  );
}

function newestCreatedAt(rows: RunListItem[]): number {
  return rows.reduce((newest, run) => Math.max(newest, run.createdAtMs), 0);
}

function navigateToRun(runId: string): void {
  window.location.hash = `#/runs/${encodeURIComponent(runId)}`;
}

function copyText(value: string): void {
  void copyTextToClipboard(value);
}

function readRunFilters(): RunFilters {
  const queryText = window.location.hash.split("?", 2)[1] ?? "";
  const params = new URLSearchParams(queryText);
  const statusValue = params.get("status");
  const status = STATUS_FILTERS.includes(statusValue as RunStatus | "all")
    ? (statusValue as RunStatus | "all")
    : "all";
  const limitValue = Number(params.get("limit"));
  return {
    status,
    target: params.get("target") || "all",
    blockedOnly: params.get("blocked") === "1",
    query: params.get("q") ?? "",
    limit:
      Number.isSafeInteger(limitValue) && limitValue >= WEB_RUNS_DEFAULT_LIMIT
        ? limitValue
        : WEB_RUNS_DEFAULT_LIMIT,
  };
}

function writeRunFilters(filters: RunFilters): void {
  const params = new URLSearchParams();
  if (filters.query.trim()) params.set("q", filters.query.trim());
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.target !== "all") params.set("target", filters.target);
  if (filters.blockedOnly) params.set("blocked", "1");
  if (filters.limit !== WEB_RUNS_DEFAULT_LIMIT) params.set("limit", String(filters.limit));
  const query = params.toString();
  window.history.replaceState(null, "", `#/runs${query ? `?${query}` : ""}`);
}
