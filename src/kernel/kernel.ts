// The kernel: run and resume (DESIGN.md §5.6).
//
// "Resume is re-running the function with a memoizing ctx." There is no separate
// replayer. Phase 2 runs in-process (the deterministic realm lands in Phase 4)
// and the workflow definition is supplied by the caller (the archived-definition
// store arrives with the daemon).

import { randomUUID } from "node:crypto";
import type { JournalStore } from "../journal/store.ts";
import type { RunStatus } from "../journal/types.ts";
import { optionalRunTarget } from "../target.ts";
import { type Ctx, type CtxHost, type FaultPoint, WorkflowCtx } from "./ctx.ts";

export type Workflow<I, O> = (ctx: Ctx, input: I) => Promise<O>;

export interface RunMeta {
  name: string;
  definitionVersion?: string;
  target?: string | null;
}

export interface RunHandle<O> {
  runId: string;
  status: RunStatus;
  output?: O;
}

/**
 * A cooperative "the host died here" signal. Phase 2 has no real process kill
 * (that is Phase 3's write-ahead protocol); throwing this from a workflow models
 * an abort at a step boundary, leaving the run resumable rather than failed.
 */
export class KeelAbort extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "KeelAbort";
  }
}

export interface KernelOptions {
  clock?: () => number;
  rng?: () => number;
  idgen?: () => string;
  /** Crash/fault hook for the kill harness; a no-op in production. */
  fault?: (point: FaultPoint, key: string) => void;
  liveEvent?: CtxHost["liveEvent"];
}

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "finished",
  "failed",
  "cancelled",
  "continued",
]);

export class Kernel {
  private readonly store: JournalStore;
  private readonly host: CtxHost;
  private readonly idgen: () => string;

  constructor(store: JournalStore, opts: KernelOptions = {}) {
    this.store = store;
    this.host = {
      clock: opts.clock ?? (() => Date.now()),
      rng: opts.rng ?? Math.random,
      ...(opts.fault ? { fault: opts.fault } : {}),
      ...(opts.liveEvent ? { liveEvent: opts.liveEvent } : {}),
    };
    this.idgen = opts.idgen ?? (() => `run_${randomUUID()}`);
  }

  /** Start a fresh run. */
  async run<I, O>(workflow: Workflow<I, O>, input: I, meta: RunMeta): Promise<RunHandle<O>> {
    const runTarget = optionalRunTarget(meta.target, "Kernel.run");
    const runId = this.idgen();
    this.store.insertRun({
      runId,
      workflowName: meta.name,
      definitionVersion: meta.definitionVersion ?? "v0",
      runTarget,
      status: "running",
      parentRunId: null,
      tenantId: null,
      inputRef: JSON.stringify(input ?? null),
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      createdAtMs: this.host.clock(),
    });
    this.store.appendEvent(runId, "run.started", { name: meta.name }, this.host.clock());
    return this.execute(runId, workflow, input as I);
  }

  /** Resume an existing, non-terminal run by re-executing its body. */
  async resume<I, O>(runId: string, workflow: Workflow<I, O>): Promise<RunHandle<O>> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (TERMINAL.has(run.status)) {
      return {
        runId,
        status: run.status,
        output: run.outputRef ? (JSON.parse(run.outputRef) as O) : undefined,
      };
    }
    const input = (run.inputRef ? JSON.parse(run.inputRef) : undefined) as I;
    this.store.appendEvent(runId, "run.resumed", {}, this.host.clock());
    return this.execute(runId, workflow, input);
  }

  private async execute<I, O>(
    runId: string,
    workflow: Workflow<I, O>,
    input: I,
  ): Promise<RunHandle<O>> {
    const runTarget = this.store.getRun(runId)?.runTarget ?? null;
    const ctx = new WorkflowCtx(this.store, runId, this.host, undefined, undefined, runTarget);
    try {
      const output = await workflow(ctx, input);
      this.store.updateRun(runId, {
        status: "finished",
        outputRef: JSON.stringify(output ?? null),
        finishedAtMs: this.host.clock(),
      });
      this.store.appendEvent(runId, "run.finished", {}, this.host.clock());
      return { runId, status: "finished", output };
    } catch (err) {
      if (err instanceof KeelAbort) {
        // Modeled host death: leave the run resumable; completed steps are
        // already journaled.
        this.store.appendEvent(runId, "run.aborted", { message: err.message }, this.host.clock());
        throw err;
      }
      this.store.updateRun(runId, {
        status: "failed",
        errorJson: JSON.stringify(serializeError(err)),
        finishedAtMs: this.host.clock(),
      });
      this.store.appendEvent(runId, "run.failed", serializeError(err), this.host.clock());
      throw err;
    }
  }
}

function serializeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}
