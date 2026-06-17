import type { JournalStore } from "../journal/store.ts";
import type { RunStatus } from "../journal/types.ts";
import { type EventCursor, type EventCursorInput, MAX_EVENT_TAIL_COUNT } from "./contract.ts";

export interface ResolvedEventCursor {
  afterSeq: number;
  initialCursor: EventCursor;
  closedStatus: string | null;
}

export function normalizeEventCursorInput(input: unknown): EventCursorInput {
  if (input === undefined || input === null) return { kind: "beginning" };
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("event cursor must be an object");
  }
  const cursor = input as Record<string, unknown>;
  switch (cursor.kind) {
    case "beginning":
      return { kind: "beginning" };
    case "after-seq":
      return { kind: "after-seq", seq: validNonNegativeInteger(cursor.seq, "cursor seq") };
    case "tail":
      return { kind: "tail", count: validTailCount(cursor.count) };
    case "now":
      return { kind: "now" };
    default:
      throw new Error(`unknown event cursor kind ${String(cursor.kind)}`);
  }
}

export function resolveEventCursor(
  store: JournalStore,
  runId: string,
  input: EventCursorInput = { kind: "beginning" },
): ResolvedEventCursor {
  const cursor = normalizeEventCursorInput(input);
  let afterSeq: number;
  switch (cursor.kind) {
    case "beginning":
      afterSeq = 0;
      break;
    case "after-seq":
      afterSeq = cursor.seq;
      break;
    case "tail":
      afterSeq = store.eventTailFloor(runId, cursor.count);
      break;
    case "now":
      afterSeq = store.eventHighWater(runId);
      break;
  }
  const run = store.getRun(runId);
  return {
    afterSeq,
    initialCursor: { kind: "after-seq", runId, seq: afterSeq },
    closedStatus: run ? closedWatchStatus(run.status) : null,
  };
}

export function cursorAfterSeq(runId: string, seq: number): EventCursor {
  return { kind: "after-seq", runId, seq: validNonNegativeInteger(seq, "cursor seq") };
}

export function closedWatchStatus(status: RunStatus): string | null {
  return status === "running" ? null : status;
}

function validNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  if (value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function validTailCount(value: unknown): number {
  const count = validNonNegativeInteger(value, "tail count");
  if (count > MAX_EVENT_TAIL_COUNT) {
    throw new Error(`tail count must be <= ${MAX_EVENT_TAIL_COUNT}`);
  }
  return count;
}
