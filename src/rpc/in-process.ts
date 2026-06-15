// In-process implementation of the Keel RPC contract (Phase 11).
//
// Backed directly by a RealmKernel + JournalStore. The Phase 12 daemon will wrap
// this same logic behind a Unix socket; clients see the identical KeelApi.

import { existsSync } from "node:fs";
import type { JournalStore } from "../journal/store.ts";
import type { AgentWorkspaceRow, RunStatus } from "../journal/types.ts";
import type { RealmKernel, RunHandle } from "../kernel/realm/realm-host.ts";
import { requireRunTarget } from "../target.ts";
import {
  DEFAULT_WORKFLOW_DEFINITION_TTL_MS,
  evictWorkflowDefinitionCache,
} from "../workflow-definitions/snapshot.ts";
import { cleanupTerminalRunWorkspaces } from "../workspace/retention.ts";
import {
  diffWorkspace,
  mergeWorkspaceIntoTarget,
  removeRetainedWorkspace,
} from "../workspace/worktree.ts";
import type {
  EventEnvelope,
  KeelApi,
  LaunchRequest,
  RunOutcome,
  RunStart,
  RunWorkspaceDiff,
  RunWorkspaceView,
  WorkflowProvenance,
  WorkspaceGcResult,
} from "./contract.ts";
import { EventHub } from "./event-hub.ts";
import {
  type Blockage,
  type RunProjection,
  type RunReport,
  type RunSummary,
  buildProjection,
  buildRunReport,
  getBlockage,
  listRunSummaries,
} from "./projection.ts";

const WORKSPACE_RECONCILE_STALE_MS = 30_000;
const WORKSPACE_MERGEABLE_STATUSES = new Set<AgentWorkspaceRow["status"]>([
  "pending_review",
  "diff_error",
]);
const WORKSPACE_DISCARDABLE_STATUSES = new Set<AgentWorkspaceRow["status"]>([
  "pending_review",
  "diff_error",
  "cleanup_error",
  "abandoned",
]);

export class InProcessKeel implements KeelApi {
  private readonly running = new Map<string, Promise<RunHandle<unknown>>>();
  private readonly unsubscribeStoreEvents: () => void;

  constructor(
    private readonly kernel: RealmKernel,
    private readonly store: JournalStore,
    private readonly eventHub: EventHub = new EventHub(),
  ) {
    this.kernel.setLiveEventSink((runId, type, payload, atMs) =>
      this.eventHub.publishEphemeral(runId, type, payload, atMs),
    );
    this.unsubscribeStoreEvents = this.store.onEventAppended((event) =>
      this.eventHub.publishDurable(event),
    );
  }

  async launchRun(req: LaunchRequest): Promise<{ runId: string }> {
    const target = requireRunTarget(req.target, "launchRun");
    const { runId, done } = this.kernel.launch(
      {
        source: req.source,
        name: req.name ?? null,
        provenance: req.provenance,
      },
      req.input,
      { target },
    );
    this.running.set(
      runId,
      done.catch((err) => ({ runId, status: "failed", output: undefined }) as RunHandle<unknown>),
    );
    return { runId };
  }

  async resumeRun(runId: string): Promise<RunStart> {
    this.start(this.kernel.startResume<unknown>(runId));
    return this.started(runId);
  }

  async interruptRun(
    runId: string,
    reason?: string,
  ): Promise<{ runId: string; status: "interrupted" }> {
    const result = this.kernel.interruptRun(runId, reason);
    this.running.set(runId, Promise.resolve({ runId, status: "interrupted" }));
    return result;
  }

  async rerunRun(
    runId: string,
    opts?: {
      source?: string;
      input?: unknown;
      name?: string | null;
      provenance?: WorkflowProvenance;
    },
  ): Promise<RunStart> {
    this.start(this.kernel.startRerun<unknown>(runId, opts));
    return this.started(runId);
  }

  async retryRun(runId: string): Promise<RunStart> {
    this.start(this.kernel.startRetry<unknown>(runId));
    return this.started(runId);
  }

  async rewindRun(runId: string, toStableKey: string): Promise<RunStart> {
    this.start(this.kernel.startRewind<unknown>(runId, toStableKey));
    return this.started(runId);
  }

  forkRun(runId: string, opts: { atStableKey?: string; newRunId?: string }): { runId: string } {
    const newId = this.kernel.fork(runId, opts);
    return { runId: newId };
  }

  getRun(runId: string): RunProjection | null {
    return buildProjection(this.store, runId);
  }

  getRunReport(runId: string): RunReport | null {
    return buildRunReport(this.store, runId);
  }

  getBlockage(runId: string): Blockage {
    return getBlockage(this.store, runId, Date.now());
  }

  listRuns(): RunSummary[] {
    return listRunSummaries(this.store);
  }

  listRunWorkspaces(runId: string, opts: { includeRemoved?: boolean } = {}): RunWorkspaceView[] {
    return this.store.listAgentWorkspaces(runId, opts).map(workspaceView);
  }

