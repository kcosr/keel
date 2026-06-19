export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RunStatus =
  | "running"
  | "waiting-human"
  | "waiting-signal"
  | "waiting-timer"
  | "waiting-approval"
  | "interrupted"
  | "finished"
  | "failed"
  | "cancelled"
  | "continued";

export type JournalStatus = "pending" | "completed" | "failed";
export type EffectType = "pure" | "effectful" | "ambient";

export interface GatewayErrorEnvelope {
  code?: string;
  message: string;
  action?: string;
  resource?: unknown;
}

export interface HealthResponse {
  ok: boolean;
  web: { ok: boolean; apiOnly: boolean };
  daemon: {
    reachable: boolean;
    ok?: boolean;
    ownerId?: string;
    error?: GatewayErrorEnvelope;
    [key: string]: unknown;
  };
  bundle: {
    available: boolean;
    indexMtimeMs?: number;
    indexSizeBytes?: number;
  };
}

export interface NodeView {
  stableKey: string;
  effectType: EffectType;
  status: JournalStatus;
  attempt: number;
  startedAtMs: number | null;
  dependsOn: string[];
  artifactBacked: boolean;
}

export interface RunStats {
  steps: number;
  agents: number;
  artifacts: number;
}

export interface RunSummary {
  runId: string;
  workflowName: string | null;
  status: RunStatus;
  runTarget?: string | null;
  createdAtMs: number;
  finishedAtMs: number | null;
  parentRunId: string | null;
}

export interface RunProjection extends RunSummary {
  definitionVersion: string;
  nodes: NodeView[];
  phase: string | null;
  error: { name: string; message: string } | null;
  stats: RunStats;
}

export type BlockageReason =
  | "none"
  | "running"
  | "agent_concurrency"
  | "stalled_no_heartbeat"
  | "waiting_human"
  | "waiting_signal"
  | "waiting_timer"
  | "waiting_child"
  | "interrupted";

export interface Blockage {
  reason: BlockageReason;
  blockedOn: { stableKey: string; since: number } | null;
  context: string;
  interrupted?: {
    reason?: string;
    previousStatus: string;
    phase: string | null;
    wait: { kind?: string; key?: string; until?: number } | null;
  };
  agentConcurrency?: unknown;
}

export interface RunListItem extends RunSummary {
  run: RunProjection | null;
  blockage: Blockage | null;
  workspaceSummary: { count: number };
}

export interface RunsResponse {
  runs: RunListItem[];
  page: {
    limit: number;
    defaultLimit: number;
    maxLimit: number;
    returned: number;
    total: number;
    truncated: boolean;
  };
}

export interface ReportNodeView extends NodeView {
  result?: unknown;
  resultOmitted?: true;
  resultByteLength?: number;
}

export interface RunReport {
  runId: string;
  workflowName: string | null;
  status: RunStatus;
  createdAtMs: number;
  finishedAtMs: number | null;
  output?: unknown;
  outputOmitted?: true;
  outputByteLength?: number;
  error: { name: string; message: string } | null;
  blockage?: Blockage;
  nodes: ReportNodeView[];
  stats: RunStats;
}

export interface WorkflowDefinitionSourceView {
  kind: "workflow-definition-source";
  lookup: unknown;
  definitionHash: string;
  definitionName: string | null;
  createdAtMs: number;
  entry: string;
  files: Array<{ path: string; code: string; entry: boolean }>;
}

export interface EventCursor {
  kind: "after-seq";
  runId: string;
  seq: number;
}

export type EventCursorInput =
  | { kind: "beginning" }
  | { kind: "after-seq"; seq: number }
  | { kind: "tail"; count: number }
  | { kind: "now" };

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

export type StreamControlFrame =
  | { kind: "control"; type: "caught-up"; cursor: EventCursor }
  | { kind: "control"; type: "closed"; cursor: EventCursor; status: string }
  | {
      kind: "control";
      type: "authorization.failed";
      cursor: EventCursor;
      payload: { message: string };
    };

export type EventStreamFrame = DurableEventEnvelope | EphemeralEventEnvelope | StreamControlFrame;

export interface RunDetailResponse {
  run: RunProjection | null;
  report: RunReport | null;
  blockage: Blockage | null;
  workspaces: RunWorkspaceView[];
  source: WorkflowDefinitionSourceView | null;
  flow: WorkflowFlowView | null;
  events: EventStreamFrame[];
  eventCursor: EventCursor | null;
  rawEvents: { href: string };
  availableCommands: Array<{ name: string; requiredAuthority: string }>;
}

export type WorkflowOperationKind =
  | "phase"
  | "step"
  | "agent"
  | "agentSession"
  | "agentTurn"
  | "sleep"
  | "human"
  | "signal"
  | "return";

export interface WorkflowExprSummary {
  kind: string;
  text: string;
  static: boolean;
  value?: unknown;
}

export interface WorkflowFlowOperation {
  id: string;
  kind: WorkflowOperationKind;
  key?: WorkflowExprSummary;
  title?: WorkflowExprSummary;
  prompt?: WorkflowExprSummary;
  provider?: WorkflowExprSummary;
  model?: WorkflowExprSummary;
  profile?: WorkflowExprSummary;
  toolPolicy?: WorkflowExprSummary;
  reasoning?: WorkflowExprSummary;
  target?: WorkflowExprSummary;
  status?: WorkflowExprSummary;
  result?: WorkflowExprSummary;
  condition?: WorkflowExprSummary;
  sessionRef?: string;
  containers: string[];
  parallelLane?: number;
}

