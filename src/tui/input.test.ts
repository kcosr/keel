import { describe, expect, test } from "bun:test";
import type { RunSummary } from "../rpc/projection.ts";
import { parseApprovalPrompt, parseSignalPrompt, parseTuiKeys, reduceTuiKey } from "./input.ts";
import { createTuiState, setBrowserRuns } from "./state.ts";

const run: RunSummary = {
  runId: "run_1",
  workflowName: "wf",
  status: "running",
  createdAtMs: 1_000,
  finishedAtMs: null,
  parentRunId: null,
};

describe("tui input", () => {
  test("parses arrow, enter, escape, and ctrl-c keys", () => {
    expect(parseTuiKeys("j\u001b[A\u001b[B\r\u001b\u0003")).toEqual([
      { type: "char", value: "j" },
      { type: "arrow-up" },
      { type: "arrow-down" },
      { type: "enter" },
      { type: "escape" },
      { type: "ctrl-c" },
    ]);
  });

  test("opens detail and requests watch from browser", () => {
    let state = setBrowserRuns(createTuiState(), [run]);
    const result = reduceTuiKey(state, { type: "char", value: "w" });
    state = result.state;

    expect(state.view).toBe("detail");
    expect(state.detail.runId).toBe("run_1");
    expect(result.commands).toEqual([
      { type: "refreshDetail", runId: "run_1" },
      { type: "attachWatch", runId: "run_1" },
    ]);
  });

  test("browser lifecycle controls keep browser view until daemon success", () => {
    const state = setBrowserRuns(createTuiState(), [run]);
    const result = reduceTuiKey(state, { type: "char", value: "R" });

    expect(result.state.view).toBe("browser");
    expect(result.commands).toEqual([
      { type: "lifecycle", action: "resume", runId: "run_1", openDetailOnSuccess: true },
    ]);
  });

  test("browser signal prompt stays in browser until successful delivery", () => {
    let state = setBrowserRuns(createTuiState(), [run]);
    state = reduceTuiKey(state, { type: "char", value: "s" }).state;

    expect(state.view).toBe("browser");
    expect(state.prompt).toMatchObject({
      kind: "signal",
      runId: "run_1",
      openDetailOnSuccess: true,
    });

    const result = reduceTuiKey(state, { type: "char", value: "p" });
    const submitted = reduceTuiKey(result.state, { type: "enter" });
    expect(submitted.commands).toEqual([
      {
        type: "signal",
        runId: "run_1",
        name: "p",
        payload: null,
        openDetailOnSuccess: true,
      },
    ]);
  });

  test("filter prompt updates browser rows locally", () => {
    let state = setBrowserRuns(createTuiState(), [
      run,
      { ...run, runId: "run_2", workflowName: "other" },
    ]);
    state = reduceTuiKey(state, { type: "char", value: "/" }).state;
    state = reduceTuiKey(state, { type: "char", value: "o" }).state;
    state = reduceTuiKey(state, { type: "char", value: "t" }).state;

    expect(state.prompt?.kind).toBe("filter");
    expect(state.browser.filteredRuns.map((row) => row.runId)).toEqual(["run_2"]);

    state = reduceTuiKey(state, { type: "enter" }).state;
    expect(state.prompt).toBeNull();
    expect(state.browser.query).toBe("ot");
  });

  test("approval is disabled unless admin credentials are known", () => {
    let state = createTuiState({ runId: "run_1", knownAdmin: false });
    const result = reduceTuiKey(state, { type: "char", value: "a" });
    state = result.state;

    expect(result.commands).toEqual([]);
    expect(state.statusMessage).toBe("approval requires admin credentials");
  });

  test("parses signal and approval prompts", () => {
    expect(parseSignalPrompt('poke {"n":1}')).toEqual({ name: "poke", payload: { n: 1 } });
    expect(parseSignalPrompt("poke")).toEqual({ name: "poke", payload: null });
    expect(parseApprovalPrompt("deny gate needs changes")).toEqual({
      decision: "denied",
      key: "gate",
      note: "needs changes",
    });
  });
});
