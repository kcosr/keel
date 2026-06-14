import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../rpc/contract.ts";
import type { RunSummary } from "../rpc/projection.ts";
import { createTuiWatchFormatter } from "./events.ts";
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

function liveAgentText(data: string): EventEnvelope {
  return {
    kind: "ephemeral",
    type: "agent.event",
    payload: { key: "review", event: { type: "text", data } },
    atMs: 1,
  };
}

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

  test("retains newest watch lines when the display history is bounded", () => {
    let state = createTuiState({ runId: "run_a", maxWatchLines: 3 });
    state = startWatchState(state, "run_a");
    for (let seq = 1; seq <= 5; seq += 1) {
      state = appendWatchLines(
        state,
        { kind: "durable", seq, type: "phase", payload: { title: `event ${seq}` }, atMs: seq },
        [`[${seq}] phase: event ${seq}`],
      );
    }

    expect(state.watch.lines.map((line) => line.text)).toEqual([
      "[3] phase: event 3",
      "[4] phase: event 4",
      "[5] phase: event 5",
    ]);
    expect(lastSeqForRun(state, "run_a")).toBe(5);
  });

  test("windows long coalesced stream rows to a bounded trailing display state", () => {
    let state = createTuiState({ runId: "run_a", maxWatchLineChars: 40 });
    state = startWatchState(state, "run_a");
    const formatter = createTuiWatchFormatter();

    const first = liveAgentText("abcdef");
    state = appendWatchLines(state, first, formatter.push(first));
    expect(state.watch.lines[0]?.text).toBe("[live] agent review text: abcdef");

    const second = liveAgentText("ghijklmnopqrstuvwxyz");
    state = appendWatchLines(state, second, formatter.push(second));

    const text = state.watch.lines[0]?.text ?? "";
    expect(Array.from(text).length).toBeLessThanOrEqual(40);
    expect(text.startsWith("…")).toBe(true);
    expect(text.endsWith("abcdefghijklmnopqrstuvwxyz")).toBe(true);
  });

  test("applies stream continuations to the active watch display row", () => {
    let state = createTuiState({ runId: "run_a" });
    state = startWatchState(state, "run_a");
    const formatter = createTuiWatchFormatter();

    const first = liveAgentText("Hel");
    state = appendWatchLines(state, first, formatter.push(first));
    const second = liveAgentText("lo");
    state = appendWatchLines(state, second, formatter.push(second));

    expect(state.watch.lines.map((line) => line.text)).toEqual(["[live] agent review text: Hello"]);

    const phase: EventEnvelope = {
      kind: "durable",
      seq: 2,
      type: "phase",
      payload: { title: "Build" },
      atMs: 2,
    };
    state = appendWatchLines(state, phase, formatter.push(phase));
    const next = liveAgentText("next");
    state = appendWatchLines(state, next, formatter.push(next));

    expect(state.watch.lines.map((line) => line.text)).toEqual([
      "[live] agent review text: Hello",
      "[2] phase: Build",
      "[live] agent review text: next",
    ]);
    expect(lastSeqForRun(state, "run_a")).toBe(2);
  });
});
