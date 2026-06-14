import type { EventEnvelope } from "../rpc/contract.ts";
import type { Blockage, RunProjection, RunReport, RunSummary } from "../rpc/projection.ts";

export interface TuiStateOptions {
  runId?: string;
  status?: string;
  limit?: number;
  knownAdmin?: boolean;
  nowMs?: number;
  maxWatchLines?: number;
}

export type TuiView = "browser" | "detail";

export interface BrowserState {
  runs: RunSummary[];
  filteredRuns: RunSummary[];
  selectedIndex: number;
  query: string;
  statusFilter?: string;
  limit?: number;
  error?: string;
}

export interface DetailState {
  runId: string | null;
  projection: RunProjection | null;
  report: RunReport | null;
  blockage: Blockage | null;
  outputText: string | null;
}

export interface WatchLine {
  eventType: string;
  kind: "durable" | "ephemeral";
  seq: number | null;
  text: string;
}

export interface WatchLineUpdate {
  lines: readonly string[];
  appendToLastLine?: string;
}

export interface WatchState {
  attached: boolean;
  runId: string | null;
  caughtUp: boolean;
  lines: WatchLine[];
  linesRunId: string | null;
  lastSeqByRun: Record<string, number>;
  maxLines: number;
}

export type PromptKind = "filter" | "signal" | "rewind" | "approval";

export interface PromptState {
  kind: PromptKind;
  runId?: string;
  value: string;
  message: string;
  openDetailOnSuccess?: boolean;
}

export interface TuiState {
  view: TuiView;
  browser: BrowserState;
  detail: DetailState;
  watch: WatchState;
  prompt: PromptState | null;
  statusMessage: string;
  nowMs: number;
  knownAdmin: boolean;
  directRunId: string | null;
  quit: boolean;
}

export function createTuiState(opts: TuiStateOptions = {}): TuiState {
  const runId = opts.runId ?? null;
  return {
    view: runId ? "detail" : "browser",
    browser: applyBrowserFilters({
      runs: [],
      filteredRuns: [],
      selectedIndex: 0,
      query: "",
      statusFilter: opts.status,
      limit: opts.limit,
    }),
    detail: {
      runId,
      projection: null,
      report: null,
      blockage: null,
      outputText: null,
    },
    watch: {
      attached: false,
      runId: null,
      caughtUp: false,
      lines: [],
      linesRunId: null,
      lastSeqByRun: {},
      maxLines: opts.maxWatchLines ?? 200,
    },
    prompt: null,
    statusMessage: runId ? `opening run ${runId}` : "loading runs",
    nowMs: opts.nowMs ?? Date.now(),
    knownAdmin: opts.knownAdmin ?? false,
    directRunId: runId,
    quit: false,
  };
}

export function setNow(state: TuiState, nowMs: number): TuiState {
  return { ...state, nowMs };
}

export function setStatusMessage(state: TuiState, statusMessage: string): TuiState {
  return { ...state, statusMessage };
}

export function requestQuit(state: TuiState): TuiState {
  return { ...state, quit: true };
}

export function setBrowserRuns(
  state: TuiState,
  runs: readonly RunSummary[],
  statusMessage = `${runs.length} run${runs.length === 1 ? "" : "s"}`,
): TuiState {
  return {
    ...state,
    browser: applyBrowserFilters({
      ...state.browser,
      runs: [...runs],
      error: undefined,
    }),
    statusMessage,
  };
}

export function setBrowserError(state: TuiState, error: string): TuiState {
  return {
    ...state,
    browser: { ...state.browser, error },
    statusMessage: error,
  };
}

export function setBrowserQuery(state: TuiState, query: string): TuiState {
  return {
    ...state,
    browser: applyBrowserFilters({ ...state.browser, query, selectedIndex: 0 }),
  };
}

export function moveBrowserSelection(state: TuiState, delta: number): TuiState {
  const max = Math.max(0, state.browser.filteredRuns.length - 1);
  const selectedIndex = clamp(state.browser.selectedIndex + delta, 0, max);
  return { ...state, browser: { ...state.browser, selectedIndex } };
}

export function selectBrowserEdge(state: TuiState, edge: "top" | "bottom"): TuiState {
  const selectedIndex = edge === "top" ? 0 : Math.max(0, state.browser.filteredRuns.length - 1);
  return { ...state, browser: { ...state.browser, selectedIndex } };
}

export function selectedRun(state: TuiState): RunSummary | null {
  return state.browser.filteredRuns[state.browser.selectedIndex] ?? null;
}

export function openDetailState(state: TuiState, runId: string): TuiState {
  return {
    ...state,
    view: "detail",
    detail: {
      ...state.detail,
      runId,
      outputText: null,
    },
    statusMessage: `opening run ${runId}`,
  };
}

