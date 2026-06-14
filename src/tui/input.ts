import {
  type PromptKind,
  type PromptState,
  type TuiState,
  detailRunId,
  moveBrowserSelection,
  openDetailState,
  requestQuit,
  returnToBrowserState,
  selectBrowserEdge,
  selectedRun,
  setBrowserQuery,
  setPrompt,
  setStatusMessage,
} from "./state.ts";

export type TuiKey =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "escape" }
  | { type: "backspace" }
  | { type: "ctrl-c" }
  | { type: "arrow-up" }
  | { type: "arrow-down" };

export type TuiCommand =
  | { type: "refreshBrowser" }
  | { type: "refreshDetail"; runId: string }
  | { type: "attachWatch"; runId: string }
  | { type: "detachWatch" }
  | {
      type: "lifecycle";
      action: "resume" | "retry";
      runId: string;
      openDetailOnSuccess?: boolean;
    }
  | { type: "rewind"; runId: string; stableKey: string }
  | {
      type: "signal";
      runId: string;
      name: string;
      payload: unknown;
      openDetailOnSuccess?: boolean;
    }
  | {
      type: "approval";
      runId: string;
      key: string;
      decision: "approved" | "denied";
      note?: string;
    }
  | { type: "output"; runId: string };

export interface TuiInputResult {
  state: TuiState;
  commands: TuiCommand[];
}

export function parseTuiKeys(input: string | Uint8Array): TuiKey[] {
  const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  const keys: TuiKey[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\u0003") {
      keys.push({ type: "ctrl-c" });
    } else if (ch === "\r" || ch === "\n") {
      keys.push({ type: "enter" });
    } else if (ch === "\u007f" || ch === "\b") {
      keys.push({ type: "backspace" });
    } else if (ch === "\u001b") {
      const seq = text.slice(i, i + 3);
      if (seq === "\u001b[A") {
        keys.push({ type: "arrow-up" });
        i += 2;
      } else if (seq === "\u001b[B") {
        keys.push({ type: "arrow-down" });
        i += 2;
      } else {
        keys.push({ type: "escape" });
      }
    } else if (ch && ch >= " ") {
      keys.push({ type: "char", value: ch });
    }
  }
  return keys;
}

export function reduceTuiKey(state: TuiState, key: TuiKey): TuiInputResult {
  if (key.type === "ctrl-c") return { state: requestQuit(state), commands: [] };
  if (state.prompt) return reducePromptKey(state, key);
  if (state.view === "browser") return reduceBrowserKey(state, key);
  return reduceDetailKey(state, key);
}

export function parseSignalPrompt(input: string): { name: string; payload: unknown } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("signal needs a name");
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace < 0) return { name: trimmed, payload: null };
  const name = trimmed.slice(0, firstSpace);
  const payloadText = trimmed.slice(firstSpace).trim();
  return { name, payload: payloadText ? JSON.parse(payloadText) : null };
}

export function parseApprovalPrompt(input: string): {
  decision: "approved" | "denied";
  key: string;
  note?: string;
} {
  const [decisionWord, key, ...noteParts] = input.trim().split(/\s+/).filter(Boolean);
  if (!decisionWord || !key) throw new Error("approval needs approve|deny and a key");
  const decision = approvalDecision(decisionWord);
  const note = noteParts.join(" ");
  return { decision, key, ...(note ? { note } : {}) };
}

