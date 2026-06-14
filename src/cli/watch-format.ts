import { redactCapabilityTokensInValue } from "../auth/redaction.ts";
import type { EventEnvelope } from "../rpc/contract.ts";
import { compactTerminalText, sanitizeTerminalInlineText } from "./terminal-text.ts";

export interface WatchFormatOptions {
  output?: "json" | "text" | "ndjson";
  tools?: boolean;
}

export interface WatchTextFormatter {
  push(event: EventEnvelope): string[];
  flush(): string[];
}

export type WatchStreamType = "text" | "reasoning";

export interface WatchStreamIdentity {
  keyId: string;
  type: WatchStreamType;
  label: string;
}

interface StreamChunk extends WatchStreamIdentity {
  text: string;
}

interface ActiveStream {
  keyId: string;
  type: WatchStreamType;
  endedWithNewline: boolean;
}

export function createTextWatchFormatter(opts: WatchFormatOptions = {}): WatchTextFormatter {
  let active: ActiveStream | null = null;

  const flush = (): string[] => {
    if (!active) return [];
    const needsNewline = !active.endedWithNewline;
    active = null;
    return needsNewline ? ["\n"] : [];
  };

  return {
    push(event: EventEnvelope): string[] {
      const safeEvent = redactCapabilityTokensInValue(event);
      if (isHiddenToolEvent(safeEvent, opts)) return [];

      const stream = streamChunk(safeEvent);
      if (stream && stream.text.length === 0) return [];
      if (stream) {
        const chunks: string[] = [];
        if (!active || active.keyId !== stream.keyId || active.type !== stream.type) {
          chunks.push(...flush());
          chunks.push(`${eventPrefix(safeEvent)} ${stream.label}: `);
          active = { keyId: stream.keyId, type: stream.type, endedWithNewline: false };
        }
        chunks.push(stream.text);
        active.endedWithNewline = stream.text.endsWith("\n");
        return chunks;
      }

      const line = formatTextWatchEvent(safeEvent, opts);
      if (line.length === 0) return [];
      return [...flush(), line];
    },
    flush,
  };
}

export function formatNdjsonWatchEvent(event: EventEnvelope): string {
  return `${JSON.stringify(redactCapabilityTokensInValue(event))}\n`;
}

export function formatWatchEvent(event: EventEnvelope, opts: WatchFormatOptions = {}): string {
  if ((opts.output ?? "text") === "ndjson") return formatNdjsonWatchEvent(event);
  const formatter = createTextWatchFormatter(opts);
  return [...formatter.push(event), ...formatter.flush()].join("");
}

function streamChunk(event: EventEnvelope): StreamChunk | null {
  const identity = watchStreamIdentity(event);
  if (!identity) return null;
  const data = prop(prop(event.payload, "event"), "data");
  if (typeof data !== "string") return null;
  return { ...identity, text: sanitizeInlineText(data) };
}

export function watchStreamIdentity(event: EventEnvelope): WatchStreamIdentity | null {
  if (event.type !== "agent.event") return null;
  const payload = event.payload;
  const key = prop(payload, "key");
  const innerEvent = prop(payload, "event");
  const traceType = prop(innerEvent, "type");
  if (traceType !== "text" && traceType !== "reasoning") return null;
  if (typeof prop(innerEvent, "data") !== "string") return null;

  const parts = ["agent"];
  if (hasContent(key)) parts.push(compact(key));
  parts.push(traceType);
  return {
    keyId: hasContent(key) ? streamKeyId(key) : "",
    type: traceType,
    label: parts.join(" "),
  };
}

