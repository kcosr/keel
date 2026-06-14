import { describe, expect, test } from "bun:test";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
} from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { RealmKernel } from "./realm-host.ts";

const AGENT_WORKFLOW = {
  source: `
    import { type Ctx, jsonSchema } from "@kcosr/keel";
    const Out = jsonSchema<{ value: number }>({
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "number" } },
    });
    export default async function wf(ctx: Ctx): Promise<number> {
      const got = await ctx.agent({ key: "agent", provider: "interrupt", prompt: "value", schema: Out });
      return got.value;
    }
  `,
  name: "interrupt-agent",
};

const SESSION_WORKFLOW = {
  source: `
    import { type Ctx, jsonSchema } from "@kcosr/keel";
    const Out = jsonSchema<{ value: number }>({
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "number" } },
    });
    export default async function wf(ctx: Ctx): Promise<number> {
      const session = ctx.agentSession({ key: "primary", provider: "interrupt", toolPolicy: "read-only" });
      const got = await session.turn({ key: "draft", prompt: "draft", schema: Out });
      return got.value;
    }
  `,
  name: "interrupt-session",
};

const SLOW_STEP_WORKFLOW = {
  source: `
    import { type Ctx, jsonSchema } from "@kcosr/keel";
    const Num = jsonSchema<number>({ type: "number" });
    export default async function wf(ctx: Ctx): Promise<number> {
      return await ctx.step("slow", Num, null, async () => {
        await new Promise(() => {});
        return 1;
      });
    }
  `,
  name: "interrupt-step",
};

class InterruptibleProvider implements AgentProvider {
  readonly name = "interrupt";
  readonly calls: AgentInvocation[] = [];
  aborted = false;
  private startedResolve!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  async generate(invocation: AgentInvocation): Promise<AgentResult> {
    this.calls.push(invocation);
    if (this.calls.length > 1) {
      return { text: '{"value":2}', transcript: [] };
    }
    this.startedResolve();
    return new Promise((_resolve, reject) => {
      invocation.abortSignal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          reject(new Error("aborted by interrupt"));
        },
        { once: true },
      );
    });
  }

  waitForStart(): Promise<void> {
    return this.started;
  }
}

class ImmediateProvider implements AgentProvider {
  readonly name = "interrupt";

  async generate(): Promise<AgentResult> {
    return { text: '{"value":1}', transcript: [] };
  }
}

class InterruptibleSessionProvider implements AgentProvider {
  readonly name = "interrupt";
  readonly supportsSessions = true;
  readonly calls: AgentInvocation[] = [];
  aborted = false;
  private startedResolve!: () => void;
  private readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    this.calls.push(invocation);
    const token = invocation.resumeToken ?? "sess-1";
    hooks.onSessionToken?.(token);
    this.startedResolve();
    if (this.calls.length > 1) {
      return { text: '{"value":7}', transcript: [], sessionToken: token };
    }
    return new Promise((_resolve, reject) => {
      invocation.abortSignal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          reject(new Error("aborted by interrupt"));
        },
        { once: true },
      );
    });
  }

  waitForStart(): Promise<void> {
    return this.started;
  }
}

function kernel(store: JournalStore, provider?: AgentProvider): RealmKernel {
  return new RealmKernel(store, {
    idgen: () => "run-1",
    clock: () => 1,
    rng: () => 0.5,
    ...(provider ? { agents: new AgentProviderRegistry().register(provider) } : {}),
  });
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition not met in time");
}

describe("RealmKernel interruptRun", () => {
  test("interrupts active pure work without journaling a failure", async () => {
    const store = JournalStore.memory();
    const k = kernel(store);
    const { runId, done } = k.launch<number>(SLOW_STEP_WORKFLOW, null);

    await until(() => store.getLatestAttempt(runId, "slow")?.status === "pending");
    expect(k.interruptRun(runId)).toEqual({ runId, status: "interrupted" });

    await expect(done).resolves.toMatchObject({ runId, status: "interrupted" });
    expect(store.getRun(runId)?.status).toBe("interrupted");
    expect(store.getLatestAttempt(runId, "slow")?.status).toBe("pending");
    expect(store.listEvents(runId).map((e) => e.type)).toContain("run.interrupted");
  });

  test("interrupts active agent work, redacts the durable reason, and resumes from pending", async () => {
    const store = JournalStore.memory();
    const provider = new InterruptibleProvider();
    const k = kernel(store, provider);
    const { runId, done } = k.launch<number>(AGENT_WORKFLOW, null, {
      target: process.cwd(),
    });

    await provider.waitForStart();
    expect(store.getLatestAttempt(runId, "agent")?.status).toBe("pending");
    k.interruptRun(runId, "inspect kc_run_secretToken");

    await expect(done).resolves.toMatchObject({ runId, status: "interrupted" });
    expect(provider.aborted).toBe(true);
    expect(store.getLatestAttempt(runId, "agent")?.status).toBe("pending");
    const interrupted = store.listEvents(runId).find((e) => e.type === "run.interrupted");
    expect(JSON.parse(interrupted?.payloadJson ?? "{}")).toEqual({
      previousStatus: "running",
      reason: "inspect «redacted-capability»",
    });
    expect(store.listEvents(runId).some((e) => e.type === "agent.message")).toBe(false);

    const resumed = await k.resume<number>(runId);
    expect(resumed).toMatchObject({ runId, status: "finished", output: 2 });
    expect(provider.calls).toHaveLength(2);
  });

  test("interrupts agent-session turns after token observation and resumes with that token", async () => {
    const store = JournalStore.memory();
    const provider = new InterruptibleSessionProvider();
    const k = kernel(store, provider);
    const { runId, done } = k.launch<number>(SESSION_WORKFLOW, null, {
      target: process.cwd(),
    });

    await provider.waitForStart();
    k.interruptRun(runId, "session pause");

    await expect(done).resolves.toMatchObject({ runId, status: "interrupted" });
    expect(provider.aborted).toBe(true);
    expect(store.getJournalRow(runId, "__session.primary.draft", 1)?.status).toBe("pending");
    expect(store.getLatestAgentSessionTurn(runId, "primary", "draft")?.observedSessionToken).toBe(
      "sess-1",
    );
    expect(store.listEvents(runId).some((e) => e.type === "agent.message")).toBe(false);

    const resumed = await k.resume<number>(runId);
    expect(resumed).toMatchObject({ runId, status: "finished", output: 7 });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.resumeToken).toBe("sess-1");
  });

  test("rejects terminal runs and duplicate interrupt is idempotent", async () => {
    const store = JournalStore.memory();
    const k = kernel(store, new ImmediateProvider());
    const finished = await k.run<number>(AGENT_WORKFLOW, null, { target: process.cwd() });

    expect(() => k.interruptRun(finished.runId)).toThrow(/cannot interrupt terminal run/);
    store.updateRun(finished.runId, { status: "waiting-signal", finishedAtMs: null });
    expect(k.interruptRun(finished.runId)).toEqual({
      runId: finished.runId,
      status: "interrupted",
    });
    expect(k.interruptRun(finished.runId, "again")).toEqual({
      runId: finished.runId,
      status: "interrupted",
    });
    expect(
      store.listEvents(finished.runId).filter((e) => e.type === "run.interrupted"),
    ).toHaveLength(1);
  });
});
