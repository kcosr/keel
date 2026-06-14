// Journal row types (DESIGN.md §5.1, §8.1, Appendix A).
//
// These mirror the SQLite schema in schema.ts. Times are epoch milliseconds.
// Effectful results live either inline (<=1KB) or as an artifact reference
// (>1KB, Phase 8); for now both columns exist and inline is used.

export type EffectType = "pure" | "effectful" | "ambient";

export type JournalStatus = "pending" | "completed" | "failed";

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

export interface RunRow {
  runId: string;
  workflowName: string | null;
  definitionVersion: string;
  /** Display-only workflow provenance. Execution uses definitionVersion. */
  workflowRef: string | null;
  status: RunStatus;
  parentRunId: string | null;
  tenantId: string | null;
  inputRef: string | null;
  outputRef: string | null;
  errorJson: string | null;
  heartbeatAtMs: number | null;
  runtimeOwnerId: string | null;
  createdAtMs: number;
  finishedAtMs: number | null;
}

export type NewRunRow = Omit<RunRow, "finishedAtMs" | "workflowRef"> &
  Partial<Pick<RunRow, "finishedAtMs" | "workflowRef">>;

/** A dependency edge: a prior step output this row's inputHash incorporated. */
export interface InputDep {
  stepKey: string;
  contentHash: string;
}

export interface JournalRow {
  runId: string;
  stableKey: string;
  attempt: number;
  effectType: EffectType;
  status: JournalStatus;
  version: string;
  inputHash: string;
  inputDeps: InputDep[] | null;
  keySetHash: string | null;
  /** Inline result JSON (<=1KB). Mutually exclusive with resultArtifact. */
  resultInline: string | null;
  /** Artifact hash for results >1KB (Phase 8). */
  resultArtifact: string | null;
  /** Vendor mid-call resume token (effectful agents, Phase 10). */
  sessionToken: string | null;
  errorJson: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

export interface AgentSessionRow {
  runId: string;
  agentKey: string;
  identityHash: string;
  identityJson: string;
  currentSessionToken: string | null;
  latestCompletedTurnKey: string | null;
  latestCompletedAttempt: number | null;
  activeTurnKey: string | null;
  activeTurnAttempt: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AgentSessionTurnRow {
  runId: string;
  agentKey: string;
  turnKey: string;
  attempt: number;
  stableKey: string;
  status: JournalStatus;
  startedSessionToken: string | null;
  observedSessionToken: string | null;
  completedSessionToken: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

export type NewJournalRow = Omit<
  JournalRow,
  | "attempt"
  | "inputDeps"
  | "keySetHash"
  | "resultInline"
  | "resultArtifact"
  | "sessionToken"
  | "errorJson"
  | "startedAtMs"
  | "finishedAtMs"
> &
  Partial<
    Pick<
      JournalRow,
      | "attempt"
      | "inputDeps"
      | "keySetHash"
      | "resultInline"
      | "resultArtifact"
      | "sessionToken"
      | "errorJson"
      | "startedAtMs"
      | "finishedAtMs"
    >
  >;

export interface EventRow {
  runId: string;
  seq: number;
  type: string;
  payloadJson: string;
  emittedAtMs: number;
}

export interface ArtifactRow {
  hash: string;
  byteLen: number;
  refCount: number;
  createdAtMs: number;
  data: Uint8Array | null;
}

export interface WorkflowDefinitionRow {
  hash: string;
  name: string | null;
  kind: string;
  code: string;
  sourceMap: string | null;
  manifestJson: string | null;
  createdAtMs: number;
}

export type NewWorkflowDefinitionRow = WorkflowDefinitionRow;

export interface CapabilityRow {
  id: string;
  secretHash: string;
  resourceJson: string;
  actionsJson: string;
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  note: string | null;
}

export type NewCapabilityRow = CapabilityRow;
