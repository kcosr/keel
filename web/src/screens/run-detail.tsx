import { Check, Pause, Radio, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeelWebClient, WatchRunEventsStatus } from "../api/client";
import type { SseMessage } from "../api/sse";
import type { EventCursorInput, EventStreamFrame, NodeView, RunDetailResponse } from "../api/types";
import { CodeViewer } from "../components/code-viewer";
import {
  Button,
  EmptyState,
  ErrorState,
  JsonBlock,
  KeyValueList,
  LoadingState,
  Select,
  StatusPill,
  Tabs,
  type Tone,
  formatDuration,
  formatTime,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { NodeTimeline, RunGraph } from "../components/graph";
import { Inspector } from "../components/inspector";
import { type RawEventFrame, RawEventList, Transcript } from "../components/transcript";
import { useAsync } from "../hooks/use-async";

type RunTab =
  | "overview"
  | "timeline"
  | "transcript"
  | "report"
  | "source"
  | "workspaces"
  | "approvals"
  | "events";

type CursorMode = "current" | "tail" | "beginning" | "now";

interface StreamState {
  state: "idle" | WatchRunEventsStatus["state"];
  cursorSeq: number | null;
  message?: string;
}

const TABS: Array<{ id: RunTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "transcript", label: "Transcript" },
  { id: "report", label: "Report" },
  { id: "source", label: "Source" },
  { id: "workspaces", label: "Workspaces" },
  { id: "approvals", label: "Approvals" },
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
  const [cursorMode, setCursorMode] = useState<CursorMode>("current");
  const [liveEvents, setLiveEvents] = useState<EventStreamFrame[]>([]);
  const [rawLiveFrames, setRawLiveFrames] = useState<RawEventFrame[]>([]);
  const [streamState, setStreamState] = useState<StreamState>({
    state: "idle",
    cursorSeq: null,
  });
  const latestSeqRef = useRef<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runId must clear live buffers even when a new run has the same cursor sequence.
  useEffect(() => {
    latestSeqRef.current = null;
    setLiveEvents([]);
    setRawLiveFrames([]);
    setStreamState({ state: "idle", cursorSeq: null });
  }, [runId]);

  useEffect(() => {
    const seq = detailState.data?.eventCursor?.seq ?? null;
    if (seq === null) return;
    const nextSeq = Math.max(latestSeqRef.current ?? seq, seq);
    latestSeqRef.current = nextSeq;
    setStreamState((state) => ({ ...state, cursorSeq: nextSeq }));
  }, [detailState.data?.eventCursor?.seq]);

  useEffect(() => {
    if (!live) return;
    const stop = client.watchRunEvents(runId, {
      cursor: cursorInputForMode(cursorMode, detailState.data, latestSeqRef.current),
      onFrame: (frame) => {
        setRawLiveFrames((frames) => [
          ...frames.slice(-499),
          {
            event: frame.event,
            data: frame.data,
            raw: frame.raw,
            source: "live",
            receivedAtMs: Date.now(),
          },
        ]);
        const event = streamFrameFromSse(frame);
        if (event) setLiveEvents((events) => [...events.slice(-499), event]);
        if (shouldReloadProjection(frame)) detailState.reload();
        const seq = cursorSeqFromSse(frame);
        if (seq !== null) {
          latestSeqRef.current = seq;
          setStreamState((state) => ({ ...state, cursorSeq: seq }));
        }
      },
      onStatus: (status) => {
        const seq = seqFromCursorInput(status.cursor);
        if (seq !== null) latestSeqRef.current = seq;
        if (status.state === "closed") setLive(false);
        setStreamState({
          state: status.state,
          cursorSeq: seq ?? latestSeqRef.current,
          message: "reason" in status ? status.reason : undefined,
        });
      },
      onError: (err) => {
        setStreamState((state) => ({
          ...state,
          state: "reconnecting",
          message: err instanceof Error ? err.message : String(err),
        }));
      },
    });
    return stop;
  }, [client, cursorMode, detailState.data, detailState.reload, live, runId]);

  const detail = detailState.data;
  const allEvents = useMemo(
    () => mergeEventFrames(detail?.events ?? [], liveEvents),
    [detail?.events, liveEvents],
  );
  const rawFrames = useMemo(
    () => mergeRawFrames(tailRawFrames(detail?.events ?? []), rawLiveFrames),
    [detail?.events, rawLiveFrames],
  );

  return (
    <div className="content-split run-detail-screen">
      <div className="content-scroll">
        <div className="toolbar run-detail-toolbar">
          <div className="toolbar-left">
            <a className="inline-link" href="#/runs">
              Runs
            </a>
            <span className="mono">{runId}</span>
            <StatusPill tone={streamTone(streamState, live)} dot>
              {streamLabel(streamState, live)}
            </StatusPill>
          </div>
          <div className="toolbar-right">
            <Select
              value={cursorMode}
              onChange={(event) => setCursorMode(event.target.value as CursorMode)}
              aria-label="Watch cursor"
            >
              <option value="current">Current cursor</option>
              <option value="tail">Tail 100</option>
              <option value="beginning">Beginning</option>
              <option value="now">Now</option>
            </Select>
            <Button icon={RefreshCw} size="sm" onClick={detailState.reload}>
              Refresh
            </Button>
            <Button
              icon={live ? Pause : Radio}
              size="sm"
              variant={live ? "primary" : "secondary"}
              onClick={() => setLive((value) => !value)}
            >
              {live ? "Pause live" : "Watch live"}
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
              tabs={TABS.map((item) => ({ ...item, count: tabCount(item.id, detail, allEvents) }))}
              active={tab}
              onChange={setTab}
            />
            <div className="tab-panel">
              {renderTab(tab, detail, allEvents, rawFrames, setTab, client, detailState.reload)}
            </div>
          </>
        ) : null}
      </div>
      <RunDetailInspector
        detail={detail}
        live={live}
        streamState={streamState}
        events={allEvents}
      />
    </div>
  );
}