export interface WorkflowFlowView {
  entry: { name: string | null; async: boolean; params: string[] };
  input: {
    paramName: string;
    type: string | null;
    fields: Array<{
      name: string;
      type: string;
      optional: boolean;
      default?: WorkflowExprSummary;
      used: boolean;
    }>;
  } | null;
  operations: WorkflowFlowOperation[];
  diagnostics: Array<{ severity: "info" | "warning"; message: string }>;
}

export interface RunLaunchResult {
  runId: string;
  attachCursor: EventCursor;
  capability?: string;
  capabilityId?: string;
}

export interface ApprovalView {
  runId: string;
  runName: string | null;
  status: string;
  gateId: string | null;
  prompt: string;
  createdAtMs: number | null;
  requiredAuthority: "admin";
  cli: string | null;
}

export interface ApprovalsResponse {
  approvals: ApprovalView[];
  decisionAuthority: "admin";
  decisionAuthorized: boolean;
}

export interface RunWorkspaceView {
  runId: string;
  workspaceId: string;
  mode: "direct" | "worktree" | "copy" | "clone";
  ownerKind: "workflow" | "agent" | "agent_session" | "command" | "setup";
  key: string;
  lastAttempt: number | null;
  retentionPolicy: "remove" | "retain-on-failure" | "retain" | null;
  workspacePath: string;
  setupStatus: "none" | "pending" | "completed" | "failed";
  setupIdentityHash: string | null;
  setupStartedAtMs: number | null;
  setupFinishedAtMs: number | null;
  setupError: unknown | null;
  sourceKind: string | null;
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
  activeHolderKind: "workflow" | "agent" | "agent_session" | "command" | "setup" | null;
  activeHolderKey: string | null;
  activeHolderAttempt: number | null;
  activeStartedAtMs: number | null;
  lastDiffEventSeq: number | null;
  lastErrorEventSeq: number | null;
  cleanupError: unknown | null;
  mergeSupported: boolean;
  discardSupported: boolean;
  diffSupported: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  mergedAtMs: number | null;
  discardedAtMs: number | null;
  removedAtMs: number | null;
  [key: string]: unknown;
}

export interface WorkspacesResponse {
  workspaces: RunWorkspaceView[];
  mutationAuthority: "admin";
  mutationAuthorized: boolean;
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

export type ScheduleErrorProjection =
  | { kind: "none" }
  | { kind: "error"; error: { name?: string; message: string } }
  | { kind: "parse-error"; raw: string; message: string };

export interface ScheduleSummary {
  name: string;
  enabled: boolean;
  workflowRef: string;
  definitionState: "available" | "missing";
  workflowName: string | null;
  workflowKind: string | null;
  target: string | null;
  intervalMs: number;
  nextFireMs: number;
  lastRunId: string | null;
  lastRunStatus: RunStatus | null;
  lastFailedAtMs: number | null;
  lastError: ScheduleErrorProjection;
}

export interface ScheduleView extends ScheduleSummary {
  input: unknown;
  inputJson: string | null;
  source?: WorkflowDefinitionSourceView | null;
}

export interface SavedWorkflowVersionView {
  name: string;
  version: number;
  definitionHash: string;
  workflowName: string | null;
  inputSchema: unknown | null;
  inputSchemaSet: boolean;
  defaultInput: unknown | null;
  defaultInputSet: boolean;
  defaultTarget: string | null;
  metadata: unknown | null;
  sourceProvenance: unknown | null;
  createdBy: string | null;
  createdAtMs: number;
  enabled: boolean;
  deprecatedAtMs: number | null;
  deprecationMessage: string | null;
  deletedAtMs: number | null;
}

export interface SavedWorkflowView {
  name: string;
  title: string | null;
  description: string | null;
  tags: string[];
  createdAtMs: number;
  updatedAtMs: number;
  disabledAtMs: number | null;
  deletedAtMs: number | null;
  versions: SavedWorkflowVersionView[];
}

export interface SavedWorkflowSummary extends SavedWorkflowView {
  latestVersion: number | null;
  latestDefinitionHash: string | null;
}

export interface SavedWorkflowSourceView {
  name: string;
  version: number;
  definitionHash: string;
  entry: string;
  files: Array<{ path: string; code: string; entry: boolean }>;
}

export interface AgentProfileDiagnostic {
  level: "error" | "warning" | "info";
  path: string;
  message: string;
}

export interface AgentProfileCheckResult {
  ok: boolean;
  diagnostics: AgentProfileDiagnostic[];
}

export interface AgentProfileView {
  name: string;
  source: "catalog" | "programmatic";
  config: Record<string, unknown>;
  configHash: string;
  generation: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

export interface SettingsDiagnostic {
  level: "error" | "warning" | "info";
  path: string;
  message: string;
}

export interface SettingView {
  key: string;
  class: "workflow-visible" | "daemon-operational";
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  readOnly: boolean;
  generation: number | null;
  updatedAtMs: number | null;
  description: string;
}

export interface SettingCheckResult {
  ok: boolean;
  diagnostics: SettingsDiagnostic[];
}

export interface SystemProjection {
  daemon: Record<string, unknown>;
  profiles: AgentProfileView[];
  settings: SettingView[];
  warnings: string[];
}
