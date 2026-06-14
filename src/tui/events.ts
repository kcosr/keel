import { formatWatchEvent } from "../cli/watch-format.ts";
import type { EventEnvelope } from "../rpc/contract.ts";

export interface TuiFormattedEvent {
  lines: string[];
  authorizationFailedMessage?: string;
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
