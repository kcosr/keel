// Thin daemon client (DESIGN.md §6.1) — implements the same KeelApi over a Unix
// socket. The CLI, and later web/MCP, are clients exactly like this.

import { type Socket, connect } from "bun";
import type {
  AgentProfileCheckResult,
  AgentProfileView,
  CheckAgentProfileRequest,
  DeleteAgentProfileRequest,
  DeleteSettingRequest,
  EventEnvelope,
  LaunchRequest,
  PutAgentProfileRequest,
  PutSettingRequest,
  RunLaunchResult,
  RunOutcome,
  RunStart,
  RunWorkspaceDiff,
  RunWorkspaceView,
  SettingView,
  SettingsDiagnostic,
  WorkspaceGcResult,
} from "../rpc/contract.ts";
import type { RunProjection, RunReport, RunSummary } from "../rpc/projection.ts";
import { clientRunTargetOrCwd } from "../target.ts";
import type { WorkflowSourceInput } from "../workflow-definitions/source.ts";

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
  private readonly pendingSubEvents = new Map<string, EventEnvelope[]>();
  private readonly closedSubIds = new Set<string>();

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
    const socket = this.socket;
    this.socket = null;
    this.failAll(new Error("daemon client closed"));
    socket?.end();
    const force = socket as
      | ({ flush?: () => void; terminate?: () => void } & Socket<undefined>)
      | null;
    force?.flush?.();
    force?.terminate?.();
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
      const sub = this.subs.get(subId);
      if (sub) {
        sub(event);
      } else if (this.closedSubIds.has(subId)) {
        return;
      } else {
        const buffered = this.pendingSubEvents.get(subId) ?? [];
        buffered.push(event);
        this.pendingSubEvents.set(subId, buffered);
      }
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
    this.pendingSubEvents.clear();
    this.closedSubIds.clear();
  }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  launchRun(req: LaunchRequest): Promise<RunLaunchResult> {
    return this.rpc("launchRun", {
      ...req,
      target: clientRunTargetOrCwd(req.target, "launchRun"),
    });
  }
  resumeRun(runId: string): Promise<RunStart> {
    return this.rpc("resumeRun", { runId });
  }
  interruptRun(runId: string, reason?: string): Promise<{ runId: string; status: "interrupted" }> {
    return this.rpc("interruptRun", { runId, reason });
  }
  rerunRun(
    runId: string,
    opts?: {
      source?: WorkflowSourceInput;
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
    source: WorkflowSourceInput;
    workflowName?: string | null;
    input?: unknown;
    target?: string;
    intervalMs: number;
    firstFireMs?: number;
  }): Promise<{ ok: boolean }> {
    return this.rpc("putSchedule", {
      ...req,
      target: clientRunTargetOrCwd(req.target, "putSchedule"),
    });
  }
  listRunWorkspaces(
    runId: string,
    opts: { includeRemoved?: boolean } = {},
  ): Promise<RunWorkspaceView[]> {
    return this.rpc("listRunWorkspaces", { runId, ...opts });
  }
  getRunWorkspace(runId: string, workspaceId: string): Promise<RunWorkspaceView | null> {
    return this.rpc("getRunWorkspace", { runId, workspaceId });
  }
  getRunWorkspaceDiff(runId: string, workspaceId: string): Promise<RunWorkspaceDiff> {
    return this.rpc("getRunWorkspaceDiff", { runId, workspaceId });
  }
  mergeRunWorkspace(runId: string, workspaceId: string): Promise<RunWorkspaceView> {
    return this.rpc("mergeRunWorkspace", { runId, workspaceId });
  }
  discardRunWorkspace(runId: string, workspaceId: string): Promise<RunWorkspaceView> {
    return this.rpc("discardRunWorkspace", { runId, workspaceId });
  }
  gcWorkspaces(
    req: { olderThanMs?: number; includePending?: boolean; includeRemoved?: boolean } = {},
  ): Promise<WorkspaceGcResult> {
    return this.rpc("gcWorkspaces", req);
  }
  listAgentProfiles(
    req: { source?: "all" | "catalog" | "programmatic" } = {},
  ): Promise<AgentProfileView[]> {
    return this.rpc("listAgentProfiles", req);
  }
  getAgentProfile(name: string): Promise<AgentProfileView | null> {
    return this.rpc("getAgentProfile", { name });
  }
  putAgentProfile(req: PutAgentProfileRequest): Promise<AgentProfileView> {
    return this.rpc("putAgentProfile", req);
  }
  deleteAgentProfile(req: DeleteAgentProfileRequest): Promise<{ name: string; deleted: true }> {
    return this.rpc("deleteAgentProfile", req);
  }
  checkAgentProfile(req: CheckAgentProfileRequest): Promise<AgentProfileCheckResult> {
    return this.rpc("checkAgentProfile", req);
  }
  listSettings(): Promise<SettingView[]> {
    return this.rpc("listSettings", {});
  }
  getSetting(key: string): Promise<SettingView | null> {
    return this.rpc("getSetting", { key });
  }
  putSetting(req: PutSettingRequest): Promise<SettingView> {
    return this.rpc("putSetting", req);
  }
  deleteSetting(req: DeleteSettingRequest): Promise<{ key: string; deleted: boolean }> {
    return this.rpc("deleteSetting", req);
  }
  checkSetting(req: {
    key: string;
    value: unknown;
  }): Promise<{ ok: boolean; diagnostics: SettingsDiagnostic[] }> {
    return this.rpc("checkSetting", req);
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
    onCaughtUp?: () => void,
  ): () => void {
    let subId: string | null = null;
    let active = true;
    void this.rpc<{ subId: string }>("subscribeEvents", { runId, afterSeq }).then(
      (r) => {
        subId = r.subId;
        if (!active) {
          this.closedSubIds.add(r.subId);
          this.pendingSubEvents.delete(r.subId);
          return;
        }
        this.closedSubIds.delete(r.subId);
        this.subs.set(r.subId, onEvent);
        const buffered = this.pendingSubEvents.get(r.subId) ?? [];
        this.pendingSubEvents.delete(r.subId);
        for (const event of buffered) onEvent(event);
        // The daemon backfills before the subscribe RPC returns; after this flush, events are live.
        onCaughtUp?.();
      },
      (err) => {
        onError?.(err);
      },
    );
    return () => {
      active = false;
      if (subId) {
        this.subs.delete(subId);
        this.pendingSubEvents.delete(subId);
        this.closedSubIds.add(subId);
      }
    };
  }
}
