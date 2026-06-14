import {
  createTextWatchFormatter,
  formatWatchEvent,
  watchStreamIdentity,
} from "../cli/watch-format.ts";
import type { EventEnvelope } from "../rpc/contract.ts";

export interface TuiFormattedEvent {
  lines: string[];
  appendToLastLine?: string;
  authorizationFailedMessage?: string;
}

interface ActiveStream {
  keyId: string;
  type: "text" | "reasoning";
  endedWithNewline: boolean;
}

export interface TuiWatchFormatter {
  push(event: EventEnvelope): TuiFormattedEvent;
}

export function createTuiWatchFormatter(): TuiWatchFormatter {
  const formatter = createTextWatchFormatter({ output: "text", tools: true });
  let active: ActiveStream | null = null;

  return {
    push(event: EventEnvelope): TuiFormattedEvent {
      const stream = streamIdentity(event);
      const sameStream = Boolean(
        stream && active && active.keyId === stream.keyId && active.type === stream.type,
      );
      const chunks = formatter.push(event);
      const authorizationFailedMessage =
        event.type === "authorization.failed" ? authorizationFailedText(event.payload) : undefined;

      if (chunks.length === 0) {
        return { lines: [], authorizationFailedMessage };
      }

      const text = stripFormatterFlushChunks(chunks, sameStream).join("");
      const update =
        stream && sameStream && active && !active.endedWithNewline
          ? splitDisplayAppend(text)
          : { lines: splitDisplayLines(text) };

      if (stream) {
        active = { ...stream, endedWithNewline: text.endsWith("\n") };
      } else {
        active = null;
      }

      return { ...update, authorizationFailedMessage };
    },
  };
}

export function formatTuiWatchEvent(event: EventEnvelope): TuiFormattedEvent {
  const text = formatWatchEvent(event, { output: "text", tools: true });
  const lines = splitDisplayLines(text);
  const authorizationFailedMessage =
    event.type === "authorization.failed" ? authorizationFailedText(event.payload) : undefined;
  return { lines, authorizationFailedMessage };
}

export function splitDisplayLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (normalized.length === 0) return [];
  return normalized.split("\n");
}

function splitDisplayAppend(text: string): Pick<TuiFormattedEvent, "appendToLastLine" | "lines"> {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  const [appendToLastLine = "", ...lines] = normalized.split("\n");
  return { appendToLastLine, lines };
}

function stripFormatterFlushChunks(chunks: string[], sameStream: boolean): string[] {
  if (sameStream) return chunks;
  let firstOutput = 0;
  while (chunks[firstOutput] === "\n") firstOutput += 1;
  return chunks.slice(firstOutput);
}

function streamIdentity(event: EventEnvelope): ActiveStream | null {
  const identity = watchStreamIdentity(event);
  return identity ? { ...identity, endedWithNewline: false } : null;
}

function authorizationFailedText(payload: unknown): string {
  const message = prop(payload, "message");
  return typeof message === "string" && message.length > 0
    ? `watch authorization failed: ${message}`
    : "watch authorization failed";
}

function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}
