import { describe, expect, test } from "bun:test";
import { AgentConcurrencyLimiter } from "../../agents/concurrency.ts";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
} from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { EventHub } from "../../rpc/event-hub.ts";
import { InProcessKeel } from "../../rpc/in-process.ts";
import { RealmKernel } from "./realm-host.ts";

const PARALLEL_AGENTS_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string[]> {
      return await Promise.all([
        ctx.agent({ key: "a", provider: "hold", prompt: "a" }),
        ctx.agent({ key: "b", provider: "hold", prompt: "b" }),
      ]);
    }
  `,
  name: "parallel-agents",
};

const PROVIDER_SPECIFIC_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string[]> {
      return await Promise.all([
        ctx.agent({ key: "hold-a", provider: "hold", prompt: "hold-a" }),
        ctx.agent({ key: "hold-b", provider: "hold", prompt: "hold-b" }),
        ctx.agent({ key: "other", provider: "other", prompt: "other" }),
      ]);
    }
  `,
  name: "provider-specific",
};

const PARALLEL_SESSION_TURNS_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string[]> {
      const left = ctx.agentSession({ key: "left", provider: "hold" });
      const right = ctx.agentSession({ key: "right", provider: "hold" });
      return await Promise.all([
        left.turn({ key: "one", prompt: "left" }),
        right.turn({ key: "one", prompt: "right" }),
      ]);
    }
  `,
  name: "parallel-session-turns",
};

const FIRE_AND_FAIL_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string> {
      void ctx.agent({ key: "queued", provider: "hold", prompt: "should-not-run" });
      throw new Error("boom after queue");
    }
  `,
  name: "fire-and-fail",
};

const UNKNOWN_PROVIDER_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string> {
      return await ctx.agent({ key: "missing", provider: "missing", prompt: "x" });
    }
  `,
  name: "unknown-provider",
};

const SHORT_TIMEOUT_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string> {
      return await ctx.agent({
        key: "queued",
        provider: "hold",
        prompt: "done",
        timeoutMs: 10,
        stallRetries: 0,
      });
    }
  `,
  name: "short-timeout",
};

class DelayProvider implements AgentProvider {
  readonly supportsSessions = true;
  active = 0;
  maxActive = 0;
  calls: string[] = [];

  constructor(
    private readonly delayMs: number,
    readonly name = "hold",
    private readonly onStart?: (invocation: AgentInvocation) => void,
  ) {}

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    this.calls.push(invocation.key);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.onStart?.(invocation);
    if (this.supportsSessions) {
      const token = invocation.resumeToken ?? `session-${invocation.key}`;
      hooks.onSessionToken?.(token);
    }
    await Bun.sleep(this.delayMs);
    this.active -= 1;
    return { text: invocation.prompt, transcript: [] };
  }
}

class AbortableFirstProvider implements AgentProvider {
  readonly name = "hold";
  readonly calls: string[] = [];
  aborted = false;
  private readonly firstStartedPromise: Promise<void>;
  private resolveFirstStarted!: () => void;

  constructor() {
    this.firstStartedPromise = new Promise((resolve) => {
      this.resolveFirstStarted = resolve;
    });
  }

  async generate(invocation: AgentInvocation): Promise<AgentResult> {
    this.calls.push(invocation.key);
    if (this.calls.length === 1) {
      this.resolveFirstStarted();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          this.aborted = true;
          reject(new Error("provider aborted"));
        };
        if (invocation.abortSignal?.aborted) abort();
        else invocation.abortSignal?.addEventListener("abort", abort, { once: true });
      });
    }
    return { text: invocation.prompt, transcript: [] };
  }

  waitForFirstStarted(): Promise<void> {
    return this.firstStartedPromise;
  }
}

class BlockingProvider implements AgentProvider {
  readonly name = "hold";
  readonly calls: string[] = [];
  private readonly firstStartedPromise: Promise<void>;
  private resolveFirstStarted!: () => void;
  private readonly releaseFirstPromise: Promise<void>;
  private resolveReleaseFirst!: () => void;

  constructor() {
    this.firstStartedPromise = new Promise((resolve) => {
      this.resolveFirstStarted = resolve;
    });
    this.releaseFirstPromise = new Promise((resolve) => {
      this.resolveReleaseFirst = resolve;
    });
  }

  async generate(invocation: AgentInvocation): Promise<AgentResult> {
    this.calls.push(invocation.key);
    if (this.calls.length === 1) {
      this.resolveFirstStarted();
      await this.releaseFirstPromise;
    }
    return { text: invocation.prompt, transcript: [] };
  }

