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
import type {
  SavedWorkflowSummary,
  SavedWorkflowVersionView,
  SavedWorkflowView,
} from "../journal/store.ts";
import type { SettingClass, SettingView, SettingsDiagnostic } from "../settings/catalog.ts";
import type { WorkflowSourceInput } from "../workflow-definitions/source.ts";
import type {
  Blockage,
  RunProjection,
  RunReport,
  RunSummary,
  ScheduleErrorProjection,
  ScheduleSummary,
  ScheduleView,
} from "./projection.ts";

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

export interface SaveWorkflowRequest {
  name: string;
  source: WorkflowSourceInput;
  workflowName?: string | null;
  provenance?: WorkflowProvenance;
  title?: string | null;
  description?: string | null;
  tags?: string[];
  inputSchema?: unknown;
  defaultInput?: unknown;
  defaultTarget?: string | null;
  metadata?: unknown;
  version?: number;
  allowDuplicateDefinition?: boolean;
}

export interface PreviewWorkflowDefinitionRequest {
  source: WorkflowSourceInput;
}

export interface PreviewWorkflowDefinitionResult {
  definitionHash: string;
}

export interface SavedWorkflowRef {
  name: string;
  version?: number | "latest";
  allowDeprecated?: boolean;
}

export interface LaunchSavedWorkflowRequest {
  ref: SavedWorkflowRef;
  input?: unknown;
  target?: string;
  name?: string | null;
}

export interface SavedWorkflowSourceView {
  name: string;
  version: number;
  definitionHash: string;
  entry: string;
  files: Array<{ path: string; code: string; entry: boolean }>;
}

export type WorkflowDefinitionSourceLookup =
  | { kind: "run"; runId: string }
  | { kind: "definition"; definitionHash: string };

export interface GetWorkflowDefinitionSourceRequest {
  lookup: WorkflowDefinitionSourceLookup;
  file?: string;
  all?: boolean;
}

export interface WorkflowDefinitionSourceView {
  kind: "workflow-definition-source";
  lookup: WorkflowDefinitionSourceLookup;
  definitionHash: string;
  definitionName: string | null;
  createdAtMs: number;
  entry: string;
  files: Array<{ path: string; code: string; entry: boolean }>;
}

export type PutScheduleBaseRequest = {
  name: string;
  input?: unknown;
  target?: string;
  intervalMs: number;
  firstFireMs?: number;
};

export type PutScheduleRequest =
  | (PutScheduleBaseRequest & {
      source: WorkflowSourceInput;
      workflowName?: string | null;
      savedRef?: never;
    })
  | (PutScheduleBaseRequest & {
      savedRef: SavedWorkflowRef;
      source?: never;
      workflowName?: never;
    });

export interface ListSchedulesRequest {
  includeDisabled?: boolean;
}

export interface GetScheduleRequest {
  name: string;
  includeSource?: boolean;
}

export type { SavedWorkflowSummary, SavedWorkflowVersionView, SavedWorkflowView };
export type { ScheduleErrorProjection, ScheduleSummary, ScheduleView };

export interface RunOutcome {
  runId: string;
  status: RunProjection["status"];
  output?: unknown;
  error?: { name: string; message: string } | null;
}

export interface RunStart {
  runId: string;
  status: RunProjection["status"];
  attachCursor: EventCursor;
}

export interface InterruptRunResult {
  runId: string;
  status: "interrupted";
}

export interface RunLaunchResult {
  runId: string;
  attachCursor: EventCursor;
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
  worktreeCheckoutKind?: "detached" | "branch" | null;
  worktreeBranchOwned?: boolean;
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

export const MAX_EVENT_TAIL_COUNT = 10_000;

export type EventCursorInput =
  | { kind: "beginning" }
  | { kind: "after-seq"; seq: number }
  | { kind: "tail"; count: number }
  | { kind: "now" };

export interface EventCursor {
  kind: "after-seq";
  runId: string;
  seq: number;
}

export type StreamControlFrame =
  | { kind: "control"; type: "caught-up"; cursor: EventCursor }
  | { kind: "control"; type: "closed"; cursor: EventCursor; status: string }
  | {
      kind: "control";
      type: "authorization.failed";
      cursor: EventCursor;
      payload: { message: string };
    };

export type EventStreamFrame = EventEnvelope | StreamControlFrame;

export interface SubscribeEventsRequest {
  runId: string;
  cursor?: EventCursorInput;
  includeControlFrames?: boolean;
}

export interface SubscribeEventsResult {
  subId: string;
  cursor: EventCursor;
  closedStatus: string | null;
}

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
  saveWorkflow(
    req: SaveWorkflowRequest,
  ): Promise<SavedWorkflowVersionView> | SavedWorkflowVersionView;
  previewWorkflowDefinition(
    req: PreviewWorkflowDefinitionRequest,
  ): Promise<PreviewWorkflowDefinitionResult> | PreviewWorkflowDefinitionResult;
  listSavedWorkflows(opts?: {
    includeDisabled?: boolean;
    includeDeprecated?: boolean;
    includeDeleted?: boolean;
  }): Promise<SavedWorkflowSummary[]> | SavedWorkflowSummary[];
  getSavedWorkflow(name: string): Promise<SavedWorkflowView | null> | SavedWorkflowView | null;
  getSavedWorkflowSource(req: {
    name: string;
    version?: number | "latest";
    file?: string;
    all?: boolean;
    allowDeprecated?: boolean;
  }): Promise<SavedWorkflowSourceView> | SavedWorkflowSourceView;
  getWorkflowDefinitionSource(
    req: GetWorkflowDefinitionSourceRequest,
  ): Promise<WorkflowDefinitionSourceView> | WorkflowDefinitionSourceView;
  launchSavedWorkflow(req: LaunchSavedWorkflowRequest): Promise<RunLaunchResult>;
  setSavedWorkflowDisabled(
    name: string,
    disabled: boolean,
  ): Promise<SavedWorkflowView> | SavedWorkflowView;
  setSavedWorkflowVersionEnabled(
    name: string,
    version: number,
    enabled: boolean,
  ): Promise<SavedWorkflowVersionView> | SavedWorkflowVersionView;
  deprecateSavedWorkflowVersion(req: {
    name: string;
    version: number;
    message?: string | null;
  }): Promise<SavedWorkflowVersionView> | SavedWorkflowVersionView;
  deleteSavedWorkflow(name: string): Promise<SavedWorkflowView> | SavedWorkflowView;
  deleteSavedWorkflowVersion(
    name: string,
    version: number,
  ): Promise<SavedWorkflowVersionView> | SavedWorkflowVersionView;
  putSchedule(req: PutScheduleRequest): Promise<{ ok: boolean }> | { ok: boolean };
  listSchedules(req?: ListSchedulesRequest): Promise<ScheduleSummary[]> | ScheduleSummary[];
  getSchedule(req: GetScheduleRequest): Promise<ScheduleView | null> | ScheduleView | null;
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
  /** Subscribe to a run's events; returns an unsubscribe fn. */
  subscribeEvents(
    req: SubscribeEventsRequest,
    onEvent: (event: EventEnvelope) => void,
    onControl?: (frame: StreamControlFrame) => void,
  ): () => void;
}
