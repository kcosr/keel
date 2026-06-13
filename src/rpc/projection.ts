// The canonical RunProjection (DESIGN.md §12.1).
//
// One read model, derived from the journal + event log. Every surface (CLI, web,
// MCP) consumes THIS — no surface reconstructs run state independently. Building
// it here prevents per-surface drift.

import type { JournalStore } from "../journal/store.ts";
import type { EffectType, JournalStatus, RunStatus } from "../journal/types.ts";

export interface NodeView {
  stableKey: string;
  effectType: EffectType;
  status: JournalStatus;
  attempt: number;
  /** Dependency edges (stepKey → this node) recorded during execution. */
  dependsOn: string[];
  /** True if the result is stored as an artifact rather than inline. */
  artifactBacked: boolean;
}

export interface RunStats {
  steps: number;
  agents: number;
  artifacts: number;
}

export interface RunProjection {
  runId: string;
  workflowName: string;
  status: RunStatus;
  definitionVersion: string;
  parentRunId: string | null;
  nodes: NodeView[];
  /** The current phase (last ctx.phase narration), if any. */
  phase: string | null;
  error: { name: string; message: string } | null;
  stats: RunStats;
}

/** Build the canonical projection for a run from the journal + events. */
export function buildProjection(store: JournalStore, runId: string): RunProjection | null {
  const run = store.getRun(runId);
  if (!run) return null;

  // One node per stableKey, latest attempt, excluding ambient bookkeeping keys.
  const rows = store.listJournalRows(runId);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.stableKey.startsWith("__")) continue; // ambient now/random
    const prev = latest.get(r.stableKey);
    if (!prev || r.attempt > prev.attempt) latest.set(r.stableKey, r);
  }

  const nodes: NodeView[] = [...latest.values()]
    .sort((a, b) => a.stableKey.localeCompare(b.stableKey))
    .map((r) => ({
      stableKey: r.stableKey,
      effectType: r.effectType,
      status: r.status,
      attempt: r.attempt,
      dependsOn: (r.inputDeps ?? []).map((d) => d.stepKey).sort(),
      artifactBacked: r.resultArtifact !== null,
    }));

  let phase: string | null = null;
  for (const ev of store.listEvents(runId)) {
    if (ev.type === "phase") {
      try {
        phase = (JSON.parse(ev.payloadJson) as { title?: string }).title ?? phase;
      } catch {
        // ignore
      }
    }
  }

  const stats: RunStats = {
    steps: nodes.filter((n) => n.effectType === "pure").length,
    agents: nodes.filter((n) => n.effectType === "effectful").length,
    artifacts: nodes.filter((n) => n.artifactBacked).length,
  };

  return {
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    definitionVersion: run.definitionVersion,
    parentRunId: run.parentRunId,
    nodes,
    phase,
    error: run.errorJson ? (JSON.parse(run.errorJson) as { name: string; message: string }) : null,
    stats,
  };
}

export type BlockageReason =
  | "none"
  | "running"
  | "stalled_no_heartbeat"
  | "waiting_human"
  | "waiting_signal"
  | "waiting_timer"
  | "waiting_child";

export interface Blockage {
  reason: BlockageReason;
  blockedOn: { stableKey: string; since: number } | null;
  context: string;
}

/**
 * Agent-facing "why is this run stuck?" (DESIGN.md §12.2) — one call instead of
 * log archaeology. waiting_* map to run status (HITL/timers land in Phases 16/17);
 * a pending step older than `stallThresholdMs` reads as stalled_no_heartbeat.
 */
export function getBlockage(
  store: JournalStore,
  runId: string,
  nowMs: number,
  stallThresholdMs = 30_000,
): Blockage {
  const run = store.getRun(runId);
  if (!run) return { reason: "none", blockedOn: null, context: "run not found" };
  switch (run.status) {
    case "waiting-human": {
      // surface WHAT is being asked, from the persisted approval (§17)
      const pending = store.listPendingApprovals(runId)[0];
      return {
        reason: "waiting_human",
        blockedOn: pending ? { stableKey: pending.stableKey, since: 0 } : null,
        context: pending?.prompt
          ? `awaiting decision: ${pending.prompt}`
          : "awaiting a human decision",
      };
    }
    case "waiting-signal":
      return { reason: "waiting_signal", blockedOn: null, context: "awaiting a named signal" };
    case "waiting-timer":
      return { reason: "waiting_timer", blockedOn: null, context: "awaiting a durable timer" };
    case "finished":
    case "failed":
    case "cancelled":
    case "continued":
      return { reason: "none", blockedOn: null, context: `terminal: ${run.status}` };
    default:
      break;
  }
  // running: look for a long-pending step
  const pending = store
    .listJournalRows(runId)
    .filter((r) => r.status === "pending" && !r.stableKey.startsWith("__"))
    .sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
  const oldest = pending[0];
  if (oldest && oldest.startedAtMs !== null && nowMs - oldest.startedAtMs > stallThresholdMs) {
    return {
      reason: "stalled_no_heartbeat",
      blockedOn: { stableKey: oldest.stableKey, since: oldest.startedAtMs },
      context: `step "${oldest.stableKey}" has been pending ${nowMs - oldest.startedAtMs}ms`,
    };
  }
  return { reason: "running", blockedOn: null, context: "executing normally" };
}

export interface RunSummary {
  runId: string;
  workflowName: string;
  status: RunStatus;
}

export function listRunSummaries(store: JournalStore): RunSummary[] {
  return store.listRuns().map((r) => ({
    runId: r.runId,
    workflowName: r.workflowName,
    status: r.status,
  }));
}