  waitForFirstStarted(): Promise<void> {
    return this.firstStartedPromise;
  }

  releaseFirst(): void {
    this.resolveReleaseFirst();
  }
}

function kernel(
  store: JournalStore,
  provider: AgentProvider,
  limiter: AgentConcurrencyLimiter,
  clock: () => number = () => 1,
): RealmKernel {
  return new RealmKernel(store, {
    idgen: () => "run_concurrency",
    clock,
    agents: new AgentProviderRegistry().register(provider),
    agentConcurrency: limiter,
  });
}

function kernelWithProviders(
  store: JournalStore,
  providers: AgentProvider[],
  limiter: AgentConcurrencyLimiter,
  clock: () => number = () => 1,
): RealmKernel {
  const registry = new AgentProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return new RealmKernel(store, {
    idgen: () => "run_concurrency",
    clock,
    agents: registry,
    agentConcurrency: limiter,
  });
}

async function eventually<T>(fn: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 50; i += 1) {
    const value = fn();
    if (value) return value;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
}

describe("realm agent concurrency limits", () => {
  test("total limit serializes parallel ctx.agent calls", async () => {
    const store = JournalStore.memory();
    const provider = new DelayProvider(20);
    const limiter = new AgentConcurrencyLimiter({ total: 1, byProvider: {} });

    const handle = await kernel(store, provider, limiter).run<string[]>(
      PARALLEL_AGENTS_WORKFLOW,
      null,
      { target: process.cwd() },
    );

    expect(handle.status).toBe("finished");
    expect(handle.output).toEqual(["a", "b"]);
    expect(provider.calls.sort()).toEqual(["a", "b"]);
    expect(provider.maxActive).toBe(1);
  });

  test("total limit serializes parallel ctx.agentSession turns", async () => {
    const store = JournalStore.memory();
    const provider = new DelayProvider(20);
    const limiter = new AgentConcurrencyLimiter({ total: 1, byProvider: {} });

    const handle = await kernel(store, provider, limiter).run<string[]>(
      PARALLEL_SESSION_TURNS_WORKFLOW,
      null,
      { target: process.cwd() },
    );

    expect(handle.status).toBe("finished");
    expect(handle.output).toEqual(["left", "right"]);
    expect(provider.calls.sort()).toEqual(["__session.left.one", "__session.right.one"]);
    expect(provider.maxActive).toBe(1);
  });

  test("provider-specific limit serializes only matching providers through the realm", async () => {
    const store = JournalStore.memory();
    const starts: Array<{ provider: string; key: string; holdActive: number }> = [];
    const hold = new DelayProvider(25, "hold", (invocation) => {
      starts.push({ provider: "hold", key: invocation.key, holdActive: hold.active });
    });
    const other = new DelayProvider(0, "other", (invocation) => {
      starts.push({ provider: "other", key: invocation.key, holdActive: hold.active });
    });
    const limiter = new AgentConcurrencyLimiter({
      total: "unlimited",
      byProvider: { hold: 1 },
    });

    const handle = await kernelWithProviders(store, [hold, other], limiter).run<string[]>(
      PROVIDER_SPECIFIC_WORKFLOW,
      null,
      { target: process.cwd() },
    );

    expect(handle.status).toBe("finished");
    expect(handle.output?.sort()).toEqual(["hold-a", "hold-b", "other"]);
    expect(hold.maxActive).toBe(1);
    expect(other.maxActive).toBe(1);
    expect(starts.some((start) => start.provider === "other" && start.holdActive > 0)).toBe(true);
  });

  test("API blockage and report expose queued fresh running runs", async () => {
    let now = 1_000;
    const clock = () => now;
    const store = JournalStore.memory();
    const provider = new BlockingProvider();
    const limiter = new AgentConcurrencyLimiter({ total: 1, byProvider: {} }, { clock });
    const realm = kernel(store, provider, limiter, clock);
    const api = new InProcessKeel(realm, store, new EventHub(), {
      agents: new AgentProviderRegistry().register(provider),
      clock,
      agentConcurrency: limiter,
    });

    const launched = await api.launchRun({
      source: PARALLEL_AGENTS_WORKFLOW.source,
      input: null,
      target: process.cwd(),
      name: "queued",
    });
    await provider.waitForFirstStarted();
    await eventually(() => {
      const candidate = api.getBlockage(launched.runId);
      return candidate.reason === "agent_concurrency" ? candidate : null;
    });
    now = 1_250;
    const blockage = api.getBlockage(launched.runId);

    expect(blockage).toMatchObject({
      reason: "agent_concurrency",
      blockedOn: { stableKey: "b", since: 1_000 },
      agentConcurrency: {
        stableKey: "b",
        provider: "hold",
        queuedAtMs: 1_000,
        queuedForMs: 250,
        total: { active: 1, limit: 1 },
      },
    });
    expect(api.getRun(launched.runId)?.status).toBe("running");
    expect(api.getRunReport(launched.runId)?.blockage).toMatchObject({
      reason: "agent_concurrency",
      blockedOn: { stableKey: "b", since: 1_000 },
    });

    now = 100_000;
    store.updateRun(launched.runId, { runtimeOwnerId: "daemon_a", heartbeatAtMs: 0 });
    expect(api.getBlockage(launched.runId)).toMatchObject({
      reason: "stalled_no_heartbeat",
      blockedOn: null,
    });

    provider.releaseFirst();
    const outcome = await api.waitForRun(launched.runId);
    expect(outcome.status).toBe("finished");
    api.close();
  });

  test("queued agents are cancelled when the run settles before capacity is granted", async () => {
    const store = JournalStore.memory();
    const provider = new DelayProvider(0);
    const limiter = new AgentConcurrencyLimiter({ total: 1, byProvider: {} });
    const external = await limiter.acquire({
      runId: "external",
      stableKey: "external",
      provider: "hold",
    });

    await expect(
      kernel(store, provider, limiter).run<string>(FIRE_AND_FAIL_WORKFLOW, null, {
        target: process.cwd(),
      }),
    ).rejects.toThrow("boom after queue");

    expect(store.getRun("run_concurrency")?.status).toBe("failed");
    expect(limiter.queuedWaitForRun("run_concurrency")).toBeNull();
    external.release();
    await Bun.sleep(20);
    expect(provider.calls).toEqual([]);
  });

  test("unknown ctx.agent provider fails before waiting for concurrency capacity", async () => {
    const store = JournalStore.memory();
    const provider = new DelayProvider(0);
    const limiter = new AgentConcurrencyLimiter({ total: 1, byProvider: {} });
    const external = await limiter.acquire({
      runId: "external",
      stableKey: "external",
      provider: "hold",
    });
    try {
      await expect(
        kernel(store, provider, limiter).run<string>(UNKNOWN_PROVIDER_WORKFLOW, null, {
          target: process.cwd(),
        }),
      ).rejects.toThrow(/no agent provider registered for "missing"/);
      expect(limiter.queuedWaitForRun("run_concurrency")).toBeNull();
      expect(provider.calls).toEqual([]);
    } finally {
      external.release();
    }
  });

  test("interrupting a run with a queued agent removes the waiter and releases capacity", async () => {
    const store = JournalStore.memory();
    const provider = new AbortableFirstProvider();
    const limiter = new AgentConcurrencyLimiter({ total: 1, byProvider: {} });
    const k = kernel(store, provider, limiter);
    const { runId, done } = k.launch<string[]>(PARALLEL_AGENTS_WORKFLOW, null, {
      target: process.cwd(),
    });

    await provider.waitForFirstStarted();
    await eventually(() => limiter.queuedWaitForRun(runId));
    expect(k.interruptRun(runId, "pause")).toEqual({ runId, status: "interrupted" });

    await expect(done).resolves.toMatchObject({ runId, status: "interrupted" });
    expect(provider.aborted).toBe(true);
    expect(limiter.queuedWaitForRun(runId)).toBeNull();
    await eventually(() =>
      limiter.activeSnapshot("hold").total.active === 0 ? { released: true } : null,
    );
    expect(limiter.activeSnapshot("hold")).toMatchObject({
      total: { active: 0, limit: 1 },
      providerScope: { active: 0 },
    });
    const probe = await limiter.acquire({ runId: "probe", stableKey: "probe", provider: "hold" });
    probe.release();
    expect(provider.calls).toEqual(["a"]);
  });

  test("queue wait does not count against agent timeoutMs", async () => {
    const store = JournalStore.memory();
    const provider = new DelayProvider(0);
    const limiter = new AgentConcurrencyLimiter({ total: 1, byProvider: {} });
    const external = await limiter.acquire({
      runId: "external",
      stableKey: "external",
      provider: "hold",
    });
    const run = kernel(store, provider, limiter).run<string>(SHORT_TIMEOUT_WORKFLOW, null, {
      target: process.cwd(),
    });

    await eventually(() => limiter.queuedWaitForRun("run_concurrency"));
    await Bun.sleep(40);
    external.release();

    const handle = await run;
    expect(handle).toMatchObject({ status: "finished", output: "done" });
    expect(store.listEvents("run_concurrency").map((event) => event.type)).not.toContain(
      "agent.stalled",
    );
  });
});
