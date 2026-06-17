// The Keel daemon (DESIGN.md §6, §7) — single-writer, out-of-process.
//
// Owns the journal write path, the realm host, and agent subprocess spawning;
// CLI/web/MCP are thin clients over one Unix-socket JSON-RPC contract (the same
// KeelApi frozen in Phase 11). On startup it reclaims orphaned runs via a
// compare-and-set ownership fence and resumes them.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Socket } from "bun";
import { SecretStore } from "../agents/secrets.ts";
import type { AgentProviderRegistry } from "../agents/types.ts";
import { ensureAdminCapability } from "../auth/capabilities.ts";
import { JournalStore } from "../journal/store.ts";
import {
  DEFAULT_HEARTBEAT_MS,
  ownerStaleBeforeMs,
  ownerStaleWindowMs,
} from "../kernel/liveness.ts";
import { RealmKernel } from "../kernel/realm/realm-host.ts";
import { failRunWithError } from "../kernel/run-errors.ts";
import { Supervisor } from "../kernel/supervisor.ts";
import { EventHub } from "../rpc/event-hub.ts";
import { InProcessKeel } from "../rpc/in-process.ts";
import {
  isUnsupportedWorkflowSdkAbiError,
  keelPackageRoot,
} from "../workflow-definitions/snapshot.ts";
import {
  type GatewayEventFrame,
  type GatewayRequest,
  type GatewayResponse,
  type GatewaySession,
  KeelOperationGateway,
} from "./gateway.ts";

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
  /** Keel-owned store for retained isolated session workspaces. */
  workspaceStore?: string;
  /** Named agent profiles, resolved into each ctx.agent before versioning. */
  agentProfiles?: Record<string, unknown>;
  /** In-memory trusted-local secret side channel. Defaults to a fresh store. */
  secrets?: SecretStore;
  definitionCacheRoot?: string;
  clock?: () => number;
}

class SocketGatewaySession implements GatewaySession {
  readonly id = randomUUID();
  buf: string;
  private credential: string | null;
  private readonly cleanups = new Set<() => void>();

  constructor(private readonly socket: Socket<undefined>) {
    this.buf = "";
    this.credential = null;
  }

  getCredential(): string | null {
    return this.credential;
  }

  setCredential(token: string | null): void {
    this.credential = token;
  }

  sendEvent(event: GatewayEventFrame): void {
    this.socket.write(`${JSON.stringify({ event })}\n`);
  }

  sendResponse(response: GatewayResponse): void {
    this.socket.write(`${JSON.stringify(response)}\n`);
  }

  addCleanup(cleanup: () => void): void {
    this.cleanups.add(cleanup);
  }

  removeCleanup(cleanup: () => void): void {
    this.cleanups.delete(cleanup);
  }

  close(): void {
    for (const cleanup of [...this.cleanups]) cleanup();
    this.cleanups.clear();
  }
}

type GatewaySocket = Socket<undefined> & { session?: SocketGatewaySession };

const DEFAULT_SUPERVISE_MS = 1000;

export class KeelDaemon {
  readonly ownerId: string;
  private readonly store: JournalStore;
  private readonly kernel: RealmKernel;
  private readonly api: InProcessKeel;
  private readonly clock: () => number;
  private readonly definitionCacheRoot: string;
  private readonly heartbeatMs: number;
  private server: ReturnType<typeof Bun.listen> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private superviseTimer: ReturnType<typeof setInterval> | null = null;
  private readonly owned = new Set<string>();
  private readonly supervisor: Supervisor;
  private readonly superviseMs: number;
  private readonly eventHub = new EventHub();
  private readonly gateway: KeelOperationGateway;

  constructor(private readonly opts: DaemonOptions) {
    this.ownerId = opts.ownerId ?? `daemon_${randomUUID()}`;
    this.clock = opts.clock ?? (() => Date.now());
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.superviseMs = opts.superviseMs ?? DEFAULT_SUPERVISE_MS;
    this.definitionCacheRoot =
      opts.definitionCacheRoot ?? join(dirname(opts.dbPath), "definitions");
    this.store = JournalStore.open(opts.dbPath);
    if (opts.adminToken) {
      ensureAdminCapability(this.store, opts.adminToken, this.clock());
    }
    this.kernel = new RealmKernel(this.store, {
      ...(opts.agents ? { agents: opts.agents } : {}),
      workspaceStore: opts.workspaceStore ?? join(dirname(opts.dbPath), "workspaces"),
      ...(opts.agentProfiles ? { agentProfiles: opts.agentProfiles } : {}),
      secrets: opts.secrets ?? new SecretStore(),
      definitionCacheRoot: this.definitionCacheRoot,
      clock: this.clock,
    });
    this.assertNoDuplicateProfileSources();
    this.api = new InProcessKeel(this.kernel, this.store, this.eventHub, {
      ...(opts.agents ? { agents: opts.agents } : {}),
      clock: this.clock,
      ownerStaleWindowMs: ownerStaleWindowMs(this.heartbeatMs),
    });
    this.supervisor = new Supervisor({
      store: this.store,
      kernel: this.kernel,
      clock: this.clock,
      claim: (runId) => {
        const now = this.clock();
        const ok = this.store.claimRun(
          runId,
          this.ownerId,
          ownerStaleBeforeMs(now, this.heartbeatMs),
          now,
        );
        if (ok) this.owned.add(runId);
        return ok;
      },
    });
    this.gateway = new KeelOperationGateway({
      ownerId: this.ownerId,
      api: this.api,
      store: this.store,
      clock: this.clock,
      claimLaunchedRun: (runId) => this.claimLaunchedRun(runId),
      claimOrReject: (runId) => this.claimOrReject(runId),
      definitionCacheRoot: this.definitionCacheRoot,
    });
  }