function formatTextWatchEvent(event: EventEnvelope, opts: WatchFormatOptions): string {
  const prefix = eventPrefix(event);
  const payload = event.payload;
  switch (event.type) {
    case "agent.event":
      if (!opts.tools && isToolTracePayload(payload)) return "";
      return `${prefix} ${formatAgentEvent(payload)}\n`;
    case "agent.message":
      return `${prefix} ${formatAgentMessage(payload)}\n`;
    case "agent.tool_call":
      if (!opts.tools) return "";
      return `${prefix} ${formatAgentTranscriptEvent(payload, "tool_call")}\n`;
    case "agent.tool_result":
      if (!opts.tools) return "";
      return `${prefix} ${formatAgentTranscriptEvent(payload, "tool_result")}\n`;
    case "phase": {
      const title = prop(payload, "title");
      return `${prefix} phase${title ? `: ${compact(title)}` : ""}\n`;
    }
    case "log": {
      const message = prop(payload, "message");
      const data = prop(payload, "data");
      return `${prefix} log${message ? `: ${compact(message)}` : ""}${
        hasContent(data) ? ` ${compact(data)}` : ""
      }\n`;
    }
    case "step.completed": {
      const stableKey = prop(payload, "stableKey");
      const effectType = prop(payload, "effectType");
      return `${prefix} step.completed${stableKey ? ` ${compact(stableKey)}` : ""}${
        effectType ? ` (${compact(effectType)})` : ""
      }\n`;
    }
    case "run.parked": {
      const kind = prop(payload, "kind");
      const key = prop(payload, "key");
      return `${prefix} run.parked${kind ? ` ${compact(kind)}` : ""}${
        key ? ` ${compact(key)}` : ""
      }\n`;
    }
    case "run.interrupted": {
      const reason = prop(payload, "reason");
      return `${prefix} run.interrupted${reason ? `: ${compact(reason)}` : ""}\n`;
    }
    case "run.failed": {
      const message = prop(payload, "message") ?? prop(payload, "error");
      return `${prefix} run.failed${message ? `: ${compact(message)}` : formatPayload(payload)}\n`;
    }
    default:
      return `${prefix} ${event.type}${formatPayload(payload)}\n`;
  }
}

function eventPrefix(event: EventEnvelope): string {
  return event.kind === "durable" ? `[${event.seq}]` : "[live]";
}

function isHiddenToolEvent(event: EventEnvelope, opts: WatchFormatOptions): boolean {
  if (opts.tools) return false;
  if (event.type === "agent.tool_call" || event.type === "agent.tool_result") return true;
  return event.type === "agent.event" && isToolTracePayload(event.payload);
}

function isToolTracePayload(payload: unknown): boolean {
  const traceType = prop(prop(payload, "event"), "type");
  return traceType === "tool_call" || traceType === "tool_result";
}

function formatAgentMessage(payload: unknown): string {
  const key = prop(payload, "key");
  const text = prop(payload, "text");
  const omitted = prop(payload, "omitted");
  const byteLength = prop(payload, "byteLength");
  const label = key ? `agent ${compact(key)} message` : "agent message";
  if (omitted) return `${label}: omitted ${compact(byteLength ?? 0)} bytes`;
  return hasContent(text) ? `${label}: ${compact(text)}` : `${label}${formatPayload(payload)}`;
}

function formatAgentTranscriptEvent(payload: unknown, kind: "tool_call" | "tool_result"): string {
  const key = prop(payload, "key");
  const data = prop(payload, "data");
  const omitted = prop(payload, "omitted");
  const byteLength = prop(payload, "byteLength");
  const label = key ? `agent ${compact(key)} ${kind}` : `agent ${kind}`;
  if (omitted) return `${label}: omitted ${compact(byteLength ?? 0)} bytes`;
  return hasContent(data) ? `${label}: ${compact(data)}` : `${label}${formatPayload(payload)}`;
}

function formatAgentEvent(payload: unknown): string {
  const key = prop(payload, "key");
  const event = prop(payload, "event");
  const traceType = prop(event, "type");
  const data = prop(event, "data");
  const parts = ["agent"];
  if (key) parts.push(compact(key));
  if (traceType) parts.push(compact(traceType));
  const label = parts.join(" ");
  if (!key && !traceType && !hasContent(data)) return `${label}: ${compact(payload)}`;
  if (!traceType && hasContent(event)) return `${label}: ${compact(event)}`;
  return hasContent(data) ? `${label}: ${compact(data)}` : label;
}

function formatPayload(payload: unknown): string {
  return hasContent(payload) ? ` ${compact(payload)}` : "";
}

function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function streamKeyId(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasContent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function compact(value: unknown, max = 300): string {
  return compactTerminalText(value, max);
}

function sanitizeInlineText(value: string): string {
  return sanitizeTerminalInlineText(value);
}
