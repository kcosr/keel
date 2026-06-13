// In-process implementation of the Keel RPC contract (Phase 11).
//
// Backed directly by a RealmKernel + JournalStore. The Phase 12 daemon will wrap
// this same logic behind a Unix socket; clients see the identical KeelApi.

import type { JournalStore } from "../journal/store.ts";
import type { RealmKernel, RunHandle } from "../kernel/realm/realm-host.ts";
import type {
  EventEnvelope,
  KeelApi,
  LaunchRequest,
  RunOutcome,
  RunStart,
  WorkflowProvenance,
} from "./contract.ts";
import {
  type Blockage,
  type RunProjection,
  type RunSummary,
  buildProjection,
  getBlockage,
  listRunSummaries,
} from "./projection.ts";

export class InProcessKeel implements KeelApi {
  private readonly running = new Map<string, Promise<RunHandle<unknown>>>();

  constructor(
    private readonly kernel: RealmKernel,
    private readonly store: JournalStore,
  ) {}

  async launchRun(req: LaunchRequest): Promise<{ runId: string }> {
    const { runId, done } = this.kernel.launch({
      source: req.source,
      name: req.name ?? null,
      provenance: req.provenance,
    }, req.input);
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

  subscribeEvents(
    runId: string,
    afterSeq: number,
    onEvent: (event: EventEnvelope) => void,
  ): () => void {
    let cursor = afterSeq;
    let stopped = false;
    const poll = () => {
      if (stopped) return;
      for (const ev of this.store.listEvents(runId, cursor)) {
        cursor = ev.seq;
        onEvent({
          seq: ev.seq,
          type: ev.type,
          payload: JSON.parse(ev.payloadJson),
          atMs: ev.emittedAtMs,
        });
      }
      if (!stopped) timer = setTimeout(poll, 25);
    };
    let timer = setTimeout(poll, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
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
