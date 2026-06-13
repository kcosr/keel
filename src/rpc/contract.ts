// The Keel RPC wire contract (DESIGN.md §6.2, §7.3) — FROZEN as of Phase 11.
//
// Every client (CLI, web, MCP, SDK) speaks exactly this. In Phase 11 it runs over
// an in-process transport; the Phase 12 daemon implements the SAME interface over
// a Unix socket, so the extraction is a transport swap, not a redesign. Adding
// methods is allowed; changing an existing method's shape is a breaking change.

import type { Blockage, RunProjection, RunSummary } from "./projection.ts";

export interface LaunchRequest {
  /** The workflow definition: a module path (Phase 11) or inline source (Phase 12, §7.5). */
  workflowUrl: string;
  input: unknown;
  name: string;
}

export interface RunOutcome {
  runId: string;
  status: RunProjection["status"];
  output?: unknown;
  error?: { name: string; message: string } | null;
}

export interface RunStart {
  runId: string;
  status: RunProjection["status"];
}

export interface RunLaunchResult {
  runId: string;
  capability?: string;
  capabilityId?: string;
}

export interface EventEnvelope {
  seq: number;
  type: string;
  payload: unknown;
  atMs: number;
}

export interface KeelApi {
  /** Start a run; returns its id immediately (the run executes in the background). */
  launchRun(req: LaunchRequest): Promise<RunLaunchResult>;
  /** Resume a non-terminal run in the background. */
  resumeRun(runId: string): Promise<RunStart>;
  /** Re-execute a run against (possibly edited) code in the background. */
  rerunRun(runId: string, opts?: { workflowUrl?: string; input?: unknown }): Promise<RunStart>;
  /** Re-run a failed run from its failed step in the background. */
  retryRun(runId: string): Promise<RunStart>;
  /** Discard everything after a step and re-run in the background. */
  rewindRun(runId: string, toStableKey: string): Promise<RunStart>;
  /** Copy a terminal run into a new independent run. */
  forkRun(runId: string, opts?: { atStableKey?: string; newRunId?: string }): RunLaunchResult;
  /** The canonical projection for one run. */
  getRun(runId: string): RunProjection | null;
  /** Why is this run stuck? (§12.2). */
  getBlockage(runId: string): Blockage;
  /** Summaries of all runs. */
  listRuns(): RunSummary[];
  /** Await a run's completion (terminal status) and return its outcome. */
  waitForRun(runId: string): Promise<RunOutcome>;
  /** Subscribe to a run's events after `afterSeq`; returns an unsubscribe fn. */
  subscribeEvents(
    runId: string,
    afterSeq: number,
    onEvent: (event: EventEnvelope) => void,
  ): () => void;
}
