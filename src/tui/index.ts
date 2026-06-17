import { redactCapabilityTokens } from "../auth/redaction.ts";
import type { DaemonClient } from "../daemon/client.ts";
import type {
  EventEnvelope,
  RunOutcome,
  RunStart,
  SubscribeEventsRequest,
  SubscribeEventsResult,
} from "../rpc/contract.ts";
import type { Blockage, RunProjection, RunReport, RunSummary } from "../rpc/projection.ts";
import { createTuiWatchFormatter } from "./events.ts";
import {
  type TuiCommand,
  type TuiKey,
  type TuiKeyParseState,
  parseTuiKeyChunk,
  reduceTuiKey,
} from "./input.ts";
import {
  type TuiState,
  appendWatchLines,
  createTuiState,
  lastSeqForRun,
  markWatchCaughtUp,
  openDetailState,
  setBrowserError,
  setBrowserRuns,
  setDetailData,
  setDetailOutput,
  setNow,
  setStatusMessage,
  startWatchState,
  stopWatchState,
} from "./state.ts";
import {
  type TerminalIo,
  assertInteractiveTerminal,
  installTerminalRestoreGuards,
  terminalDimensions,
  withTerminalSession,
} from "./terminal.ts";
import { renderAnsiFrame } from "./views.ts";

export interface TuiClient {
  listRuns(): Promise<RunSummary[]>;
  getRun(runId: string): Promise<RunProjection | null>;
  getRunReport(runId: string): Promise<RunReport | null>;
  getBlockage(runId: string): Promise<Blockage>;
  resumeRun(runId: string): Promise<RunStart>;
  retryRun(runId: string): Promise<RunStart>;
  rewindRun(runId: string, toStableKey: string): Promise<RunStart>;
  decideApproval(
    runId: string,
    key: string,
    decision: { status: "approved" | "denied"; note?: string },
  ): Promise<{ status: string }>;
  sendSignal(runId: string, name: string, payload: unknown): Promise<{ status: string }>;
  getRunOutput(runId: string): Promise<RunOutcome>;
  subscribeEvents(
    req: SubscribeEventsRequest,
    onEvent: (event: EventEnvelope) => void,
    onError?: (err: unknown) => void,
    onCaughtUp?: (result: SubscribeEventsResult) => void,
  ): () => void;
}

export interface RunTuiOptions extends TerminalIo {
  clientFactory: () => Promise<TuiClient | DaemonClient>;
  runId?: string;
  status?: string;
  limit?: number;
  knownAdmin?: boolean;
}

// Match common terminal escape-timeout behavior closely enough to reassemble
// split arrow/CSI reads without making a literal Escape key feel stuck.
const LONE_ESCAPE_FLUSH_MS = 100;