function reducePromptKey(state: TuiState, key: TuiKey): TuiInputResult {
  const prompt = state.prompt as PromptState;
  if (key.type === "escape") {
    return { state: setPrompt(setStatusMessage(state, "prompt cancelled"), null), commands: [] };
  }
  if (key.type === "backspace") {
    return updatePromptValue(state, prompt.value.slice(0, -1));
  }
  if (key.type === "char") {
    return updatePromptValue(state, `${prompt.value}${key.value}`);
  }
  if (key.type !== "enter") return { state, commands: [] };

  const value = prompt.value.trim();
  const runId = prompt.runId ?? detailRunId(state);
  if (prompt.kind === "filter") {
    return { state: setPrompt(setBrowserQuery(state, value), null), commands: [] };
  }
  if (!runId) {
    return { state: setPrompt(setStatusMessage(state, "no run selected"), null), commands: [] };
  }
  try {
    if (prompt.kind === "signal") {
      const parsed = parseSignalPrompt(value);
      return {
        state: setPrompt(setStatusMessage(state, `sending signal ${parsed.name}`), null),
        commands: [
          {
            type: "signal",
            runId,
            name: parsed.name,
            payload: parsed.payload,
            ...(prompt.openDetailOnSuccess ? { openDetailOnSuccess: true } : {}),
          },
        ],
      };
    }
    if (prompt.kind === "rewind") {
      if (!value) throw new Error("rewind needs a step key");
      return {
        state: setPrompt(setStatusMessage(state, `rewinding to ${value}`), null),
        commands: [{ type: "rewind", runId, stableKey: value }],
      };
    }
    const approval = parseApprovalPrompt(value);
    return {
      state: setPrompt(setStatusMessage(state, `${approval.decision} ${approval.key}`), null),
      commands: [
        {
          type: "approval",
          runId,
          key: approval.key,
          decision: approval.decision,
          ...(approval.note ? { note: approval.note } : {}),
        },
      ],
    };
  } catch (err) {
    return {
      state: setPrompt(
        setStatusMessage(state, err instanceof Error ? err.message : String(err)),
        null,
      ),
      commands: [],
    };
  }
}

function updatePromptValue(state: TuiState, value: string): TuiInputResult {
  const prompt = state.prompt;
  if (!prompt) return { state, commands: [] };
  const next = setPrompt(state, { ...prompt, value });
  return {
    state: prompt.kind === "filter" ? setBrowserQuery(next, value) : next,
    commands: [],
  };
}

function reduceBrowserKey(state: TuiState, key: TuiKey): TuiInputResult {
  if (key.type === "arrow-down") return { state: moveBrowserSelection(state, 1), commands: [] };
  if (key.type === "arrow-up") return { state: moveBrowserSelection(state, -1), commands: [] };
  if (key.type !== "char" && key.type !== "enter") return { state, commands: [] };

  if (key.type === "enter") return openSelectedDetail(state, false);
  switch (key.value) {
    case "q":
      return { state: requestQuit(state), commands: [] };
    case "j":
      return { state: moveBrowserSelection(state, 1), commands: [] };
    case "k":
      return { state: moveBrowserSelection(state, -1), commands: [] };
    case "g":
      return { state: selectBrowserEdge(state, "top"), commands: [] };
    case "G":
      return { state: selectBrowserEdge(state, "bottom"), commands: [] };
    case "r":
      return {
        state: setStatusMessage(state, "refreshing runs"),
        commands: [{ type: "refreshBrowser" }],
      };
    case "/":
      return {
        state: setPrompt(state, prompt("filter", "filter runs", state.browser.query)),
        commands: [],
      };
    case "w":
      return openSelectedDetail(state, true);
    case "R":
      return selectedLifecycle(state, "resume");
    case "t":
      return selectedLifecycle(state, "retry");
    case "s":
      return selectedPrompt(state, "signal", "signal: name [json]");
    default:
      return { state, commands: [] };
  }
}

