import { describe, expect, test } from "bun:test";
import type { RunProjection, RunSummary } from "../rpc/projection.ts";
import { createTuiState, setBrowserRuns, setDetailData, startWatchState } from "./state.ts";
import { renderAnsiFrame, renderTuiLines } from "./views.ts";

const run: RunSummary = {
  runId: "run_1",
  workflowName: null,
  status: "waiting-signal",
  createdAtMs: Date.UTC(2026, 5, 14, 1, 0, 0, 0),
  finishedAtMs: null,
  parentRunId: null,
};

const projection: RunProjection = {
  runId: "run_1",
  workflowName: "wf",
  status: "running",
  definitionVersion: "def_1",
  parentRunId: null,
  createdAtMs: Date.UTC(2026, 5, 14, 1, 0, 0, 0),
  finishedAtMs: null,
  phase: "working",
  error: null,
  stats: { steps: 1, agents: 0, artifacts: 0 },
  nodes: [
    {
      stableKey: "step.one",
      effectType: "pure",
      status: "completed",
      attempt: 1,
      dependsOn: [],
      artifactBacked: false,
    },
  ],
};

describe("tui views", () => {
  test("renders browser table with list display semantics", () => {
    const state = setBrowserRuns(createTuiState({ nowMs: Date.UTC(2026, 5, 14, 1, 0, 5, 0) }), [
      run,
    ]);

    expect(renderTuiLines(state, { width: 100, height: 8 })).toEqual([
      "Keel runs 1/1",
      "  RUN ID          STATUS          WORKFLOW                        CREATED                   DURATION",
      "> run_1           waiting-signal  (unnamed)                       2026-06-14T01:00:00.000Z  5s      ",
      "",
      "",
      "",
      "1 run",
      "? help  q quit  r refresh  j/k move  Enter open  w watch  / filter  R resume  t retry  s signal",
    ]);
  });

  test("ansi frame clears stale rows below a shrunken render", () => {
    const state = setBrowserRuns(createTuiState(), [run]);
    const frame = renderAnsiFrame(state, { width: 80, height: 6 });

    expect(frame.endsWith("\u001b[J")).toBe(true);
    expect(frame).toContain("\u001b[K\r\n");
  });

  test("renders detail header, stats, nodes, and watch status", () => {
    let state = createTuiState({ runId: "run_1", nowMs: Date.UTC(2026, 5, 14, 1, 0, 2, 0) });
    state = setDetailData(state, { projection, report: null, blockage: null });
    state = startWatchState(state, "run_1");

    expect(renderTuiLines(state, { width: 100, height: 10 })).toEqual([
      "Keel run detail",
      "run run_1  running  wf  created 2026-06-14T01:00:00.000Z  duration 2s",
      "phase: working",
      "stats: steps=1 agents=0 artifacts=0",
      "nodes:",
      "  step.one completed pure attempt=1",
      "watch: attached run_1 (backfill)",
      "events: none",
      "watching run_1",
      "q quit  b back  w detach  r refresh  R resume  t retry  e rewind  s signal  o output  approval admi…",
    ]);
  });
});
