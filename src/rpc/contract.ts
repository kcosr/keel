// The Keel RPC wire contract (DESIGN.md §6.2, §7.3) — FROZEN as of Phase 11.
//
// Every client (CLI, web, MCP, SDK) speaks exactly this. In Phase 11 it runs over
// an in-process transport; the Phase 12 daemon implements the SAME interface over
// a Unix socket, so the extraction is a transport swap, not a redesign. Adding
// methods is allowed; changing an existing method's shape is a breaking change.

import type {
  AgentProfileCheckResult,
  AgentProfileSource,
  AgentProfileView,
  PersistentAgentProfileConfig,
} from "../agents/profiles.ts";
import type { SettingClass, SettingView, SettingsDiagnostic } from "../settings/catalog.ts";
import type { WorkflowSourceInput } from "../workflow-definitions/source.ts";
import type { Blockage, RunProjection, RunReport, RunSummary } from "./projection.ts";

export type WorkflowProvenance = { kind: "stdin" } | { kind: "clientPath"; path: string };

export interface LaunchRequest {
  /** Workflow TypeScript captured by the client. The daemon never reads client paths. */
  source: WorkflowSourceInput;
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
  workspaceId: string;
  mode: "direct" | "worktree" | "copy" | "clone";
  ownerKind: "workflow" | "agent" | "agent_session";
  key: string;
  lastAttempt: number | null;
  retentionPolicy: "remove" | "retain-on-failure" | "retain" | null;
  workspacePath: string;
  sourceKind:
    | "direct-path"
    | "local-copy"
    | "worktree-git"
    | "local-clone-git"
    | "remote-git"
    | null;
  sourcePath: string | null;
  sourceUri: string | null;
  sourceBare: boolean | null;
  sourceMergeEligible: boolean;
  suppliedPath: string | null;
  sourceRef: string | null;
  resolvedRef: string | null;
  checkoutBranch: string | null;
  baseCommit: string | null;
  copyBaselinePath: string | null;
  owned: boolean;
  status: string;
  failureSeen: boolean;
  lastTurnKey: string | null;
  lastTurnAttempt: number | null;
  activeHolderKind: "workflow" | "agent" | "agent_session" | null;
  activeHolderKey: string | null;
  activeHolderAttempt: number | null;
  activeStartedAtMs: number | null;
  lastDiffEventSeq: number | null;
  lastErrorEventSeq: number | null;
  cleanupError: unknown | null;
  mergeSupported: boolean;
  diffSupported: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  mergedAtMs: number | null;
  discardedAtMs: number | null;
  removedAtMs: number | null;
}

export interface RunWorkspaceDiff {
  workspace: RunWorkspaceView;
  modified: string[];
  added: string[];
  deleted: string[];
  omittedPathCounts: {
    modified: number;
    added: number;
    deleted: number;
  };
  pathLimit: number;
  contentDiff: string;
  mode: "worktree" | "copy" | "clone";
  diffKind: "git-patch" | "recursive-copy";
  baseLabel: string;
  workspaceLabel: string;
  fileChanges: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "type_changed";
    oldMode?: string | null;
    newMode?: string | null;
    oldSymlinkTarget?: string | null;
    newSymlinkTarget?: string | null;
    binary?: boolean;
    textDiffIncluded?: boolean;
  }>;
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

export interface PutAgentProfileRequest {
  name: string;
  config: PersistentAgentProfileConfig;
  ifGeneration?: number;
  createOnly?: boolean;
  updateOnly?: boolean;
}

export interface DeleteAgentProfileRequest {
  name: string;
  ifGeneration?: number;
}

export interface CheckAgentProfileRequest {
  name?: string;
  config?: PersistentAgentProfileConfig;
  connect?: boolean;
}

export type { AgentProfileCheckResult, AgentProfileSource, AgentProfileView };
export type { SettingClass, SettingView, SettingsDiagnostic };

export interface PutSettingRequest {
  key: string;
  value: unknown;
  ifGeneration?: number;
}

export interface DeleteSettingRequest {
  key: string;
  ifGeneration?: number;
}

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
      source?: WorkflowSourceInput;
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
  listRunWorkspaces(
    runId: string,
    opts?: { includeRemoved?: boolean },
  ): Promise<RunWorkspaceView[]> | RunWorkspaceView[];
  getRunWorkspace(
    runId: string,
    workspaceId: string,
  ): Promise<RunWorkspaceView | null> | RunWorkspaceView | null;
  getRunWorkspaceDiff(
    runId: string,
    workspaceId: string,
  ): Promise<RunWorkspaceDiff> | RunWorkspaceDiff;
  mergeRunWorkspace(
    runId: string,
    workspaceId: string,
  ): Promise<RunWorkspaceView> | RunWorkspaceView;
  discardRunWorkspace(
    runId: string,
    workspaceId: string,
  ): Promise<RunWorkspaceView> | RunWorkspaceView;
  gcWorkspaces(opts?: {
    olderThanMs?: number;
    includePending?: boolean;
    includeRemoved?: boolean;
  }): Promise<WorkspaceGcResult> | WorkspaceGcResult;
  listAgentProfiles(opts?: {
    source?: "all" | "catalog" | "programmatic";
  }): Promise<AgentProfileView[]> | AgentProfileView[];
  getAgentProfile(name: string): Promise<AgentProfileView | null> | AgentProfileView | null;
  putAgentProfile(req: PutAgentProfileRequest): Promise<AgentProfileView> | AgentProfileView;
  deleteAgentProfile(
    req: DeleteAgentProfileRequest,
  ): Promise<{ name: string; deleted: true }> | { name: string; deleted: true };
  checkAgentProfile(
    req: CheckAgentProfileRequest,
  ): Promise<AgentProfileCheckResult> | AgentProfileCheckResult;
  listSettings(): Promise<SettingView[]> | SettingView[];
  getSetting(key: string): Promise<SettingView | null> | SettingView | null;
  putSetting(req: PutSettingRequest): Promise<SettingView> | SettingView;
  deleteSetting(
    req: DeleteSettingRequest,
  ): Promise<{ key: string; deleted: boolean }> | { key: string; deleted: boolean };
  checkSetting(req: {
    key: string;
    value: unknown;
  }):
    | Promise<{ ok: boolean; diagnostics: SettingsDiagnostic[] }>
    | {
        ok: boolean;
        diagnostics: SettingsDiagnostic[];
      };
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