export function returnToBrowserState(state: TuiState): TuiState {
  if (state.directRunId) return requestQuit(state);
  return {
    ...state,
    view: "browser",
    prompt: null,
    statusMessage: "browser",
  };
}

export function setDetailData(
  state: TuiState,
  input: {
    projection: RunProjection | null;
    report: RunReport | null;
    blockage: Blockage | null;
  },
): TuiState {
  const runId = input.projection?.runId ?? input.report?.runId ?? state.detail.runId;
  return {
    ...state,
    detail: {
      ...state.detail,
      runId,
      projection: input.projection,
      report: input.report,
      blockage: input.blockage,
    },
    statusMessage: runId ? `run ${runId} refreshed` : "run not found",
  };
}

export function setDetailOutput(state: TuiState, outputText: string): TuiState {
  return {
    ...state,
    detail: { ...state.detail, outputText },
    statusMessage: "output loaded",
  };
}

export function startWatchState(state: TuiState, runId: string): TuiState {
  const sameLinesRun = state.watch.linesRunId === runId;
  return {
    ...state,
    watch: {
      ...state.watch,
      attached: true,
      runId,
      caughtUp: false,
      lines: sameLinesRun ? state.watch.lines : [],
      linesRunId: runId,
    },
    statusMessage: `watching ${runId}`,
  };
}

export function stopWatchState(state: TuiState, message = "watch detached"): TuiState {
  return {
    ...state,
    watch: {
      ...state.watch,
      attached: false,
      runId: null,
      caughtUp: false,
    },
    statusMessage: message,
  };
}

export function markWatchCaughtUp(state: TuiState): TuiState {
  return {
    ...state,
    watch: { ...state.watch, caughtUp: true },
    statusMessage: state.watch.runId ? `watch live for ${state.watch.runId}` : state.statusMessage,
  };
}

export function appendWatchLines(
  state: TuiState,
  event: EventEnvelope,
  updateOrLines: readonly string[] | WatchLineUpdate,
): TuiState {
  const update: WatchLineUpdate = isWatchLineUpdate(updateOrLines)
    ? updateOrLines
    : { lines: updateOrLines };
  const runId = state.watch.runId ?? state.detail.runId;
  const lastSeqByRun = { ...state.watch.lastSeqByRun };
  if (event.kind === "durable" && runId) {
    lastSeqByRun[runId] = Math.max(lastSeqByRun[runId] ?? 0, event.seq);
  }
  const hasFormattedUpdate = update.lines.length > 0 || update.appendToLastLine !== undefined;
  const newLines = hasFormattedUpdate
    ? update.lines
    : [`${event.kind === "durable" ? `[${event.seq}]` : "[live]"} ${event.type}`];
  let existingLines = state.watch.lines;
  if (update.appendToLastLine !== undefined && existingLines.length > 0) {
    const prior = existingLines.slice(0, -1);
    const last = existingLines.at(-1);
    if (last) {
      existingLines = [...prior, { ...last, text: `${last.text}${update.appendToLastLine}` }];
    }
  }
  const appended = newLines.map((text: string) => ({
    eventType: event.type,
    kind: event.kind,
    seq: event.kind === "durable" ? event.seq : null,
    text,
  }));
  const merged = [...existingLines, ...appended].slice(-state.watch.maxLines);
  return {
    ...state,
    watch: {
      ...state.watch,
      lines: merged,
      linesRunId: runId ?? state.watch.linesRunId,
      lastSeqByRun,
    },
  };
}

export function lastSeqForRun(state: TuiState, runId: string): number {
  return state.watch.lastSeqByRun[runId] ?? 0;
}

function isWatchLineUpdate(value: readonly string[] | WatchLineUpdate): value is WatchLineUpdate {
  return !Array.isArray(value);
}

export function setPrompt(state: TuiState, prompt: PromptState | null): TuiState {
  return { ...state, prompt };
}

export function detailRunId(state: TuiState): string | null {
  return state.detail.runId ?? state.detail.projection?.runId ?? state.detail.report?.runId ?? null;
}

function applyBrowserFilters(browser: BrowserState): BrowserState {
  const query = browser.query.trim().toLowerCase();
  let filteredRuns = browser.runs.filter((run) => {
    if (browser.statusFilter && run.status !== browser.statusFilter) return false;
    if (query.length === 0) return true;
    return [run.runId, run.workflowName ?? "", run.status].some((value) =>
      value.toLowerCase().includes(query),
    );
  });
  if (browser.limit !== undefined) filteredRuns = filteredRuns.slice(0, browser.limit);
  const selectedIndex = clamp(browser.selectedIndex, 0, Math.max(0, filteredRuns.length - 1));
  return { ...browser, filteredRuns, selectedIndex };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
