// In-process implementation of the Keel RPC contract (Phase 11).
//
// Backed directly by a RealmKernel + JournalStore. The Phase 12 daemon will wrap
// this same logic behind a Unix socket; clients see the identical KeelApi.

import type { JournalStore } from "../journal/store.ts";
import type { RealmKernel, RunHandle } from "../kernel/realm/realm-host.ts";
import type { EventEnvelope, KeelApi, LaunchRequest, RunOutcome, RunStart } from "./contract.ts";
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
  private readonly workflowUrls = new Map<string, string>();

  constructor(
    private readonly kernel: RealmKernel,
    private readonly store: JournalStore,
  ) {}

  async launchRun(req: LaunchRequest): Promise<{ runId: string }> {
    const { runId, done } = this.kernel.launch(req.workflowUrl, req.input, { name: req.name });
    this.workflowUrls.set(runId, req.workflowUrl);
    this.running.set(
      runId,
      done.catch((err) => ({ runId, status: "failed", output: undefined }) as RunHandle<unknown>),
    );
    return { runId };
  }

  async resumeRun(runId: string): Promise<RunStart> {
    const url = this.requireUrl(runId);
    this.start(this.kernel.startResume<unknown>(runId, url));
    return this.started(runId);
  }

  async rerunRun(
    runId: string,
    opts?: { workflowUrl?: string; input?: unknown },
  ): Promise<RunStart> {
    const url = opts?.workflowUrl ?? this.requireUrl(runId);
    if (opts?.workflowUrl) this.workflowUrls.set(runId, opts.workflowUrl);
    this.start(this.kernel.startRerun<unknown>(runId, url, opts?.input));
    return this.started(runId);
  }

  async retryRun(runId: string): Promise<RunStart> {
    this.start(this.kernel.startRetry<unknown>(runId, this.requireUrl(runId)));
    return this.started(runId);
  }

  async rewindRun(runId: string, toStableKey: string): Promise<RunStart> {
    this.start(this.kernel.startRewind<unknown>(runId, toStableKey, this.requireUrl(runId)));
    return this.started(runId);
  }

  forkRun(runId: string, opts: { atStableKey?: string; newRunId?: string }): { runId: string } {
    const newId = this.kernel.fork(runId, opts);
    this.workflowUrls.set(newId, this.requireUrl(runId));
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

  private requireUrl(runId: string): string {
    // After a daemon restart the in-memory map is empty; fall back to the
    // workflow_ref persisted on the run row (recovery).
    const url = this.workflowUrls.get(runId) ?? this.store.getRun(runId)?.workflowRef ?? null;
    if (!url) throw new Error(`no workflow url registered for run ${runId} (launch it first)`);
    return url;
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