function renderTab(
  tab: RunTab,
  detail: RunDetailResponse,
  events: EventStreamFrame[],
  rawFrames: RawEventFrame[],
  setTab: (tab: RunTab) => void,
  client: KeelWebClient,
  reload: () => void,
) {
  if (!detail.run) {
    return (
      <EmptyState title="Run not found" detail="The daemon did not return a run projection." />
    );
  }
  switch (tab) {
    case "overview":
      return (
        <div className="overview-grid">
          <section className="panel panel-wide">
            <div className="panel-heading">
              <h2>Graph</h2>
              <span className="muted">Projection nodes and dependency edges</span>
            </div>
            <RunGraph nodes={detail.run.nodes} />
          </section>
          <section className="panel">
            <h2>Summary</h2>
            <KeyValueList
              rows={[
                { label: "Workflow", value: detail.run.workflowName ?? "unnamed" },
                { label: "Status", value: detail.run.status },
                { label: "Phase", value: detail.run.phase ?? "-" },
                { label: "Definition", value: detail.run.definitionVersion, mono: true },
                { label: "Created", value: formatTime(detail.run.createdAtMs) },
                {
                  label: "Duration",
                  value: formatDuration(detail.run.createdAtMs, detail.run.finishedAtMs),
                },
              ]}
            />
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Recent Transcript</h2>
              <button className="inline-link" type="button" onClick={() => setTab("transcript")}>
                Open transcript
              </button>
            </div>
            <Transcript events={events.slice(-8)} />
          </section>
        </div>
      );
    case "timeline":
      return (
        <div className="timeline-grid">
          <NodeTimeline nodes={detail.run.nodes} />
          <NodeTable nodes={detail.run.nodes} />
        </div>
      );
    case "transcript":
      return <Transcript events={events} />;
    case "report":
      return <JsonBlock value={detail.report ?? detail.run} />;
    case "source":
      return <CodeViewer source={detail.source} />;
    case "workspaces":
      return <WorkspacesTable detail={detail} />;
    case "approvals":
      return <ApprovalPanel detail={detail} client={client} onChanged={reload} />;
    case "events":
      return <RawEventList frames={rawFrames} />;
  }
}