  getRunWorkspace(runId: string, workspaceId: string): RunWorkspaceView | null {
    const row = this.store.getAgentWorkspace(runId, workspaceId);
    return row ? workspaceView(row) : null;
  }

  getRunWorkspaceDiff(runId: string, workspaceId: string): RunWorkspaceDiff {
    const row = this.requireWorkspace(runId, workspaceId);
    if (!existsSync(row.workspacePath)) {
      throw new Error(`workspace ${runId}/${workspaceId} is missing at ${row.workspacePath}`);
    }
    const diff = diffWorkspace(row.workspacePath);
    return { workspace: workspaceView(row), ...diff };
  }

  reconcileWorkspaces(opts: { staleBeforeMs?: number; nowMs?: number } = {}): {
    updated: RunWorkspaceView[];
    deleted: RunWorkspaceView[];
  } {
    const nowMs = opts.nowMs ?? Date.now();
    const staleBeforeMs = opts.staleBeforeMs ?? nowMs - WORKSPACE_RECONCILE_STALE_MS;
    const updated: RunWorkspaceView[] = [];
    const deleted: RunWorkspaceView[] = [];
    for (const row of this.store.listAllAgentWorkspaces()) {
      const run = this.store.getRun(row.runId);
      if (!run || isTerminalRunStatus(run.status)) {
        if (run) cleanupTerminalRunWorkspaces(this.store, row.runId, run.status, nowMs);
        const next = this.store.getAgentWorkspace(row.runId, row.workspaceId);
        if (next && next.updatedAtMs === nowMs) updated.push(workspaceView(next));
        continue;
      }

      const hasLiveOwner =
        run.runtimeOwnerId !== null &&
        run.heartbeatAtMs !== null &&
        run.heartbeatAtMs >= staleBeforeMs;
      if (
        row.status === "creating" &&
        !hasLiveOwner &&
        (row.kind !== "agent_session" || !this.store.hasPendingAgentSessionTurn(row.runId, row.key))
      ) {
        if (existsSync(row.workspacePath)) {
          removeRetainedWorkspace(row.target, row.workspacePath, row.baseCommit);
        }
        this.store.deleteAgentWorkspace(row.runId, row.workspaceId);
        deleted.push(workspaceView(row));
      }
    }
    return { updated, deleted };
  }

  mergeRunWorkspace(runId: string, workspaceId: string): RunWorkspaceView {
    const row = this.requireWorkspace(runId, workspaceId);
    this.assertWorkspaceOperatorAllowed(row, "merge");
    if (!existsSync(row.workspacePath)) {
      throw new Error(`workspace ${runId}/${workspaceId} is missing at ${row.workspacePath}`);
    }
    mergeWorkspaceIntoTarget(row.workspacePath, row.target);
    const at = Date.now();
    this.store.transaction(() => {
      this.store.updateAgentWorkspace(runId, workspaceId, {
        status: "merged",
        mergedAtMs: at,
        updatedAtMs: at,
      });
      this.store.appendEvent(
        runId,
        "workspace.merged",
        {
          workspaceId,
          kind: row.kind,
          key: row.key,
          workspacePath: row.workspacePath,
          target: row.target,
          baseCommit: row.baseCommit,
        },
        at,
      );
    });
    return workspaceView(this.requireWorkspace(runId, workspaceId));
  }

  discardRunWorkspace(runId: string, workspaceId: string): RunWorkspaceView {
    const row = this.requireWorkspace(runId, workspaceId);
    this.assertWorkspaceOperatorAllowed(row, "discard");
    removeRetainedWorkspace(row.target, row.workspacePath, row.baseCommit);
    const at = Date.now();
    this.store.transaction(() => {
      this.store.updateAgentWorkspace(runId, workspaceId, {
        status: "discarded",
        discardedAtMs: at,
        updatedAtMs: at,
      });
      this.store.appendEvent(
        runId,
        "workspace.discarded",
        {
          workspaceId,
          kind: row.kind,
          key: row.key,
          workspacePath: row.workspacePath,
          target: row.target,
        },
        at,
      );
    });
    return workspaceView(this.requireWorkspace(runId, workspaceId));
  }

  gcWorkspaces(
    opts: { olderThanMs?: number; includePending?: boolean; includeRemoved?: boolean } = {},
  ): WorkspaceGcResult {
    const now = Date.now();
    this.reconcileWorkspaces({ nowMs: now });
    const cutoff = now - (opts.olderThanMs ?? 0);
    const statuses = opts.includePending
      ? ([
          "merged",
          "discarded",
          "abandoned",
          "pending_review",
          ...(opts.includeRemoved ? ["removed" as const] : []),
        ] as const)
      : ([
          "merged",
          "discarded",
          "abandoned",
          ...(opts.includeRemoved ? ["removed" as const] : []),
        ] as const);
    const rows = this.store.gcWorkspaceRows([...statuses], cutoff);
    const removed: AgentWorkspaceRow[] = [];
    for (const row of rows) {
      const existed = existsSync(row.workspacePath);
      if (existed) {
        removeRetainedWorkspace(row.target, row.workspacePath, row.baseCommit);
        removed.push(row);
      }
      this.store.deleteAgentWorkspace(row.runId, row.workspaceId);
    }
    return { removed: removed.map(workspaceView) };
  }

