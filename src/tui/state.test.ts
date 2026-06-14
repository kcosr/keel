import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../rpc/contract.ts";
import type { RunSummary } from "../rpc/projection.ts";
import {
  appendWatchLines,
  createTuiState,
  lastSeqForRun,
  moveBrowserSelection,
  selectedRun,
  setBrowserQuery,
  setBrowserRuns,
  startWatchState,
  stopWatchState,
} from "./state.ts";

const runs: RunSummary[] = [
  {
    runId: "run_a",
    workflowName: "alpha",
    status: "finished",
    createdAtMs: 1_000,
    finishedAtMs: 2_000,
    parentRunId: null,
  },
  {
    runId: "run_b",
    workflowName: null,
    status: "waiting-signal",
    createdAtMs: 2_000,
    finishedAtMs: null,
    parentRunId: null,
  },
  {
    runId: "run_c",
    workflowName: "beta",
    status: "running",
    createdAtMs: 3_000,
    finishedAtMs: null,
    parentRunId: null,
  },
];

describe("tui state", () => {
  test("filters browser rows by status, query, and limit while clamping selection", () => {
    let state = createTuiState({ status: "waiting-signal", limit: 1, nowMs: 10_000 });
    state = setBrowserRuns(state, runs);
    expect(state.browser.filteredRuns.map((run) => run.runId)).toEqual(["run_b"]);
    expect(selectedRun(state)?.runId).toBe("run_b");

    state = moveBrowserSelection(state, 5);
    expect(state.browser.selectedIndex).toBe(0);

    state = setBrowserQuery(state, "missing");
    expect(state.browser.filteredRuns).toEqual([]);
    expect(selectedRun(state)).toBeNull();
  });

  test("records durable watch sequence and detaches locally without clearing history", () => {
    let state = createTuiState({ runId: "run_a", maxWatchLines: 3 });
    state = startWatchState(state, "run_a");
    const durable: EventEnvelope = {
      kind: "durable",
      seq: 7,
      type: "phase",
      payload: { title: "work" },
      atMs: 1_234,
    };
    const ephemeral: EventEnvelope = {
      kind: "ephemeral",
      type: "agent.event",
      payload: { event: { type: "text", data: "hi" } },
      atMs: 1_235,
    };
    state = appendWatchLines(state, durable, ["[7] phase: work"]);
    state = appendWatchLines(state, ephemeral, ["[live] agent text: hi"]);

    expect(lastSeqForRun(state, "run_a")).toBe(7);
    expect(state.watch.lines.map((line) => line.text)).toEqual([
      "[7] phase: work",
      "[live] agent text: hi",
    ]);

    state = stopWatchState(state, "authorization failed");
    expect(state.watch.attached).toBe(false);
    expect(state.statusMessage).toBe("authorization failed");
    expect(lastSeqForRun(state, "run_a")).toBe(7);
  });

  test("clears watch lines only when attaching to a different run", () => {
    let state = createTuiState({ runId: "run_a" });
    state = startWatchState(state, "run_a");
    state = appendWatchLines(
      state,
      { kind: "durable", seq: 1, type: "phase", payload: { title: "a" }, atMs: 1_000 },
      ["[1] phase: a"],
    );
    state = stopWatchState(state);

    state = startWatchState(state, "run_a");
    expect(state.watch.lines.map((line) => line.text)).toEqual(["[1] phase: a"]);

    state = startWatchState(state, "run_b");
    expect(state.watch.lines).toEqual([]);
  });
});
