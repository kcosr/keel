export type AgentConcurrencyLimit = number | "unlimited";

export interface AgentConcurrencyLimits {
  total: AgentConcurrencyLimit;
  byProvider: Readonly<Record<string, AgentConcurrencyLimit>>;
}

export interface AgentConcurrencyAcquireRequest {
  runId: string;
  stableKey: string;
  provider: string;
  signal?: AbortSignal;
}

export interface AgentConcurrencyPermit {
  release(): void;
}

export interface AgentConcurrencyScopeSnapshot {
  active: number;
  limit: AgentConcurrencyLimit;
}

export interface AgentConcurrencyWaitSnapshot {
  runId: string;
  stableKey: string;
  provider: string;
  queuedAtMs: number;
  queuedForMs: number;
  total: AgentConcurrencyScopeSnapshot;
  providerScope: AgentConcurrencyScopeSnapshot;
}

interface Waiter {
  request: Required<Omit<AgentConcurrencyAcquireRequest, "signal">> & { signal?: AbortSignal };
  queuedAtMs: number;
  resolve: (permit: AgentConcurrencyPermit) => void;
  reject: (err: Error) => void;
  cleanup?: () => void;
  granted: boolean;
}

export const AGENT_CONCURRENCY_UNLIMITED = "unlimited" as const;
export const DEFAULT_AGENT_MAX_CONCURRENT_TOTAL: AgentConcurrencyLimit =
  AGENT_CONCURRENCY_UNLIMITED;
export const DEFAULT_AGENT_MAX_CONCURRENT_BY_PROVIDER: Readonly<
  Record<string, AgentConcurrencyLimit>
> = Object.freeze({});

export class AgentConcurrencyLimiter {
  private activeTotal = 0;
  private readonly activeByProvider = new Map<string, number>();
  private readonly waiters: Waiter[] = [];
  private readonly clock: () => number;

  constructor(
    private readonly limits: AgentConcurrencyLimits,
    opts: { clock?: () => number } = {},
  ) {
    this.clock = opts.clock ?? (() => Date.now());
  }

  acquire(request: AgentConcurrencyAcquireRequest): Promise<AgentConcurrencyPermit> {
    if (request.signal?.aborted) return Promise.reject(abortError(request.signal));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        request: {
          runId: request.runId,
          stableKey: request.stableKey,
          provider: request.provider,
          ...(request.signal ? { signal: request.signal } : {}),
        },
        queuedAtMs: this.clock(),
        resolve,
        reject,
        granted: false,
      };
      if (request.signal) {
        const onAbort = () => {
          if (waiter.granted) return;
          this.removeWaiter(waiter);
          waiter.cleanup?.();
          reject(abortError(request.signal));
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => request.signal?.removeEventListener("abort", onAbort);
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  queuedWaitForRun(
    runId: string,
    nowMs: number = this.clock(),
  ): AgentConcurrencyWaitSnapshot | null {
    const waiter = this.waiters.find((candidate) => candidate.request.runId === runId);
    if (!waiter) return null;
    return this.snapshot(waiter, nowMs);
  }

  activeSnapshot(provider: string): {
    total: AgentConcurrencyScopeSnapshot;
    providerScope: AgentConcurrencyScopeSnapshot;
  } {
    return {
      total: { active: this.activeTotal, limit: this.limits.total },
      providerScope: {
        active: this.activeByProvider.get(provider) ?? 0,
        limit: this.providerLimit(provider),
      },
    };
  }

  private drain(): void {
    let i = 0;
    while (i < this.waiters.length) {
      const waiter = this.waiters[i] as Waiter;
      if (!this.canGrant(waiter.request.provider)) {
        i += 1;
        continue;
      }
      this.waiters.splice(i, 1);
      this.grant(waiter);
    }
  }

  private grant(waiter: Waiter): void {
    waiter.granted = true;
    waiter.cleanup?.();
    const provider = waiter.request.provider;
    this.activeTotal += 1;
    this.activeByProvider.set(provider, (this.activeByProvider.get(provider) ?? 0) + 1);
    let released = false;
    waiter.resolve({
      release: () => {
        if (released) return;
        released = true;
        this.activeTotal -= 1;
        const nextProviderActive = (this.activeByProvider.get(provider) ?? 0) - 1;
        if (nextProviderActive <= 0) this.activeByProvider.delete(provider);
        else this.activeByProvider.set(provider, nextProviderActive);
        this.drain();
      },
    });
  }

  private canGrant(provider: string): boolean {
    return (
      isBelowLimit(this.activeTotal, this.limits.total) &&
      isBelowLimit(this.activeByProvider.get(provider) ?? 0, this.providerLimit(provider))
    );
  }

  private providerLimit(provider: string): AgentConcurrencyLimit {
    return this.limits.byProvider[provider] ?? AGENT_CONCURRENCY_UNLIMITED;
  }

  private removeWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private snapshot(waiter: Waiter, nowMs: number): AgentConcurrencyWaitSnapshot {
    const provider = waiter.request.provider;
    return {
      runId: waiter.request.runId,
      stableKey: waiter.request.stableKey,
      provider,
      queuedAtMs: waiter.queuedAtMs,
      queuedForMs: Math.max(0, nowMs - waiter.queuedAtMs),
      total: { active: this.activeTotal, limit: this.limits.total },
      providerScope: {
        active: this.activeByProvider.get(provider) ?? 0,
        limit: this.providerLimit(provider),
      },
    };
  }
}

function isBelowLimit(active: number, limit: AgentConcurrencyLimit): boolean {
  return limit === AGENT_CONCURRENCY_UNLIMITED || active < limit;
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error("agent concurrency wait aborted");
}