  async waitForRun(runId: string): Promise<RunOutcome> {
    const pending = this.running.get(runId);
    if (pending) {
      const handle = await pending;
      return this.outcome(runId, handle);
    }
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return {
      runId,
      status: run.status,
      output: run.outputRef ? JSON.parse(run.outputRef) : undefined,
      error: run.errorJson ? JSON.parse(run.errorJson) : null,
    };
  }

  async getRunOutput(runId: string): Promise<RunOutcome> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return {
      runId,
      status: run.status,
      output: run.outputRef ? JSON.parse(run.outputRef) : undefined,
      error: run.errorJson ? JSON.parse(run.errorJson) : null,
    };
  }

  async gcDefinitions(opts: { ttlMs?: number; cacheMinAgeMs?: number } = {}): Promise<{
    workflowDefinitionsRemoved: number;
    definitionCacheEntriesRemoved: number;
  }> {
    const nowMs = Date.now();
    const workflowDefinitionsRemoved = this.store.pruneWorkflowDefinitions({
      nowMs,
      ttlMs: opts.ttlMs ?? DEFAULT_WORKFLOW_DEFINITION_TTL_MS,
    });
    const definitionCacheEntriesRemoved = evictWorkflowDefinitionCache(this.store, {
      nowMs,
      minAgeMs: opts.cacheMinAgeMs ?? 0,
    });
    return { workflowDefinitionsRemoved, definitionCacheEntriesRemoved };
  }

  subscribeEvents(
    runId: string,
    afterSeq: number,
    onEvent: (event: EventEnvelope) => void,
  ): () => void {
    return this.eventHub.subscribe(this.store, runId, afterSeq, onEvent);
  }

  close(): void {
    this.unsubscribeStoreEvents();
  }

  private start(handle: { runId: string; done: Promise<RunHandle<unknown>> }): void {
    this.running.set(
      handle.runId,
      handle.done.catch(
        (err) =>
          ({ runId: handle.runId, status: "failed", output: undefined }) as RunHandle<unknown>,
      ),
    );
  }

  private started(runId: string): RunStart {
    const status = this.store.getRun(runId)?.status ?? "running";
    return { runId, status };
  }

  private outcome(runId: string, handle: RunHandle<unknown>): RunOutcome {
    const run = this.store.getRun(runId);
    return {
      runId,
      status: handle.status,
      output: handle.output,
      error: run?.errorJson ? JSON.parse(run.errorJson) : null,
    };
  }

  private requireWorkspace(runId: string, workspaceId: string) {
    const row = this.store.getAgentWorkspace(runId, workspaceId);
    if (!row) throw new Error(`workspace ${runId}/${workspaceId} not found`);
    return row;
  }

  private assertWorkspaceOperatorAllowed(
    row: AgentWorkspaceRow,
    operation: "merge" | "discard",
  ): void {
    const run = this.store.getRun(row.runId);
    if (!run) throw new Error(`run ${row.runId} not found`);
    if (!["finished", "failed", "cancelled", "continued"].includes(run.status)) {
      throw new Error(
        `cannot ${operation} workspace ${row.runId}/${row.workspaceId} while run is ${run.status}`,
      );
    }
    const session =
      row.kind === "agent_session" ? this.store.getAgentSession(row.runId, row.key) : null;
    if (session?.activeTurnKey) {
      throw new Error(
        `cannot ${operation} workspace ${row.runId}/${row.workspaceId} while a turn is active`,
      );
    }
    const allowedStatuses =
      operation === "merge" ? WORKSPACE_MERGEABLE_STATUSES : WORKSPACE_DISCARDABLE_STATUSES;
    if (!allowedStatuses.has(row.status)) {
      throw new Error(
        `cannot ${operation} workspace ${row.runId}/${row.workspaceId} with status ${row.status}`,
      );
    }
  }
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "finished" || status === "failed" || status === "cancelled" || status === "continued"
  );
}

function workspaceView(row: AgentWorkspaceRow): RunWorkspaceView {
  return {
    runId: row.runId,
    workspaceId: row.workspaceId,
    kind: row.kind,
    key: row.key,
    lastAttempt: row.lastAttempt,
    retentionPolicy: row.retentionPolicy,
    workspacePath: row.workspacePath,
    target: row.target,
    baseCommit: row.baseCommit,
    status: row.status,
    failureSeen: row.failureSeen,
    lastTurnKey: row.lastTurnKey,
    lastTurnAttempt: row.lastTurnAttempt,
    lastDiffEventSeq: row.lastDiffEventSeq,
    lastErrorEventSeq: row.lastErrorEventSeq,
    cleanupError: row.cleanupErrorJson ? JSON.parse(row.cleanupErrorJson) : null,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    mergedAtMs: row.mergedAtMs,
    discardedAtMs: row.discardedAtMs,
    removedAtMs: row.removedAtMs,
  };
}
