import { displayName, formatDuration, formatUtcTimestamp } from "../cli/run-display.ts";
import { sanitizeTerminalLineText } from "../cli/terminal-text.ts";
import type { RunProjection, RunReport, RunSummary } from "../rpc/projection.ts";
import type { TuiState, WatchLine } from "./state.ts";

export interface TuiDimensions {
  width: number;
  height: number;
}

export function renderAnsiFrame(state: TuiState, dims: TuiDimensions): string {
  return `\u001b[H${renderTuiLines(state, dims)
    .map((line) => `${clip(line, dims.width)}\u001b[K`)
    .join("\r\n")}\u001b[J`;
}

export function renderTuiLines(state: TuiState, dims: TuiDimensions): string[] {
  const height = Math.max(3, dims.height);
  const bodyHeight = height - 2;
  const body =
    state.view === "browser"
      ? renderBrowserBody(state, dims.width, bodyHeight)
      : renderDetailBody(state, dims.width, bodyHeight);
  const status = renderStatusLine(state, dims.width);
  const help = state.view === "browser" ? browserHelp() : detailHelp(state);
  return fitLines([...body], bodyHeight, dims.width).concat([
    clip(status, dims.width),
    clip(help, dims.width),
  ]);
}

function renderBrowserBody(state: TuiState, width: number, bodyHeight: number): string[] {
  const browser = state.browser;
  const suffix = [
    browser.statusFilter ? `status=${browser.statusFilter}` : null,
    browser.query ? `filter=${browser.query}` : null,
    browser.limit ? `limit=${browser.limit}` : null,
  ].filter(Boolean);
  const lines = [
    `Keel runs ${browser.filteredRuns.length}/${browser.runs.length}${suffix.length ? ` (${suffix.join(" ")})` : ""}`,
  ];
  if (browser.error) lines.push(`error: ${browser.error}`);
  lines.push(formatBrowserHeader(width));
  if (browser.filteredRuns.length === 0) {
    lines.push("  no runs");
    return lines;
  }
  const maxRows = Math.max(0, bodyHeight - lines.length);
  const firstRow = visibleBrowserStart(browser.selectedIndex, browser.filteredRuns.length, maxRows);
  const rows = browser.filteredRuns.slice(firstRow, firstRow + maxRows);
  for (let index = 0; index < rows.length; index += 1) {
    const run = rows[index] as RunSummary;
    lines.push(
      formatBrowserRow(run, firstRow + index === browser.selectedIndex, state.nowMs, width),
    );
  }
  return lines;
}

function visibleBrowserStart(selectedIndex: number, rowCount: number, maxRows: number): number {
  if (maxRows <= 0 || rowCount <= maxRows) return 0;
  return Math.min(Math.max(0, selectedIndex - maxRows + 1), rowCount - maxRows);
}

function detailViewportLines(
  detailLines: readonly string[],
  watchLines: readonly string[],
  bodyHeight: number,
): string[] {
  if (bodyHeight <= 0) return [];
  const fullBody = [...detailLines, ...watchLines];
  if (fullBody.length <= bodyHeight) return fullBody;
  const visibleWatchLines = tailWatchLines(watchLines, bodyHeight);
  const detailBudget = Math.max(0, bodyHeight - visibleWatchLines.length);
  return [...detailLines.slice(0, detailBudget), ...visibleWatchLines];
}

function tailWatchLines(watchLines: readonly string[], bodyHeight: number): string[] {
  if (bodyHeight <= 0) return [];
  if (watchLines.length <= bodyHeight) return [...watchLines];
  if (bodyHeight === 1) return [watchLines.at(-1) ?? ""];
  const [header, eventsHeader, ...eventLines] = watchLines;
  if (bodyHeight === 2 || eventsHeader === undefined) {
    return [header ?? "", watchLines.at(-1) ?? ""];
  }
  return [header ?? "", eventsHeader, ...eventLines.slice(-(bodyHeight - 2))];
}

function renderDetailBody(state: TuiState, width: number, bodyHeight: number): string[] {
  const detail = state.detail;
  const projection = detail.projection;
  const report = detail.report;
  const lines = ["Keel run detail"];
  lines.push(formatDetailHeader(detail.runId, projection, report, state.nowMs));
  if (!projection && !report) {
    lines.push("loading or unavailable");
  } else {
    const phase = projection?.phase ?? null;
    if (phase) lines.push(`phase: ${phase}`);
    const stats = projection?.stats ?? report?.stats;
    if (stats) {
      lines.push(`stats: steps=${stats.steps} agents=${stats.agents} artifacts=${stats.artifacts}`);
    }
    const error = projection?.error ?? report?.error;
    if (error) lines.push(`error: ${error.name}: ${error.message}`);
    const blockage = detail.blockage ?? report?.blockage ?? null;
    if (blockage && blockage.reason !== "none") {
      lines.push(`blockage: ${blockage.reason} ${blockage.context}`);
    }
    const nodes = projection?.nodes ?? report?.nodes ?? [];
    if (nodes.length > 0) {
      lines.push("nodes:");
      for (const node of nodes.slice(0, 6)) {
        lines.push(`  ${node.stableKey} ${node.status} ${node.effectType} attempt=${node.attempt}`);
      }
      if (nodes.length > 6) lines.push(`  … ${nodes.length - 6} more`);
    }
    if (detail.outputText) {
      lines.push("output:");
      for (const line of detail.outputText.split("\n").slice(0, 6)) lines.push(`  ${line}`);
    }
  }
  const watchLines = detailWatchLines(state, width);
  return detailViewportLines(lines, watchLines, bodyHeight);
}

function formatBrowserHeader(width: number): string {
  const cols = browserColumns(width);
  return `  ${pad("RUN ID", cols.runId)}  ${pad("STATUS", cols.status)}  ${pad("WORKFLOW", cols.workflow)}  ${pad("CREATED", cols.created)}  ${pad("DURATION", cols.duration)}`;
}

function formatBrowserRow(
  run: RunSummary,
  selected: boolean,
  nowMs: number,
  width: number,
): string {
  const cols = browserColumns(width);
  const marker = selected ? ">" : " ";
  return `${marker} ${pad(run.runId, cols.runId)}  ${pad(run.status, cols.status)}  ${pad(
    displayName(run.workflowName),
    cols.workflow,
  )}  ${pad(formatUtcTimestamp(run.createdAtMs), cols.created)}  ${pad(
    formatDuration(run.createdAtMs, run.finishedAtMs ?? nowMs),
    cols.duration,
  )}`;
}

function browserColumns(width: number): {
  runId: number;
  status: number;
  workflow: number;
  created: number;
  duration: number;
} {
  const runId = 14;
  const status = 14;
  const created = width >= 100 ? 24 : 20;
  const duration = 8;
  const fixed = 2 + runId + 2 + status + 2 + created + 2 + duration;
  const workflow = Math.max(10, width - fixed - 2);
  return { runId, status, workflow, created, duration };
}

function formatDetailHeader(
  runId: string | null,
  projection: RunProjection | null,
  report: RunReport | null,
  nowMs: number,
): string {
  const id = projection?.runId ?? report?.runId ?? runId ?? "(unknown)";
  const status = projection?.status ?? report?.status ?? "unknown";
  const workflow = displayName(projection?.workflowName ?? report?.workflowName ?? null);
  const createdAtMs = projection?.createdAtMs ?? report?.createdAtMs;
  const finishedAtMs = projection?.finishedAtMs ?? report?.finishedAtMs ?? null;
  const created =
    createdAtMs === undefined ? "created ?" : `created ${formatUtcTimestamp(createdAtMs)}`;
  const duration =
    createdAtMs === undefined
      ? "duration ?"
      : `duration ${formatDuration(createdAtMs, finishedAtMs ?? nowMs)}`;
  return `run ${id}  ${status}  ${workflow}  ${created}  ${duration}`;
}

function detailWatchLines(state: TuiState, width: number): string[] {
  if (!state.watch.attached && state.watch.lines.length === 0) return [];
  return [formatWatchHeader(state), ...renderWatchLines(state.watch.lines, width)];
}

function formatWatchHeader(state: TuiState): string {
  if (!state.watch.attached) return "watch: detached";
  const live = state.watch.caughtUp ? "live" : "backfill";
  return `watch: attached ${state.watch.runId ?? ""} (${live})`;
}

function renderWatchLines(lines: readonly WatchLine[], width: number): string[] {
  if (lines.length === 0) return ["events: none"];
  const out = ["events:"];
  for (const line of lines.slice(-8)) out.push(`  ${clip(line.text, Math.max(0, width - 2))}`);
  return out;
}

function renderStatusLine(state: TuiState, width: number): string {
  if (state.prompt) return clip(`> ${state.prompt.message}: ${state.prompt.value}`, width);
  return clip(state.statusMessage, width);
}

function browserHelp(): string {
  return "? help  q quit  r refresh  j/k move  Enter open  w watch  / filter  R resume  t retry  s signal";
}

function detailHelp(state: TuiState): string {
  const approval = state.knownAdmin ? "a approve/deny" : "approval admin-only";
  const watch = state.watch.attached ? "w detach" : "w watch";
  return `q quit  b back  ${watch}  r refresh  R resume  t retry  e rewind  s signal  o output  ${approval}`;
}

function fitLines(lines: string[], height: number, width: number): string[] {
  const clipped = lines.slice(0, height).map((line) => clip(line, width));
  while (clipped.length < height) clipped.push("");
  return clipped;
}

function pad(value: string, width: number): string {
  return clip(value, width).padEnd(width);
}

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  const cleaned = sanitizeTerminalLineText(value);
  if (cleaned.length <= width) return cleaned;
  if (width === 1) return "…";
  return `${cleaned.slice(0, width - 1)}…`;
}
