// In-process implementation of the Keel RPC contract (Phase 11).
//
// Backed directly by a RealmKernel + JournalStore. The Phase 12 daemon will wrap
// this same logic behind a Unix socket; clients see the identical KeelApi.

import type { JournalStore } from "../journal/store.ts";
import type { RealmKernel, RunHandle } from "../kernel/realm/realm-host.ts";
import {
  DEFAULT_WORKFLOW_DEFINITION_TTL_MS,
  evictWorkflowDefinitionCache,
} from "../workflow-definitions/snapshot.ts";
import type {
  EventEnvelope,
  KeelApi,
  LaunchRequest,
  RunOutcome,
  RunStart,
  WorkflowProvenance,
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
    const { runId, done } = this.kernel.launch(
      {
        source: req.source,
        name: req.name ?? null,
        provenance: req.provenance,
      },
      req.input,
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
}
