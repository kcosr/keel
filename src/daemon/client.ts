// Thin daemon client (DESIGN.md §6.1) — implements the same KeelApi over a Unix
// socket. The CLI, and later web/MCP, are clients exactly like this.

import { type Socket, connect } from "bun";
import type {
  EventEnvelope,
  LaunchRequest,
  RunLaunchResult,
  RunOutcome,
  RunStart,
} from "../rpc/contract.ts";
import type { RunProjection, RunReport, RunSummary } from "../rpc/projection.ts";

/** Async-shaped client over the socket (the in-process KeelApi is sync; the wire
 * is async). Same method names, Promise-returning. */
export class DaemonClient {
  private socket: Socket<undefined> | null = null;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly subs = new Map<string, (event: EventEnvelope) => void>();

  static async connect(socketPath: string): Promise<DaemonClient> {
    const c = new DaemonClient();
    c.socket = await connect<undefined>({
      unix: socketPath,
      socket: {
        data: (_s, data) => c.onData(data),
        close: () => c.failAll(new Error("daemon connection closed")),
      },
    });
    return c;
  }

  close(): void {
    this.socket?.end();
  }

  private onData(data: Buffer): void {
    this.buf += data.toString("utf8");
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onMessage(line);
      nl = this.buf.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    const msg = JSON.parse(line) as {
      id?: number;
      result?: unknown;
      error?: { message: string; code?: string; action?: string; resource?: unknown };
      event?: EventEnvelope & { subId: string };
    };
    if (msg.event) {
      const { subId, ...event } = msg.event;
      this.subs.get(subId)?.(event);
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  private failAll(err: unknown): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  launchRun(req: LaunchRequest): Promise<RunLaunchResult> {
    return this.rpc("launchRun", req);
  }
  resumeRun(runId: string): Promise<RunStart> {
    return this.rpc("resumeRun", { runId });
  }
  rerunRun(
    runId: string,
    opts?: {
      source?: string;
      input?: unknown;
      name?: string | null;
      provenance?: LaunchRequest["provenance"];
    },
  ): Promise<RunStart> {
    return this.rpc("rerunRun", { runId, opts });
  }
  getRun(runId: string): Promise<RunProjection | null> {
    return this.rpc("getRun", { runId });
  }
  getRunReport(runId: string): Promise<RunReport | null> {
    return this.rpc("getRunReport", { runId });
  }
  retryRun(runId: string): Promise<RunStart> {
    return this.rpc("retryRun", { runId });
  }
  rewindRun(runId: string, toStableKey: string): Promise<RunStart> {
    return this.rpc("rewindRun", { runId, toStableKey });
  }
  forkRun(
    runId: string,
    opts: { atStableKey?: string; newRunId?: string } = {},
  ): Promise<RunLaunchResult> {
    return this.rpc("forkRun", { runId, opts });
  }
  getBlockage(runId: string): Promise<import("../rpc/projection.ts").Blockage> {
    return this.rpc("getBlockage", { runId });
  }
  decideApproval(
    runId: string,
    key: string,
    decision: { status: "approved" | "denied"; note?: string; grantedCaps?: unknown },
  ): Promise<{ status: string }> {
    return this.rpc("decideApproval", { runId, key, decision });
  }
  sendSignal(runId: string, name: string, payload: unknown): Promise<{ status: string }> {
    return this.rpc("sendSignal", { runId, name, payload });
  }
  putSchedule(req: {
    name: string;
    source: string;
    workflowName?: string | null;
    input?: unknown;
    intervalMs: number;
    firstFireMs?: number;
  }): Promise<{ ok: boolean }> {
    return this.rpc("putSchedule", req);
  }
  gcDefinitions(req: { ttlMs?: number; cacheMinAgeMs?: number } = {}): Promise<{
    workflowDefinitionsRemoved: number;
    definitionCacheEntriesRemoved: number;
  }> {
    return this.rpc("gcDefinitions", req);
  }
  listRuns(): Promise<RunSummary[]> {
    return this.rpc("listRuns", {});
  }
  ping(): Promise<{ ok: boolean; ownerId: string }> {
    return this.rpc("ping", {});
  }
  authenticate(token: string): Promise<{ ok: boolean }> {
    return this.rpc("authenticate", { token });
  }
  waitForRun(runId: string): Promise<RunOutcome> {
    return this.rpc("waitForRun", { runId });
  }
  getRunOutput(runId: string): Promise<RunOutcome> {
    return this.rpc("getRunOutput", { runId });
  }
  subscribeEvents(
    runId: string,
    afterSeq: number,
    onEvent: (e: EventEnvelope) => void,
    onError?: (err: unknown) => void,
  ): () => void {
    let subId: string | null = null;
    void this.rpc<{ subId: string }>("subscribeEvents", { runId, afterSeq }).then(
      (r) => {
        subId = r.subId;
        this.subs.set(r.subId, onEvent);
      },
      (err) => {
        onError?.(err);
      },
    );
    return () => {
      if (subId) this.subs.delete(subId);
    };
  }
}