  async start(): Promise<void> {
    // Snapshotting workflows needs the on-disk @kcosr/keel SDK root. Resolve it
    // once here so a misconfigured root (e.g. a relocated standalone binary)
    // fails fast with a clear message at startup, rather than mid-run or as a
    // transitive import crash.
    try {
      keelPackageRoot();
    } catch (err) {
      throw new Error(
        `keel daemon cannot start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // A crashed predecessor may have left a stale socket file; unlink it so we
    // can bind (recovery after kill -9).
    try {
      const { unlinkSync, existsSync } = await import("node:fs");
      if (existsSync(this.opts.socketPath)) unlinkSync(this.opts.socketPath);
    } catch {
      // best effort
    }
    const now = this.clock();
    this.api.reconcileWorkspaces({
      staleBeforeMs: ownerStaleBeforeMs(now, this.heartbeatMs),
      nowMs: now,
    });
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
          (socket as GatewaySocket).session = new SocketGatewaySession(socket);
        },
        data: (socket, data) => this.onData(socket as GatewaySocket, data),
        close: (socket) => {
          (socket as GatewaySocket).session?.close();
        },
      },
    });
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.superviseTimer) clearInterval(this.superviseTimer);
    this.server?.stop(true);
    this.kernel.shutdown();
    this.api.close();
    this.store.close();
  }

  private claimLaunchedRun(runId: string): void {
    this.store.claimRun(runId, this.ownerId, this.clock(), this.clock());
    this.owned.add(runId);
  }

  /** CAS-claim a run before driving it; throw if another live daemon owns it. */
  private claimOrReject(runId: string): void {
    if (!this.store.getRun(runId)) throw new Error(`run ${runId} not found`);
    const now = this.clock();
    const staleBefore = ownerStaleBeforeMs(now, this.heartbeatMs);
    if (!this.store.claimRun(runId, this.ownerId, staleBefore, now)) {
      throw new Error(`run ${runId} is owned by another live daemon (ownership fence)`);
    }
    this.owned.add(runId);
  }

  /** Reclaim runs left 'running' by a dead daemon and resume them. */
  private recoverOrphans(): void {
    const now = this.clock();
    const staleBefore = ownerStaleBeforeMs(now, this.heartbeatMs);
    for (const run of this.store.listRunsByStatus("running")) {
      if (this.store.claimRun(run.runId, this.ownerId, staleBefore, now)) {
        this.owned.add(run.runId);
        void this.api.resumeRun(run.runId).catch((err) => {
          if (isUnsupportedWorkflowSdkAbiError(err)) {
            failRunWithError(this.store, run.runId, err, this.clock());
          }
        });
      }
    }
  }

  private onData(socket: GatewaySocket, data: Buffer): void {
    const session = socket.session;
    if (!session) return;
    session.buf += data.toString("utf8");
    let nl = session.buf.indexOf("\n");
    while (nl >= 0) {
      const line = session.buf.slice(0, nl);
      session.buf = session.buf.slice(nl + 1);
      if (line.trim()) void this.dispatch(session, line);
      nl = session.buf.indexOf("\n");
    }
  }

  private async dispatch(session: SocketGatewaySession, line: string): Promise<void> {
    let req: GatewayRequest;
    try {
      const raw = JSON.parse(line) as {
        id?: unknown;
        method?: unknown;
        params?: unknown;
      };
      req = {
        id: raw.id,
        method: typeof raw.method === "string" ? raw.method : String(raw.method),
        params: raw.params,
        credential:
          typeof (raw as { credential?: unknown }).credential === "string" ||
          (raw as { credential?: unknown }).credential === null
            ? ((raw as { credential?: string | null }).credential ?? null)
            : undefined,
        surface: (raw as { surface?: unknown }).surface === "web" ? "web" : "local",
      };
    } catch {
      return;
    }
    session.sendResponse(await this.gateway.handle(session, req));
  }

  private assertNoDuplicateProfileSources(): void {
    const programmatic = this.kernel.getProgrammaticAgentProfiles();
    for (const row of this.store.listAgentProfileCatalogRows()) {
      if (programmatic[row.name]) {
        throw new Error(
          `duplicate agent profile "${row.name}" exists in programmatic and catalog sources`,
        );
      }
    }
  }
}