function WorkspacesTable({ detail }: { detail: RunDetailResponse }) {
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

function ApprovalPanel({
  detail,
  client,
  onChanged,
}: { detail: RunDetailResponse; client: KeelWebClient; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = detail.run;
  const blockage = detail.blockage;
  if (!run || blockage?.reason !== "waiting_human") {
    return (
      <EmptyState
        title="No run-local approval is waiting"
        detail="The current projection does not expose a waiting ctx.human gate for this run."
      />
    );
  }

  const gate = blockage.blockedOn?.stableKey ?? "<gate>";
  const prompt = blockage.context.replace(/^awaiting decision: /, "");
  const approve = `keel approve ${run.runId} ${gate}`;
  const deny = `keel deny ${run.runId} ${gate}`;
  const canDecide = detail.availableCommands.some((command) => command.name === "decideApproval");
  const decide = async (status: "approved" | "denied") => {
    if (!canDecide || gate === "<gate>" || pending) return;
    setPending(status);
    setError(null);
    setMessage(null);
    try {
      await client.decideApproval(run.runId, gate, {
        status,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNote("");
      setMessage(`${status === "approved" ? "Approved" : "Denied"} ${gate}`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="approval-panel">
      <section className="panel">
        <h2>Waiting Human Gate</h2>
        <KeyValueList
          rows={[
            { label: "Gate", value: gate, mono: true },
            { label: "Prompt", value: prompt },
            { label: "Since", value: formatTime(blockage.blockedOn?.since) },
            { label: "Authority", value: "admin" },
          ]}
        />
        <div className="command-copy-grid">
          <button type="button" onClick={() => copyText(approve)}>
            <span>Copy approve command</span>
            <code>{approve}</code>
          </button>
          <button type="button" onClick={() => copyText(deny)}>
            <span>Copy deny command</span>
            <code>{deny}</code>
          </button>
        </div>
        <textarea
          className="field-textarea"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Decision note"
          aria-label="Decision note"
        />
        {!canDecide ? (
          <p className="muted">Approval decisions require admin authority for this run.</p>
        ) : null}
        {error ? <p className="form-error">{error}</p> : null}
        {message ? <p className="form-success">{message}</p> : null}
        <div className="btn-row">
          <Button
            icon={X}
            variant="danger"
            disabled={!canDecide || gate === "<gate>" || pending !== null}
            onClick={() => void decide("denied")}
          >
            {pending === "denied" ? "Denying" : "Deny"}
          </Button>
          <Button
            icon={Check}
            variant="primary"
            disabled={!canDecide || gate === "<gate>" || pending !== null}
            onClick={() => void decide("approved")}
          >
            {pending === "approved" ? "Approving" : "Approve"}
          </Button>
        </div>
      </section>
    </div>
  );
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
      key: "started",
      header: "Started",
      width: "180px",
      render: (node) => <span className="mono">{formatTime(node.startedAtMs)}</span>,
    },
    {
      key: "attempt",
      header: "Attempt",
      width: "80px",
      align: "right",
      render: (node) => node.attempt,
    },
    {
      key: "artifact",
      header: "Artifact",
      width: "90px",
      render: (node) => (node.artifactBacked ? "yes" : "no"),
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
  live,
  streamState,
  events,
}: {
  detail: RunDetailResponse | null;
  live: boolean;
  streamState: StreamState;
  events: EventStreamFrame[];
}) {
  const run = detail?.run ?? null;
  const commands = detail?.availableCommands ?? [];
  const latestEvents = events.slice(-6);

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
              { label: "Duration", value: formatDuration(run.createdAtMs, run.finishedAtMs) },
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
              <StatusPill tone={toneForStatus(detail.blockage.reason)}>
                {detail.blockage.reason}
              </StatusPill>
            </section>
          ) : null}
          <section className="inspector-section">
            <h3>Live Watch</h3>
            <div className="live-watch-box">
              <StatusPill tone={streamTone(streamState, live)} dot>
                {streamLabel(streamState, live)}
              </StatusPill>
              <span className="mono">cursor {streamState.cursorSeq ?? "-"}</span>
              {streamState.message ? <span className="muted">{streamState.message}</span> : null}
            </div>
          </section>
          <section className="inspector-section">
            <h3>Commands</h3>
            <div className="command-list">
              {commands.map((command) => (
                <button
                  className="command-row"
                  key={command.name}
                  type="button"
                  onClick={() => copyText(cliForCommand(command.name, run.runId))}
                >
                  <span>{command.name}</span>
                  <StatusPill tone="info">{command.requiredAuthority}</StatusPill>
                </button>
              ))}
            </div>
          </section>
          <section className="inspector-section">
            <h3>Latest Transcript</h3>
            <Transcript events={latestEvents} />
          </section>
        </>
      ) : (
        <EmptyState title="No run loaded" />
      )}
    </Inspector>
  );
}

