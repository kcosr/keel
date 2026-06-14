// The Keel RPC wire contract (DESIGN.md §6.2, §7.3) — FROZEN as of Phase 11.
//
// Every client (CLI, web, MCP, SDK) speaks exactly this. In Phase 11 it runs over
// an in-process transport; the Phase 12 daemon implements the SAME interface over
// a Unix socket, so the extraction is a transport swap, not a redesign. Adding
// methods is allowed; changing an existing method's shape is a breaking change.

import type { Blockage, RunProjection, RunReport, RunSummary } from "./projection.ts";

export type WorkflowProvenance = { kind: "stdin" } | { kind: "clientPath"; path: string };

export interface LaunchRequest {
  /** Workflow TypeScript captured by the client. The daemon never reads client paths. */
  source: string;
  input: unknown;
  /** Daemon-resolvable default target inherited by agents in this run. */
  target?: string;
  /** Optional display label; absent/null is stored as an unnamed run. */
  name?: string | null;
  /** Display-only provenance. It is never opened or parsed for execution. */
  provenance?: WorkflowProvenance;
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

export interface InterruptRunResult {
  runId: string;
  status: "interrupted";
}

export interface RunLaunchResult {
  runId: string;
  capability?: string;
  capabilityId?: string;
}

export interface RunWorkspaceView {
  runId: string;
  agentKey: string;
  workspacePath: string;
  target: string;
  baseCommit: string;
  status: string;
  lastTurnKey: string | null;
  lastTurnAttempt: number | null;
  lastDiffEventSeq: number | null;
  lastErrorEventSeq: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  mergedAtMs: number | null;
  discardedAtMs: number | null;
}

export interface RunWorkspaceDiff {
  workspace: RunWorkspaceView;
  modified: string[];
  added: string[];
  deleted: string[];
  contentDiff: string;
}

export interface WorkspaceGcResult {
  removed: RunWorkspaceView[];
}

export interface DurableEventEnvelope {
  kind: "durable";
  seq: number;
  type: string;
  payload: unknown;
  atMs: number;
}

export interface EphemeralEventEnvelope {
  kind: "ephemeral";
  type: string;
  payload: unknown;
  atMs: number;
}

export type EventEnvelope = DurableEventEnvelope | EphemeralEventEnvelope;

export interface KeelApi {
  /** Start a run; returns its id immediately (the run executes in the background). */
  launchRun(req: LaunchRequest): Promise<RunLaunchResult>;
  /** Resume a non-terminal run in the background. */
  resumeRun(runId: string): Promise<RunStart>;
  /** Park a non-terminal run until an explicit resume. */
  interruptRun(runId: string, reason?: string): Promise<InterruptRunResult>;
  /** Re-execute a run against its stored definition or a new client-captured source. */
  rerunRun(
    runId: string,
    opts?: {
      source?: string;
      input?: unknown;
      name?: string | null;
      provenance?: WorkflowProvenance;
    },
  ): Promise<RunStart>;
  /** Re-run a failed run from its failed step in the background. */
  retryRun(runId: string): Promise<RunStart>;
  /** Discard everything after a step and re-run in the background. */
  rewindRun(runId: string, toStableKey: string): Promise<RunStart>;
  /** Copy a terminal run into a new independent run. */
  forkRun(runId: string, opts?: { atStableKey?: string; newRunId?: string }): RunLaunchResult;
  /** The canonical projection for one run. */
  getRun(runId: string): RunProjection | null;
  /** Post-run result digest from journaled node results. */
  getRunReport(runId: string): RunReport | null;
  /** Why is this run stuck? (§12.2). */
  getBlockage(runId: string): Blockage;
  /** Summaries of all runs. */
  listRuns(): RunSummary[];
  listRunWorkspaces(runId: string): Promise<RunWorkspaceView[]> | RunWorkspaceView[];
  getRunWorkspace(
    runId: string,
    agentKey: string,
  ): Promise<RunWorkspaceView | null> | RunWorkspaceView | null;
  getRunWorkspaceDiff(
    runId: string,
    agentKey: string,
  ): Promise<RunWorkspaceDiff> | RunWorkspaceDiff;
  mergeRunWorkspace(runId: string, agentKey: string): Promise<RunWorkspaceView> | RunWorkspaceView;
  discardRunWorkspace(
    runId: string,
    agentKey: string,
  ): Promise<RunWorkspaceView> | RunWorkspaceView;
  gcWorkspaces(opts?: {
    olderThanMs?: number;
    includePending?: boolean;
  }): Promise<WorkspaceGcResult> | WorkspaceGcResult;
  /** Await a run's next terminal or parked status and return its outcome. */
  waitForRun(runId: string): Promise<RunOutcome>;
  /** Return a run's terminal output without subscribing to events. */
  getRunOutput(runId: string): Promise<RunOutcome>;
  /** Prune unreferenced workflow definition rows and cache entries. */
  gcDefinitions(opts?: { ttlMs?: number; cacheMinAgeMs?: number }): Promise<{
    workflowDefinitionsRemoved: number;
    definitionCacheEntriesRemoved: number;
  }>;
  /** Subscribe to a run's events after `afterSeq`; returns an unsubscribe fn. */
  subscribeEvents(
    runId: string,
    afterSeq: number,
    onEvent: (event: EventEnvelope) => void,
  ): () => void;
}
