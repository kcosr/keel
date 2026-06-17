import { Radio, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { EventStreamFrame, NodeView, RunDetailResponse } from "../api/types";
import { CodeViewer } from "../components/code-viewer";
import {
  Button,
  EmptyState,
  ErrorState,
  JsonBlock,
  KeyValueList,
  LoadingState,
  StatusPill,
  Tabs,
  formatTime,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { RunGraph } from "../components/graph";
import { Inspector } from "../components/inspector";
import { Transcript } from "../components/transcript";
import { useAsync } from "../hooks/use-async";

type RunTab =
  | "overview"
  | "timeline"
  | "transcript"
  | "report"
  | "source"
  | "workspaces"
  | "events";

const TABS: Array<{ id: RunTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "transcript", label: "Transcript" },
  { id: "report", label: "Report" },
  { id: "source", label: "Source" },
  { id: "workspaces", label: "Workspaces" },
  { id: "events", label: "Events" },
];

export function RunDetailScreen({
  client,
  runId,
  refreshKey,
}: {
  client: KeelWebClient;
  runId: string;
  refreshKey: number;
}) {
  const detailState = useAsync(() => client.getRun(runId), [client, runId, refreshKey]);
  const [tab, setTab] = useState<RunTab>("overview");
  const [live, setLive] = useState(false);
  const [liveFrames, setLiveFrames] = useState<Array<{ event: string; data: unknown }>>([]);

  useEffect(() => {
    if (!live) return;
    const stop = client.watchRunEvents(runId, {
      cursor: detailState.data?.eventCursor
        ? { kind: "after-seq", seq: detailState.data.eventCursor.seq }
        : { kind: "tail", count: 50 },
      onFrame: (frame) => setLiveFrames((frames) => [...frames.slice(-49), frame]),
      onError: (err) =>
        setLiveFrames((frames) => [
          ...frames.slice(-49),
          { event: "error", data: err instanceof Error ? err.message : String(err) },
        ]),
    });
    return stop;
  }, [client, runId, live, detailState.data?.eventCursor]);

  const detail = detailState.data;

  return (
    <div className="content-split run-detail-screen">
      <div className="content-scroll">
        <div className="toolbar">
          <div className="toolbar-left">
            <a className="inline-link" href="#/runs">
              Runs
            </a>
            <span className="mono">{runId}</span>
          </div>
          <div className="toolbar-right">
            <Button icon={RefreshCw} size="sm" onClick={detailState.reload}>
              Refresh
            </Button>
            <Button
              icon={Radio}
              size="sm"
              variant={live ? "primary" : "secondary"}
              onClick={() => setLive((value) => !value)}
            >
              Live
            </Button>
          </div>
        </div>
        {detailState.loading ? <LoadingState label="Loading run" /> : null}
        {detailState.error ? (
          <ErrorState error={detailState.error} onRetry={detailState.reload} />
        ) : null}
        {detail && !detailState.loading && !detailState.error ? (
          <>
            <Tabs<RunTab>
              tabs={TABS.map((item) => ({ ...item, count: tabCount(item.id, detail) }))}
              active={tab}
              onChange={setTab}
            />
            <div className="tab-panel">{renderTab(tab, detail)}</div>
          </>
        ) : null}
      </div>
      <RunDetailInspector detail={detail} liveFrames={liveFrames} />
    </div>
  );
}

function renderTab(tab: RunTab, detail: RunDetailResponse) {
  if (!detail.run) {
    return (
      <EmptyState title="Run not found" detail="The daemon did not return a run projection." />
    );
  }
  switch (tab) {
    case "overview":
      return (
        <div className="overview-grid">
          <section className="panel">
            <h2>Graph</h2>
            <RunGraph nodes={detail.run.nodes} />
          </section>
          <section className="panel">
            <h2>Summary</h2>
            <KeyValueList
              rows={[
                { label: "Workflow", value: detail.run.workflowName ?? "unnamed" },
                { label: "Phase", value: detail.run.phase ?? "-" },
                { label: "Definition", value: detail.run.definitionVersion, mono: true },
                { label: "Created", value: formatTime(detail.run.createdAtMs) },
                { label: "Finished", value: formatTime(detail.run.finishedAtMs) },
              ]}
            />
          </section>
        </div>
      );
    case "timeline":
      return <NodeTable nodes={detail.run.nodes} />;
    case "transcript":
    case "events":
      return <Transcript events={detail.events} />;
    case "report":
      return <JsonBlock value={detail.report ?? detail.run} />;
    case "source":
      return <CodeViewer source={detail.source} />;
    case "workspaces":
      return (
        <DenseTable
          rows={detail.workspaces}
          rowKey={(workspace) => workspace.workspaceId}
          empty="No retained workspaces"
          columns={[
            {
              key: "id",
              header: "Workspace",
              render: (workspace) => <span className="mono">{workspace.workspaceId}</span>,
            },
            { key: "mode", header: "Mode", width: "110px", render: (workspace) => workspace.mode },
            {
              key: "status",
              header: "Status",
              width: "120px",
              render: (workspace) => (
                <StatusPill tone={toneForStatus(workspace.status)}>{workspace.status}</StatusPill>
              ),
            },
            {
              key: "path",
              header: "Path",
              render: (workspace) => (
                <span className="mono text-truncate">{workspace.workspacePath}</span>
              ),
            },
          ]}
        />
      );
  }
}

function NodeTable({ nodes }: { nodes: NodeView[] }) {
  const columns: Array<Column<NodeView>> = [
    {
      key: "key",
      header: "Stable key",
      render: (node) => <span className="mono">{node.stableKey}</span>,
    },
    { key: "effect", header: "Effect", width: "120px", render: (node) => node.effectType },
    {
      key: "status",
      header: "Status",
      width: "130px",
      render: (node) => <StatusPill tone={toneForStatus(node.status)}>{node.status}</StatusPill>,
    },
    {
      key: "attempt",
      header: "Attempt",
      width: "80px",
      align: "right",
      render: (node) => node.attempt,
    },
    { key: "deps", header: "Depends on", render: (node) => node.dependsOn.join(", ") || "root" },
  ];
  return (
    <DenseTable
      rows={nodes}
      rowKey={(node) => `${node.stableKey}:${node.attempt}`}
      columns={columns}
    />
  );
}

function RunDetailInspector({
  detail,
  liveFrames,
}: {
  detail: RunDetailResponse | null;
  liveFrames: Array<{ event: string; data: unknown }>;
}) {
  const run = detail?.run ?? null;
  const commands = detail?.availableCommands ?? [];

  return (
    <Inspector
      title={run ? <span className="mono">{run.runId}</span> : "Run detail"}
      subtitle={run?.workflowName ?? "No run loaded"}
      status={
        run ? (
          <StatusPill tone={toneForStatus(run.status)} dot>
            {run.status}
          </StatusPill>
        ) : null
      }
    >
      {run ? (
        <>
          <KeyValueList
            rows={[
              { label: "Created", value: formatTime(run.createdAtMs) },
              { label: "Target", value: run.runTarget ?? "-", mono: true },
              { label: "Steps", value: run.stats.steps },
              { label: "Agents", value: run.stats.agents },
              { label: "Artifacts", value: run.stats.artifacts },
            ]}
          />
          {detail?.blockage ? (
            <section className="inspector-section">
              <h3>Blockage</h3>
              <p>{detail.blockage.context}</p>
            </section>
          ) : null}
          <section className="inspector-section">
            <h3>Commands</h3>
            <div className="command-list">
              {commands.map((command) => (
                <span className="command-row" key={command.name}>
                  <span>{command.name}</span>
                  <StatusPill tone="info">{command.requiredAuthority}</StatusPill>
                </span>
              ))}
            </div>
          </section>
          <section className="inspector-section">
            <h3>Live</h3>
            <div className="live-strip">
              {liveFrames.length === 0 ? (
                <span className="muted">No live frames in this session.</span>
              ) : null}
              {liveFrames.map((frame, index) => (
                <div className="live-frame" key={`${frame.event}:${index}`}>
                  <strong>{frame.event}</strong>
                  <pre>{JSON.stringify(frame.data, null, 2)}</pre>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        <EmptyState title="No run loaded" />
      )}
    </Inspector>
  );
}

function tabCount(tab: RunTab, detail: RunDetailResponse): number | undefined {
  if (tab === "timeline") return detail.run?.nodes.length ?? 0;
  if (tab === "workspaces") return detail.workspaces.length;
  if (tab === "events" || tab === "transcript") return detail.events.length;
  return undefined;
}