function tabCount(
  tab: RunTab,
  detail: RunDetailResponse,
  events: EventStreamFrame[],
): number | undefined {
  if (tab === "timeline") return detail.run?.nodes.length ?? 0;
  if (tab === "workspaces") return detail.workspaces.length;
  if (tab === "events" || tab === "transcript") return events.length;
  if (tab === "approvals") return detail.blockage?.reason === "waiting_human" ? 1 : 0;
  return undefined;
}

function cursorInputForMode(
  mode: CursorMode,
  detail: RunDetailResponse | null,
  latestSeq: number | null,
): EventCursorInput {
  if (mode === "beginning") return { kind: "beginning" };
  if (mode === "now") return { kind: "now" };
  if (mode === "tail") return { kind: "tail", count: 100 };
  const loadedSeq = detail?.eventCursor?.seq ?? null;
  const seq =
    latestSeq === null && loadedSeq === null ? null : Math.max(latestSeq ?? 0, loadedSeq ?? 0);
  return typeof seq === "number" ? { kind: "after-seq", seq } : { kind: "tail", count: 100 };
}

export function mergeEventFrames(
  detailEvents: EventStreamFrame[],
  liveEvents: EventStreamFrame[],
): EventStreamFrame[] {
  return mergeOrderedFrames([
    ...orderEventFrames(detailEvents, 0),
    ...orderEventFrames(liveEvents, detailEvents.length),
  ]).map((item) => item.frame);
}

export function mergeRawFrames(
  tailFrames: RawEventFrame[],
  liveFrames: RawEventFrame[],
): RawEventFrame[] {
  return mergeOrderedFrames([
    ...orderRawFrames(tailFrames, 0),
    ...orderRawFrames(liveFrames, tailFrames.length),
  ]).map((item) => item.frame);
}

function streamFrameFromSse(frame: SseMessage): EventStreamFrame | null {
  const data = frame.data;
  if (isEventFrame(data)) return data;
  if (frame.event === "error") {
    return { kind: "ephemeral", type: "stream.error", payload: data, atMs: Date.now() };
  }
  return null;
}

function isEventFrame(value: unknown): value is EventStreamFrame {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = value.kind;
  if (kind === "durable") return "seq" in value && "type" in value;
  if (kind === "ephemeral") return "type" in value;
  if (kind === "control") return "type" in value && "cursor" in value;
  return false;
}

function cursorSeqFromSse(frame: SseMessage): number | null {
  const data = frame.data;
  if (!data || typeof data !== "object") return null;
  if ("kind" in data && data.kind === "durable" && "seq" in data && typeof data.seq === "number") {
    return data.seq;
  }
  if ("cursor" in data) {
    const cursor = data.cursor;
    if (cursor && typeof cursor === "object" && "seq" in cursor && typeof cursor.seq === "number") {
      return cursor.seq;
    }
  }
  return null;
}

function seqFromCursorInput(cursor: EventCursorInput): number | null {
  return cursor.kind === "after-seq" ? cursor.seq : null;
}

function tailRawFrames(events: EventStreamFrame[]): RawEventFrame[] {
  return events.map((event) => ({
    event: event.kind === "control" ? event.type : "event",
    data: event,
    source: "tail",
    receivedAtMs: event.kind === "control" ? Date.now() : event.atMs,
  }));
}

interface OrderedFrame<T> {
  frame: T;
  identity: string | null;
  order: number;
  position: number;
}

function mergeOrderedFrames<T>(frames: Array<OrderedFrame<T>>): Array<OrderedFrame<T>> {
  const latestByIdentity = new Map<string, OrderedFrame<T>>();
  for (const frame of frames) {
    if (frame.identity !== null) latestByIdentity.set(frame.identity, frame);
  }

  return frames
    .filter((frame) => frame.identity === null || latestByIdentity.get(frame.identity) === frame)
    .sort((a, b) => a.position - b.position || a.order - b.order);
}

