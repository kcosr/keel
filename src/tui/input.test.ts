import { describe, expect, test } from "bun:test";
import type { RunSummary } from "../rpc/projection.ts";
import {
  parseApprovalPrompt,
  parseSignalPrompt,
  parseTuiKeyChunk,
  parseTuiKeys,
  reduceTuiKey,
} from "./input.ts";
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

  test("consumes unrecognized escape and CSI sequences without leaking tail bytes", () => {
    expect(parseTuiKeys("a\u001b[200~b\u001b[t\u001bOx\u001b]0;title\u0007c")).toEqual([
      { type: "char", value: "a" },
      { type: "char", value: "b" },
      { type: "char", value: "c" },
    ]);
  });

  test("buffers incomplete escape sequences across input chunks", () => {
    let parsed = parseTuiKeyChunk("\u001b[20");
    expect(parsed.keys).toEqual([]);
    expect(parsed.state.pending).toBe("\u001b[20");

    parsed = parseTuiKeyChunk("0~x", parsed.state);
    expect(parsed.keys).toEqual([{ type: "char", value: "x" }]);
    expect(parsed.state.pending).toBe("");

    parsed = parseTuiKeyChunk("\u001b[A\u001bO");
    expect(parsed.keys).toEqual([{ type: "arrow-up" }]);
    expect(parsed.state.pending).toBe("\u001bO");

    parsed = parseTuiKeyChunk("B", parsed.state);
    expect(parsed.keys).toEqual([{ type: "arrow-down" }]);
    expect(parsed.state.pending).toBe("");

    parsed = parseTuiKeyChunk("\u001b");
    expect(parsed.keys).toEqual([]);
    expect(parsed.state.pending).toBe("\u001b");
    parsed = parseTuiKeyChunk("q", parsed.state);
    expect(parsed.keys).toEqual([{ type: "escape" }, { type: "char", value: "q" }]);
  });

  test("unrecognized CSI sequences do not alter prompts or trigger detail navigation", () => {
    let state = setBrowserRuns(createTuiState(), [run]);
    state = reduceTuiKey(state, { type: "char", value: "/" }).state;
    for (const key of parseTuiKeys("\u001b[200~wf")) {
      state = reduceTuiKey(state, key).state;
    }
    expect(state.prompt?.value).toBe("wf");
    expect(state.browser.query).toBe("wf");

    state = reduceTuiKey(state, { type: "enter" }).state;
    state = reduceTuiKey(state, { type: "enter" }).state;
    expect(state.view).toBe("detail");

    const commands = [];
    for (const key of parseTuiKeys("\u001b[t")) {
      const result = reduceTuiKey(state, key);
      state = result.state;
      commands.push(...result.commands);
    }
    expect(state.view).toBe("detail");
    expect(commands).toEqual([]);
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
