// The Keel daemon (DESIGN.md §6, §7) — single-writer, out-of-process.
//
// Owns the journal write path, the realm host, and agent subprocess spawning;
// CLI/web/MCP are thin clients over one Unix-socket JSON-RPC contract (the same
// KeelApi frozen in Phase 11). On startup it reclaims orphaned runs via a
// compare-and-set ownership fence and resumes them.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Socket } from "bun";
import type { AgentProviderRegistry } from "../agents/types.ts";
import {
  AuthorizationError,
  type CapabilityAction,
  authorize,
  ensureAdminCapability,
  issueRunCapability,
} from "../auth/capabilities.ts";
import { JournalStore } from "../journal/store.ts";
import { RealmKernel } from "../kernel/realm/realm-host.ts";
import { Supervisor } from "../kernel/supervisor.ts";
import type { EventEnvelope } from "../rpc/contract.ts";
import { InProcessKeel } from "../rpc/in-process.ts";

export interface DaemonOptions {
  socketPath: string;
  dbPath: string;
  ownerId?: string;
  agents?: AgentProviderRegistry;
  /** Heartbeat refresh interval (ms); stale-owner detection uses a small multiple of this. */
  heartbeatMs?: number;
  /** Supervisor tick interval (ms) for timer wake + cron (default 1000). */
  superviseMs?: number;
  /** Optional bootstrap admin bearer token. Stored only as a daemon-side hash. */
  adminToken?: string;
  /** Git repo root for agents that explicitly request workspaceIsolation (§11.3). */
  workspaceRoot?: string;
  /** Named agent profiles, resolved into each ctx.agent before versioning. */
  agentProfiles?: Record<string, unknown>;
  definitionCacheRoot?: string;
  clock?: () => number;
}

interface Conn {
  socket: Socket<undefined>;
  buf: string;
  subs: Map<string, () => void>; // subId → unsubscribe
  credential: string | null;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_SUPERVISE_MS = 1000;
const OWNER_STALE_HEARTBEATS = 3;

export class KeelDaemon {
  readonly ownerId: string;
  private readonly store: JournalStore;
  private readonly kernel: RealmKernel;
  private readonly api: InProcessKeel;
  private readonly clock: () => number;
  private readonly heartbeatMs: number;
  private server: ReturnType<typeof Bun.listen> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private superviseTimer: ReturnType<typeof setInterval> | null = null;
  private readonly owned = new Set<string>();
  private readonly supervisor: Supervisor;
  private readonly superviseMs: number;

  constructor(private readonly opts: DaemonOptions) {
    this.ownerId = opts.ownerId ?? `daemon_${randomUUID()}`;
    this.clock = opts.clock ?? (() => Date.now());
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.superviseMs = opts.superviseMs ?? DEFAULT_SUPERVISE_MS;
    this.store = JournalStore.open(opts.dbPath);
    if (opts.adminToken) {
      ensureAdminCapability(this.store, opts.adminToken, this.clock());
    }
    this.kernel = new RealmKernel(this.store, {
      ...(opts.agents ? { agents: opts.agents } : {}),
      ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
      ...(opts.agentProfiles ? { agentProfiles: opts.agentProfiles } : {}),
      definitionCacheRoot: opts.definitionCacheRoot ?? join(dirname(opts.dbPath), "definitions"),
      clock: this.clock,
    });
    this.api = new InProcessKeel(this.kernel, this.store);
    this.supervisor = new Supervisor({
      store: this.store,
      kernel: this.kernel,
      clock: this.clock,
      claim: (runId) => {
        const ok = this.store.claimRun(
          runId,
          this.ownerId,
          this.clock() - OWNER_STALE_HEARTBEATS * this.heartbeatMs,
          this.clock(),
        );
        if (ok) this.owned.add(runId);
        return ok;
      },
    });
  }

