import type { RunSummary } from "../rpc/projection.ts";
import { formatTable, tableCell } from "./table.ts";

const RUN_LIST_WORKFLOW_MAX_WIDTH = 40;
const DURATION_UNITS = [
  { label: "d", ms: 86_400_000 },
  { label: "h", ms: 3_600_000 },
  { label: "m", ms: 60_000 },
  { label: "s", ms: 1_000 },
] as const;

export function displayName(name: string | null | undefined): string {
  return name ?? "(unnamed)";
}

export function formatListRuns(runs: readonly RunSummary[], nowMs: number): string {
  return formatTable(
    ["RUN ID", "STATUS", "WORKFLOW", "CREATED", "DURATION"],
    runs.map((run) => [
      run.runId,
      run.status,
      tableCell(displayName(run.workflowName), { maxWidth: RUN_LIST_WORKFLOW_MAX_WIDTH }),
      formatUtcTimestamp(run.createdAtMs),
      formatDuration(run.createdAtMs, run.finishedAtMs ?? nowMs),
    ]),
  );
}

export function formatUtcTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) throw new Error(`invalid timestamp ${epochMs}`);
  return new Date(epochMs).toISOString();
}

export function formatDuration(startMs: number, endMs: number): string {
  if (!Number.isFinite(startMs)) throw new Error(`invalid duration start ${startMs}`);
  if (!Number.isFinite(endMs)) throw new Error(`invalid duration end ${endMs}`);
  const elapsedMs = Math.max(0, Math.floor(endMs - startMs));
  for (const unit of DURATION_UNITS) {
    if (elapsedMs >= unit.ms) return `${Math.floor(elapsedMs / unit.ms)}${unit.label}`;
  }
  return `${elapsedMs}ms`;
}
