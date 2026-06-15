import type { JournalStore } from "../journal/store.ts";
import { cleanupTerminalRunWorkspaces } from "../workspace/retention.ts";
import { serializeError } from "./step-engine.ts";

export function serializedErrorJson(err: unknown): string {
  return JSON.stringify(serializeError(err));
}

export function failRunWithError(
  store: JournalStore,
  runId: string,
  err: unknown,
  atMs: number,
): void {
  const error = serializeError(err);
  store.transaction(() => {
    store.updateRun(runId, {
      status: "failed",
      errorJson: JSON.stringify(error),
      finishedAtMs: atMs,
    });
    store.appendEvent(runId, "run.failed", error, atMs);
  });
  cleanupTerminalRunWorkspaces(store, runId, "failed", atMs);
}