  async start(): Promise<void> {
    // A crashed predecessor may have left a stale socket file; unlink it so we
    // can bind (recovery after kill -9).
    try {
      const { unlinkSync, existsSync } = await import("node:fs");
      if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath);
    } catch {
      // best effort
    }
    this.recoverOrphans();
    this.heartbeatTimer = setInterval(() => {
      for (const runId of this.owned) this.store.heartbeat(runId, this.ownerId, this.clock());
    }, this.heartbeatMs);
    this.superviseTimer = setInterval(() => {
      void this.supervisor.tick().catch(() => {});
    }, this.superviseMs);
    this.server = Bun.listen<undefined>({
      unix: this.opts.socketPath,
      socket: {
        open: (socket) => {
          (socket as Socket<undefined> & { conn?: Conn }).conn = {
            socket,
            buf: "",
            subs: new Map(),
            credential: null,
          };
        },
        data: (socket, data) => this.onData(socket as Socket<undefined> & { conn?: Conn }, data),
        close: (socket) => {
          const conn = (socket as Socket<undefined> & { conn?: Conn }).conn;
          if (conn) for (const unsub of conn.subs.values()) unsub();
        },
      },
    });
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.superviseTimer) clearInterval(this.superviseTimer);
    this.server?.stop(true);
    this.store.close();
  }

  /** Resume a run waiting on a just-delivered decision/signal. */
  private async wakeParked(runId: string): Promise<{ status: string }> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status.startsWith("waiting-")) {
      this.claimOrReject(runId);
      await this.api.resumeRun(runId);
      const out = await this.api.waitForRun(runId);
      return { status: out.status };
    }
    return { status: run.status };
  }

  /** CAS-claim a run before driving it; throw if another live daemon owns it. */
  private claimOrReject(runId: string): void {
    if (!this.store.getRun(runId)) throw new Error(`run ${runId} not found`);
    const staleBefore = this.clock() - OWNER_STALE_HEARTBEATS * this.heartbeatMs;
    if (!this.store.claimRun(runId, this.ownerId, staleBefore, this.clock())) {
      throw new Error(`run ${runId} is owned by another live daemon (ownership fence)`);
    }
    this.owned.add(runId);
  }

  /** Reclaim runs left 'running' by a dead daemon and resume them. */
  private recoverOrphans(): void {
    const staleBefore = this.clock() - OWNER_STALE_HEARTBEATS * this.heartbeatMs;
    for (const run of this.store.listRunsByStatus("running")) {
      if (!run.workflowRef) continue;
      if (this.store.claimRun(run.runId, this.ownerId, staleBefore, this.clock())) {
        this.owned.add(run.runId);
        void this.api.resumeRun(run.runId).catch(() => {});
      }
    }
  }

  private onData(socket: Socket<undefined> & { conn?: Conn }, data: Buffer): void {
    const conn = socket.conn;
    if (!conn) return;
    conn.buf += data.toString("utf8");
    let nl = conn.buf.indexOf("\n");
    while (nl >= 0) {
      const line = conn.buf.slice(0, nl);
      conn.buf = conn.buf.slice(nl + 1);
      if (line.trim()) void this.dispatch(conn, line);
      nl = conn.buf.indexOf("\n");
    }
  }

  private send(conn: Conn, obj: unknown): void {
    conn.socket.write(`${JSON.stringify(obj)}\n`);
  }

  private async dispatch(conn: Conn, line: string): Promise<void> {
    let req: { id: number; method: string; params?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const result = await this.handle(conn, req.method, req.params);
      this.send(conn, { id: req.id, result });
    } catch (err) {
      this.send(conn, {
        id: req.id,
        error:
          err instanceof AuthorizationError
            ? {
                code: err.code,
                message: err.message,
                action: err.request.action,
                resource: err.request.resource,
              }
            : { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private async handle(conn: Conn, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "authenticate") {
      conn.credential = p.token as string;
      return { ok: true };
    }
    switch (method) {
      case "launchRun": {
        const res = await this.api.launchRun({
          workflowUrl: p.workflowUrl as string,
          input: p.input,
          name: p.name as string,
        });
        this.store.claimRun(res.runId, this.ownerId, this.clock(), this.clock());
        this.owned.add(res.runId);
        const cap = issueRunCapability(this.store, res.runId, this.clock());
        return { ...res, capability: cap.token, capabilityId: cap.capabilityId };
      }
      case "resumeRun": {
        this.authorizeRun(conn, p.runId as string, "run:resume");
        this.claimOrReject(p.runId as string);
        return this.api.resumeRun(p.runId as string);
      }
      case "rerunRun": {
        this.authorizeRun(conn, p.runId as string, "run:retry");
        this.claimOrReject(p.runId as string);
        return this.api.rerunRun(
          p.runId as string,
          p.opts as { workflowUrl?: string; input?: unknown },
        );
      }
      case "getRun":
        this.authorizeRun(conn, p.runId as string, "run:read");
        return this.api.getRun(p.runId as string);
      case "getBlockage":
        this.authorizeRun(conn, p.runId as string, "run:read");
        return this.api.getBlockage(p.runId as string);
      case "listRuns":
        this.authorizeAdmin(conn);
        return this.api.listRuns();
      case "waitForRun":
        this.authorizeRun(conn, p.runId as string, "run:watch");
        return this.api.waitForRun(p.runId as string).finally(() => {
          this.authorizeRun(conn, p.runId as string, "run:watch");
        });
      case "subscribeEvents": {
        this.authorizeRun(conn, p.runId as string, "run:events");
        const subId = randomUUID();
        let unsub = () => {};
        unsub = this.api.subscribeEvents(
          p.runId as string,
          (p.afterSeq as number) ?? 0,
          (event: EventEnvelope) => {
            try {
              this.authorizeRun(conn, p.runId as string, "run:events");
              this.send(conn, { event: { subId, ...event } });
            } catch (err) {
              this.send(conn, {
                event: {
                  subId,
                  seq: event.seq,
                  type: "authorization.failed",
                  payload: { message: err instanceof Error ? err.message : String(err) },
                  atMs: this.clock(),
                },
              });
              unsub();
              conn.subs.delete(subId);
            }
          },
        );
        conn.subs.set(subId, unsub);
        return { subId };
      }
      case "retryRun": {
        this.authorizeRun(conn, p.runId as string, "run:retry");
        this.claimOrReject(p.runId as string);
        return this.api.retryRun(p.runId as string);
      }
      case "rewindRun": {
        this.authorizeRun(conn, p.runId as string, "run:rewind");
        this.claimOrReject(p.runId as string);
        return this.api.rewindRun(p.runId as string, p.toStableKey as string);
      }
      case "forkRun": {
        this.authorizeRun(conn, p.runId as string, "run:fork");
        const fork = this.api.forkRun(p.runId as string, (p.opts as Record<string, unknown>) ?? {});
        const cap = issueRunCapability(this.store, fork.runId, this.clock());
        return { ...fork, capability: cap.token, capabilityId: cap.capabilityId };
      }
      case "decideApproval": {
        this.authorizeAdmin(conn);
        const runId = p.runId as string;
        this.store.decideApproval(
          runId,
          p.key as string,
          p.decision as { status: "approved" | "denied"; note?: string; grantedCaps?: unknown },
          this.clock(),
        );
        return this.wakeParked(runId);
      }
      case "sendSignal": {
        const runId = p.runId as string;
        this.authorizeRun(conn, runId, "run:signal");
        this.store.putSignal(runId, p.name as string, p.payload, this.clock());
        return this.wakeParked(runId);
      }
      case "putSchedule": {
        this.authorizeAdmin(conn);
        this.store.putSchedule({
          name: p.name as string,
          workflowRef: p.workflowUrl as string,
          inputJson: p.input != null ? JSON.stringify(p.input) : null,
          intervalMs: p.intervalMs as number,
          nextFireMs: (p.firstFireMs as number) ?? this.clock(),
        });
        return { ok: true };
      }
      case "ping":
        return { ok: true, ownerId: this.ownerId };
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  private authorizeRun(conn: Conn, runId: string, action: CapabilityAction): void {
    authorize(
      this.store,
      conn.credential,
      { action, resource: { kind: "run", runId } },
      this.clock(),
    );
  }

  private authorizeAdmin(conn: Conn): void {
    authorize(
      this.store,
      conn.credential,
      { action: "admin", resource: { kind: "daemon" } },
      this.clock(),
    );
  }
}
