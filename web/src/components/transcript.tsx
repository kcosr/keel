import type { EventStreamFrame } from "../api/types";
import { summarizeTranscriptRowForDebug, webDebug } from "../lib/debug";
import { StatusPill, formatTime, toneForStatus } from "./controls";

function formatClock(value: number | null): string {
  if (value === null) return "-";
  return new Date(value).toLocaleTimeString();
}

// Display truncation happens at render so the full text stays available as a
// hover tooltip; MESSAGE_TITLE_MAX bounds the tooltip for very large payloads.
const MESSAGE_DISPLAY_MAX = 600;
const MESSAGE_TITLE_MAX = 4000;
const COALESCED_TRANSCRIPT_CACHE = new WeakMap<EventStreamFrame[], TranscriptRow[]>();

export interface RawEventFrame {
  event: string;
  data: unknown;
  raw?: string;
  source: "tail" | "live";
  receivedAtMs: number;
}

interface TranscriptRow {
  id: string;
  time: number | null;
  actor: string;
  event: string;
  message: string;
  seq: string;
  tone: "success" | "running" | "waiting" | "failed" | "info" | "neutral" | "future";
}

interface ActiveStream {
  row: TranscriptRow;
  keyId: string;
  type: "text" | "reasoning";
}

export function Transcript({
  events,
  compact = false,
  maxRows,
}: { events: EventStreamFrame[]; compact?: boolean; maxRows?: number }) {
  const rows = coalesceTranscript(events);
  const visibleRows = maxRows === undefined ? rows : maxRows <= 0 ? [] : rows.slice(-maxRows);
  if (visibleRows.length === 0) {
    return <div className="table-empty">No transcript events in the current tail.</div>;
  }

  return (
    <div
      className={`transcript-table ${compact ? "is-compact" : ""}`}
      aria-label="Coalesced transcript"
    >
      <div className="transcript-head">
        <span>Time</span>
        {compact ? null : <span>Actor</span>}
        <span>Event</span>
        <span>Message</span>
        {compact ? null : <span>Seq</span>}
      </div>
      {visibleRows.map((row) => {
        const truncated = row.message.length > MESSAGE_DISPLAY_MAX;
        const shown = truncated ? `${row.message.slice(0, MESSAGE_DISPLAY_MAX - 1)}…` : row.message;
        return (
          <div className="transcript-row" key={row.id}>
            <span className="mono muted" title={formatTime(row.time)}>
              {formatClock(row.time)}
            </span>
            {compact ? null : <span className="transcript-actor">{row.actor}</span>}
            <StatusPill tone={row.tone}>{row.event}</StatusPill>
            <span
              className={`transcript-message${truncated ? " is-truncated" : ""}`}
              title={truncated ? row.message.slice(0, MESSAGE_TITLE_MAX) : undefined}
            >
              {shown}
            </span>
            {compact ? null : <span className="mono muted">{row.seq}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function RawEventList({ frames }: { frames: RawEventFrame[] }) {
  if (frames.length === 0) {
    return <div className="table-empty">No raw events in the current tail.</div>;
  }

  return (
    <div className="event-list" aria-label="Raw event frames">
      {frames.map((frame, index) => (
        <div className="event-row" key={`${frame.source}:${frame.event}:${index}`}>
          <div className="event-time mono">{formatTime(frame.receivedAtMs)}</div>
          <div className="event-badges">
            <StatusPill tone={frame.source === "live" ? "running" : "neutral"}>
              {frame.source}
            </StatusPill>
            <StatusPill tone={toneForStatus(frame.event)}>{frame.event}</StatusPill>
          </div>
          <pre>{frame.raw ?? JSON.stringify(frame.data, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}

export function coalesceTranscript(events: EventStreamFrame[]): TranscriptRow[] {
  const cached = COALESCED_TRANSCRIPT_CACHE.get(events);
  if (cached) return cached;
  const rows: TranscriptRow[] = [];
  let active: ActiveStream | null = null;

  events.forEach((event, index) => {
    const chunk = streamChunk(event);
    if (chunk && chunk.text.length > 0) {
      if (active && active.keyId === chunk.keyId && active.type === chunk.type) {
        active.row.message = `${active.row.message}${chunk.text}`;
        active.row.time = eventTime(event);
        active.row.seq = eventSeq(event);
        return;
      }
      const row: TranscriptRow = {
        id: `stream:${index}`,
        time: eventTime(event),
        actor: chunk.actor,
        event: chunk.type,
        message: chunk.text,
        seq: eventSeq(event),
        tone: chunk.type === "reasoning" ? "info" : "running",
      };
      rows.push(row);
      active = { row, keyId: chunk.keyId, type: chunk.type };
      return;
    }

    active = null;
    const row = eventRow(event, index);
    if (row) rows.push(row);
  });

  webDebug("transcript", "coalesced", () => ({
    events: events.length,
    rows: rows.length,
    rowSummary: rows.map(summarizeTranscriptRowForDebug),
  }));
  COALESCED_TRANSCRIPT_CACHE.set(events, rows);
  return rows;
}

function eventRow(event: EventStreamFrame, index: number): TranscriptRow | null {
  if (event.kind === "control") {
    return {
      id: `control:${event.type}:${index}`,
      time: null,
      actor: "stream",
      event: event.type,
      message: controlMessage(event),
      seq: String(event.cursor.seq),
      tone: event.type === "authorization.failed" ? "failed" : "info",
    };
  }

  if (event.type === "agent.event" && isToolTracePayload(event.payload)) {
    const key = prop(event.payload, "key");
    const inner = prop(event.payload, "event");
    const traceType = prop(inner, "type");
    return {
      id: `event:${eventSeq(event)}:${index}`,
      time: event.atMs,
      actor: actorName(key, "agent"),
      event: typeof traceType === "string" ? traceType : event.type,
      message: compact(prop(inner, "data") ?? inner ?? event.payload),
      seq: eventSeq(event),
      tone: "neutral",
    };
  }

  const payload = event.payload;
  switch (event.type) {
    case "agent.message":
      return {
        id: `event:${eventSeq(event)}:${index}`,
        time: event.atMs,
        actor: actorName(prop(payload, "key"), "agent"),
        event: "message",
        message: agentMessage(payload),
        seq: eventSeq(event),
        tone: "running",
      };
    case "agent.tool_call":
    case "agent.tool_result":
      return {
        id: `event:${eventSeq(event)}:${index}`,
        time: event.atMs,
        actor: actorName(prop(payload, "key"), "tool"),
        event: event.type.replace("agent.", ""),
        message: compact(prop(payload, "data") ?? payload),
        seq: eventSeq(event),
        tone: "neutral",
      };
    case "phase":
      return basicRow(event, index, "system", "phase", compact(prop(payload, "title") ?? payload));
    case "log":
      return basicRow(
        event,
        index,
        "system",
        "log",
        [compact(prop(payload, "message")), compact(prop(payload, "data"))]
          .filter(Boolean)
          .join(" "),
      );
    case "step.completed":
      return basicRow(
        event,
        index,
        "workflow",
        event.type,
        compact(
          [prop(payload, "stableKey"), prop(payload, "effectType")].filter(Boolean).join(" "),
        ),
      );
    default:
      return basicRow(event, index, actorForEvent(event.type), event.type, compact(payload));
  }
}

function basicRow(
  event: Exclude<EventStreamFrame, { kind: "control" }>,
  index: number,
  actor: string,
  type: string,
  message: string,
): TranscriptRow {
  return {
    id: `event:${eventSeq(event)}:${index}`,
    time: event.atMs,
    actor,
    event: type,
    message,
    seq: eventSeq(event),
    tone: toneForStatus(type),
  };
}

function streamChunk(
  event: EventStreamFrame,
): { keyId: string; type: "text" | "reasoning"; text: string; actor: string } | null {
  if (event.kind === "control" || event.type !== "agent.event") return null;
  const payload = event.payload;
  const inner = prop(payload, "event");
  const traceType = prop(inner, "type");
  const text = prop(inner, "data");
  if ((traceType !== "text" && traceType !== "reasoning") || typeof text !== "string") {
    return null;
  }
  const key = prop(payload, "key");
  return {
    keyId: typeof key === "string" ? key : JSON.stringify(key ?? ""),
    type: traceType,
    text: sanitizeInline(text),
    actor: actorName(key, "agent"),
  };
}

function eventTime(event: EventStreamFrame): number | null {
  return event.kind === "control" ? null : event.atMs;
}

function eventSeq(event: EventStreamFrame): string {
  if (event.kind === "durable") return String(event.seq);
  if (event.kind === "ephemeral") return "live";
  return String(event.cursor.seq);
}

function controlMessage(event: Extract<EventStreamFrame, { kind: "control" }>): string {
  if (event.type === "caught-up") return "Backfill caught up to the live cursor.";
  if (event.type === "closed") return `Stream closed with status ${event.status}.`;
  return event.payload.message;
}

function agentMessage(payload: unknown): string {
  if (prop(payload, "omitted")) return `omitted ${String(prop(payload, "byteLength") ?? 0)} bytes`;
  return compact(prop(payload, "text") ?? payload);
}

function actorForEvent(type: string): string {
  if (type.startsWith("run.")) return "run";
  if (type.startsWith("agent.")) return "agent";
  if (type.startsWith("workspace.")) return "workspace";
  return "system";
}

function actorName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isToolTracePayload(payload: unknown): boolean {
  const traceType = prop(prop(payload, "event"), "type");
  return traceType === "tool_call" || traceType === "tool_result";
}

function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function compact(value: unknown, max = MESSAGE_TITLE_MAX): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : safeStringify(value);
  if (!text) return "";
  const normalized = sanitizeInline(text).replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function sanitizeInline(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code >= 32;
    })
    .join("");
}