function orderEventFrames(
  frames: EventStreamFrame[],
  offset: number,
): Array<OrderedFrame<EventStreamFrame>> {
  return orderFrames(frames, offset, eventPosition, eventIdentity);
}

function orderRawFrames(
  frames: RawEventFrame[],
  offset: number,
): Array<OrderedFrame<RawEventFrame>> {
  return orderFrames(frames, offset, rawFramePosition, rawFrameIdentity);
}

function orderFrames<T>(
  frames: T[],
  offset: number,
  knownPosition: (frame: T) => number | null,
  identity: (frame: T) => string | null,
): Array<OrderedFrame<T>> {
  const nextPositions = new Array<number | null>(frames.length);
  let next: number | null = null;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const position = knownPosition(frames[index] as T);
    nextPositions[index] = next;
    if (position !== null) next = position;
  }

  let previous: number | null = null;
  return frames.map((frame, index) => {
    const position = knownPosition(frame);
    const ordered = {
      frame,
      identity: identity(frame),
      order: offset + index,
      position: position ?? inferredPosition(previous, nextPositions[index] ?? null),
    };
    if (position !== null) previous = position;
    return ordered;
  });
}

function inferredPosition(previous: number | null, next: number | null): number {
  if (previous !== null && next !== null) {
    return next > previous ? previous + (next - previous) / 2 : previous + 0.5;
  }
  if (previous !== null) return previous + 0.5;
  if (next !== null) return next - 0.5;
  return Number.MAX_SAFE_INTEGER;
}

function eventPosition(event: EventStreamFrame): number | null {
  if (event.kind === "durable") return event.seq;
  if (event.kind === "control") return event.cursor.seq + 0.75;
  return null;
}

function rawFramePosition(frame: RawEventFrame): number | null {
  return isEventFrame(frame.data) ? eventPosition(frame.data) : null;
}

function eventIdentity(event: EventStreamFrame): string | null {
  if (event.kind === "durable") return `durable:${event.seq}`;
  if (event.kind === "control") return `control:${event.type}:${event.cursor.seq}`;
  return null;
}

function rawFrameIdentity(frame: RawEventFrame): string | null {
  return isEventFrame(frame.data) ? eventIdentity(frame.data) : null;
}

function streamTone(streamState: StreamState, live: boolean): Tone {
  if (!live && streamState.state !== "closed") return "neutral";
  switch (streamState.state) {
    case "caught-up":
    case "open":
      return "running";
    case "connecting":
    case "reconnecting":
      return "waiting";
    case "closed":
      return toneForClosedStream(streamState.message);
    default:
      return "neutral";
  }
}

function streamLabel(streamState: StreamState, live: boolean): string {
  if (!live && streamState.state !== "closed") return "not watching";
  if (streamState.state === "caught-up") return "caught up";
  if (streamState.state === "open") return "streaming";
  if (streamState.state === "reconnecting") return "reconnecting";
  if (streamState.state === "connecting") return "connecting";
  if (streamState.state === "closed") return "closed";
  return "idle";
}

function toneForClosedStream(reason: string | undefined): Tone {
  if (!reason || reason === "finished" || reason === "continued") return "success";
  if (reason === "interrupted" || reason === "parked" || reason.startsWith("waiting")) {
    return "waiting";
  }
  return "failed";
}

function shouldReloadProjection(frame: SseMessage): boolean {
  if (frame.event === "closed") return true;
  const data = frame.data;
  if (!data || typeof data !== "object" || !("kind" in data) || data.kind !== "durable") {
    return false;
  }
  const type = "type" in data ? data.type : null;
  return (
    type === "run.finished" ||
    type === "run.failed" ||
    type === "run.aborted" ||
    type === "run.interrupted" ||
    type === "run.continued" ||
    type === "run.parked"
  );
}

function cliForCommand(command: string, runId: string): string {
  if (command === "watchEvents") return `keel watch ${runId}`;
  if (command === "viewSource") return `keel workflow source --run ${runId}`;
  if (command === "decideApproval") return `keel approve ${runId} <gate>`;
  return `keel ${command} ${runId}`;
}

function copyText(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}
