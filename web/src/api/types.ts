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

export interface RpcResponse<T> {
  id?: unknown;
  result?: T;
  error?: GatewayErrorEnvelope;
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
  events: EventStreamFrame[];
  eventCursor: EventCursor | null;
  rawEvents: { href: string };
  availableCommands: Array<{ name: string; requiredAuthority: string }>;
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
}

export interface RunWorkspaceView {
  runId: string;
  workspaceId: string;
  mode: "direct" | "worktree" | "copy" | "clone";
  ownerKind: "workflow" | "agent" | "agent_session";
  key: string;
  workspacePath: string;
  sourceKind: string | null;
  sourcePath: string | null;
  sourceUri: string | null;
  status: string;
  mergeSupported: boolean;
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

export interface SavedWorkflowSummary {
  name: string;
  title: string | null;
  description: string | null;
  tags: string[];
  createdAtMs: number;
  updatedAtMs: number;
  disabledAtMs: number | null;
  deletedAtMs: number | null;
  latestVersion: number | null;
  latestDefinitionHash: string | null;
  workflowName?: string | null;
  [key: string]: unknown;
}

export interface AgentProfileView {
  name: string;
  source?: string;
  generation?: number;
  config?: unknown;
  diagnostics?: unknown[];
  [key: string]: unknown;
}

export interface SettingView {
  key: string;
  value: unknown;
  source?: string;
  generation?: number;
  diagnostics?: unknown[];
  [key: string]: unknown;
}

export interface SystemProjection {
  daemon: Record<string, unknown>;
  profiles: AgentProfileView[];
  settings: SettingView[];
  warnings: string[];
}
