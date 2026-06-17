import type { EventStreamFrame } from "../api/types";
import { StatusPill, formatTime, toneForStatus } from "./controls";

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

export function Transcript({ events }: { events: EventStreamFrame[] }) {
  const rows = coalesceTranscript(events);
  if (rows.length === 0) {
    return <div className="table-empty">No transcript events in the current tail.</div>;
  }

  return (
    <div className="transcript-table" aria-label="Coalesced transcript">
      <div className="transcript-head">
        <span>Time</span>
        <span>Actor</span>
        <span>Event</span>
        <span>Message</span>
        <span>Seq</span>
      </div>
      {rows.map((row) => (
        <div className="transcript-row" key={row.id}>
          <span className="mono muted">{formatTime(row.time)}</span>
          <span className="transcript-actor">{row.actor}</span>
          <StatusPill tone={row.tone}>{row.event}</StatusPill>
          <span className="transcript-message">{row.message}</span>
          <span className="mono muted">{row.seq}</span>
        </div>
      ))}
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
        compact([prop(payload, "message"), prop(payload, "data")].filter(Boolean).join(" ")),
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

function compact(value: unknown, max = 420): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  const normalized = sanitizeInline(text).replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

function sanitizeInline(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code >= 32;
    })
    .join("");
}