function reduceDetailKey(state: TuiState, key: TuiKey): TuiInputResult {
  const runId = detailRunId(state);
  if (key.type === "escape") return backToBrowser(state);
  if (key.type !== "char") return { state, commands: [] };
  switch (key.value) {
    case "q":
      return { state: requestQuit(state), commands: [] };
    case "b":
      return backToBrowser(state);
    case "r":
      return runId
        ? {
            state: setStatusMessage(state, "refreshing run"),
            commands: [{ type: "refreshDetail", runId }],
          }
        : { state: setStatusMessage(state, "no run selected"), commands: [] };
    case "w":
      if (!runId) return { state: setStatusMessage(state, "no run selected"), commands: [] };
      if (state.watch.attached && state.watch.runId === runId) {
        return {
          state: setStatusMessage(state, "detaching watch"),
          commands: [{ type: "detachWatch" }],
        };
      }
      return {
        state: setStatusMessage(state, `watching ${runId}`),
        commands: [{ type: "attachWatch", runId }],
      };
    case "R":
      return detailLifecycle(state, "resume");
    case "t":
      return detailLifecycle(state, "retry");
    case "e":
      return runPrompt(state, "rewind", "rewind to step key");
    case "s":
      return runPrompt(state, "signal", "signal: name [json]");
    case "o":
      return runId
        ? {
            state: setStatusMessage(state, "loading output"),
            commands: [{ type: "output", runId }],
          }
        : { state: setStatusMessage(state, "no run selected"), commands: [] };
    case "a":
      if (!state.knownAdmin) {
        return {
          state: setStatusMessage(state, "approval requires admin credentials"),
          commands: [],
        };
      }
      return runPrompt(state, "approval", "approval: approve|deny key [note]");
    default:
      return { state, commands: [] };
  }
}

function openSelectedDetail(state: TuiState, watch: boolean): TuiInputResult {
  const run = selectedRun(state);
  if (!run) return { state: setStatusMessage(state, "no run selected"), commands: [] };
  const next = openDetailState(state, run.runId);
  return {
    state: next,
    commands: [
      { type: "refreshDetail", runId: run.runId },
      ...(watch ? [{ type: "attachWatch" as const, runId: run.runId }] : []),
    ],
  };
}

function selectedLifecycle(state: TuiState, action: "resume" | "retry"): TuiInputResult {
  const run = selectedRun(state);
  if (!run) return { state: setStatusMessage(state, "no run selected"), commands: [] };
  return {
    state: setStatusMessage(state, `${action} ${run.runId}`),
    commands: [{ type: "lifecycle", action, runId: run.runId, openDetailOnSuccess: true }],
  };
}

function detailLifecycle(state: TuiState, action: "resume" | "retry"): TuiInputResult {
  const runId = detailRunId(state);
  if (!runId) return { state: setStatusMessage(state, "no run selected"), commands: [] };
  return {
    state: setStatusMessage(state, `${action} ${runId}`),
    commands: [{ type: "lifecycle", action, runId }],
  };
}

function selectedPrompt(state: TuiState, kind: PromptKind, message: string): TuiInputResult {
  const run = selectedRun(state);
  if (!run) return { state: setStatusMessage(state, "no run selected"), commands: [] };
  return {
    state: setPrompt(state, prompt(kind, message, "", run.runId, true)),
    commands: [],
  };
}

function runPrompt(state: TuiState, kind: PromptKind, message: string): TuiInputResult {
  const runId = detailRunId(state);
  if (!runId) return { state: setStatusMessage(state, "no run selected"), commands: [] };
  return { state: setPrompt(state, prompt(kind, message, "", runId)), commands: [] };
}

function backToBrowser(state: TuiState): TuiInputResult {
  return {
    state: returnToBrowserState(state),
    commands: state.watch.attached ? [{ type: "detachWatch" }] : [],
  };
}

function prompt(
  kind: PromptKind,
  message: string,
  value = "",
  runId?: string,
  openDetailOnSuccess?: boolean,
): PromptState {
  return {
    kind,
    message,
    value,
    ...(runId ? { runId } : {}),
    ...(openDetailOnSuccess ? { openDetailOnSuccess } : {}),
  };
}

function approvalDecision(value: string): "approved" | "denied" {
  if (value === "approve" || value === "approved" || value === "a") return "approved";
  if (value === "deny" || value === "denied" || value === "d") return "denied";
  throw new Error("approval decision must be approve or deny");
}