export async function runTui(options: RunTuiOptions): Promise<number> {
  assertInteractiveTerminal(options);
  const client = await options.clientFactory();
  let state = createTuiState({
    runId: options.runId,
    status: options.status,
    limit: options.limit,
    knownAdmin: options.knownAdmin,
  });
  let unsubscribeWatch: (() => void) | null = null;

  await withTerminalSession(options, async (session) => {
    const cleanupGuards = installTerminalRestoreGuards(session, options.process ?? process);
    await new Promise<void>((resolve) => {
      let closed = false;
      let commandQueue = Promise.resolve();
      let interval: ReturnType<typeof setInterval> | null = null;
      let keyParseState: TuiKeyParseState = { pending: "" };
      let loneEscapeTimer: ReturnType<typeof setTimeout> | null = null;

      const render = () => {
        if (closed) return;
        options.stdout.write(renderAnsiFrame(state, terminalDimensions(options.stdout)));
      };
      const clearLoneEscapeTimer = () => {
        if (!loneEscapeTimer) return;
        clearTimeout(loneEscapeTimer);
        loneEscapeTimer = null;
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        clearLoneEscapeTimer();
        options.stdin.off?.("data", onData);
        cleanupGuards();
        if (unsubscribeWatch) {
          unsubscribeWatch();
          unsubscribeWatch = null;
        }
        resolve();
      };
      const enqueue = (commands: readonly TuiCommand[]) => {
        commandQueue = commandQueue
          .then(async () => {
            if (closed) return;
            for (const command of commands) {
              if (closed) return;
              await executeCommand(command);
            }
          })
          .catch((err) => {
            state = setStatusMessage(state, errorMessage(err));
            render();
          });
      };
      const reduceParsedKey = (key: TuiKey): boolean => {
        const result = reduceTuiKey(state, key);
        state = result.state;
        render();
        enqueue(result.commands);
        if (state.quit) {
          close();
          return true;
        }
        return false;
      };
      const flushPendingEscape = () => {
        loneEscapeTimer = null;
        if (closed || !keyParseState.pending) return;
        const pending = keyParseState.pending;
        keyParseState = { pending: "" };
        if (pending === "\u001b") reduceParsedKey({ type: "escape" });
      };
      const schedulePendingEscapeFlush = () => {
        clearLoneEscapeTimer();
        if (keyParseState.pending === "\u001b") {
          loneEscapeTimer = setTimeout(flushPendingEscape, LONE_ESCAPE_FLUSH_MS);
        }
      };
      const onData = (data: Buffer) => {
        try {
          clearLoneEscapeTimer();
          const parsed = parseTuiKeyChunk(data, keyParseState);
          keyParseState = parsed.state;
          for (const key of parsed.keys) {
            if (reduceParsedKey(key)) return;
          }
          schedulePendingEscapeFlush();
        } catch (err) {
          state = setStatusMessage(state, errorMessage(err));
          render();
        }
      };

      const executeCommand = async (command: TuiCommand): Promise<void> => {
        switch (command.type) {
          case "refreshBrowser":
            await refreshBrowser();
            return;
          case "refreshDetail":
            await refreshDetail(command.runId);
            return;
          case "attachWatch":
            attachWatch(command.runId);
            return;
          case "detachWatch":
            detachWatch();
            return;
          case "lifecycle":
            await runLifecycle(command.action, command.runId, command.openDetailOnSuccess ?? false);
            return;
          case "rewind":
            await runRewind(command.runId, command.stableKey);
            return;
          case "signal":
            await sendSignal(
              command.runId,
              command.name,
              command.payload,
              command.openDetailOnSuccess ?? false,
            );
            return;
          case "approval":
            await decideApproval(command.runId, command.key, command.decision, command.note);
            return;
          case "output":
            await loadOutput(command.runId);
            return;
        }
      };

      const refreshBrowser = async () => {
        try {
          const runs = await client.listRuns();
          state = setBrowserRuns(state, runs);
        } catch (err) {
          const message = `${errorMessage(err)}; global browser requires admin. Try: keel tui <runId>`;
          state = setBrowserError(state, message);
        }
        render();
      };

      const refreshDetail = async (runId: string) => {
        try {
          const [projection, report, blockage] = await Promise.all([
            client.getRun(runId),
            client.getRunReport(runId),
            client.getBlockage(runId),
          ]);
          state = setDetailData(state, { projection, report, blockage });
          if (!projection && !report) state = setStatusMessage(state, `run ${runId} not found`);
        } catch (err) {
          state = setStatusMessage(state, errorMessage(err));
        }
        render();
      };

      const attachWatch = (runId: string) => {
        detachWatch(null);
        const seq = lastSeqForRun(state, runId);
        state = startWatchState(state, runId);
        render();
        const formatter = createTuiWatchFormatter();
        let localUnsubscribe = () => {};
        const isCurrentSubscription = () =>
          unsubscribeWatch === localUnsubscribe &&
          state.watch.attached &&
          state.watch.runId === runId;
        localUnsubscribe = client.subscribeEvents(
          { runId, cursor: seq === 0 ? { kind: "beginning" } : { kind: "after-seq", seq } },
          (event) => {
            if (!isCurrentSubscription()) return;
            const formatted = formatter.push(event);
            state = appendWatchLines(state, event, formatted);
            if (formatted.authorizationFailedMessage) {
              state = stopWatchState(state, formatted.authorizationFailedMessage);
              localUnsubscribe();
              if (unsubscribeWatch === localUnsubscribe) unsubscribeWatch = null;
            }
            render();
          },
          (err) => {
            if (!isCurrentSubscription()) return;
            state = stopWatchState(state, `watch error: ${errorMessage(err)}`);
            localUnsubscribe();
            if (unsubscribeWatch === localUnsubscribe) unsubscribeWatch = null;
            render();
          },
          () => {
            if (!isCurrentSubscription()) return;
            state = markWatchCaughtUp(state);
            render();
          },
        );
        unsubscribeWatch = localUnsubscribe;
      };

      const detachWatch = (message: string | null = "watch detached") => {
        if (unsubscribeWatch) {
          unsubscribeWatch();
          unsubscribeWatch = null;
        }
        if (message !== null) state = stopWatchState(state, message);
        render();
      };

      const runLifecycle = async (
        action: "resume" | "retry",
        runId: string,
        openDetailOnSuccess: boolean,
      ) => {
        try {
          const out =
            action === "resume" ? await client.resumeRun(runId) : await client.retryRun(runId);
          if (closed) return;
          state = setStatusMessage(state, `${action} accepted: ${out.status}`);
          if (openDetailOnSuccess) state = openDetailState(state, runId);
          await refreshDetail(runId);
          if (closed) return;
          attachWatch(runId);
        } catch (err) {
          state = setStatusMessage(state, errorMessage(err));
          render();
        }
      };

      const runRewind = async (runId: string, stableKey: string) => {
        try {
          const out = await client.rewindRun(runId, stableKey);
          if (closed) return;
          state = setStatusMessage(state, `rewind accepted: ${out.status}`);
          await refreshDetail(runId);
          if (closed) return;
          attachWatch(runId);
        } catch (err) {
          state = setStatusMessage(state, errorMessage(err));
          render();
        }
      };

      const sendSignal = async (
        runId: string,
        name: string,
        payload: unknown,
        openDetailOnSuccess: boolean,
      ) => {
        try {
          const out = await client.sendSignal(runId, name, payload);
          if (closed) return;
          state = setStatusMessage(state, `signal delivered: ${out.status}`);
          if (openDetailOnSuccess) state = openDetailState(state, runId);
          await refreshDetail(runId);
          if (closed) return;
          attachWatch(runId);
        } catch (err) {
          state = setStatusMessage(state, errorMessage(err));
          render();
        }
      };

      const decideApproval = async (
        runId: string,
        key: string,
        decision: "approved" | "denied",
        note?: string,
      ) => {
        if (!state.knownAdmin) {
          state = setStatusMessage(state, "approval requires admin credentials");
          render();
          return;
        }
        try {
          const out = await client.decideApproval(runId, key, {
            status: decision,
            ...(note ? { note } : {}),
          });
          if (closed) return;
          state = setStatusMessage(state, `approval ${decision}: ${out.status}`);
          await refreshDetail(runId);
          if (closed) return;
          attachWatch(runId);
        } catch (err) {
          state = setStatusMessage(state, errorMessage(err));
          render();
        }
      };

      const loadOutput = async (runId: string) => {
        try {
          const out = await client.getRunOutput(runId);
          if (out.status !== "finished") {
            state = setStatusMessage(
              state,
              `run ${runId} is ${out.status}; no terminal output available`,
            );
          } else {
            state = setDetailOutput(state, formatOutput(out.output));
          }
        } catch (err) {
          state = setStatusMessage(state, errorMessage(err));
        }
        render();
      };

      interval = setInterval(() => {
        try {
          state = setNow(state, Date.now());
          render();
        } catch (err) {
          close();
          throw err;
        }
      }, 1_000);

      options.stdin.on?.("data", onData);
      render();
      enqueue(
        options.runId
          ? [{ type: "refreshDetail", runId: options.runId }]
          : [{ type: "refreshBrowser" }],
      );
    });
  });
  return 0;
}

function errorMessage(err: unknown): string {
  return redactCapabilityTokens(err instanceof Error ? err.message : String(err));
}

function formatOutput(output: unknown): string {
  if (typeof output === "string") return redactCapabilityTokens(output);
  return redactCapabilityTokens(JSON.stringify(output ?? null, null, 2));
}
