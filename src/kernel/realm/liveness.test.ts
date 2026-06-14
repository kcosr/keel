// Phase 13: liveness — per-attempt stall timeout + stall-retry, StepTimeoutError,
// and the blockage diagnosis API.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_LENIENT,
  DEFAULT_AGENT_ON_FAILURE,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_SCHEMA_MAX_RETRIES,
  DEFAULT_STALL_RETRIES,
} from "../../agents/defaults.ts";
import { StepTimeoutError, runAgentWithStall } from "../../agents/execute.ts";
import { MockProvider } from "../../agents/mock.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { getBlockage } from "../../rpc/projection.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const stallUrl = captureWorkflowFile(
  new URL("./fixtures/stall.workflow.ts", import.meta.url).pathname,
);

function kernel(store: JournalStore, mock: MockProvider, extra: Record<string, unknown> = {}) {
  return new RealmKernel(store, {
    idgen: () => "r",
    agents: new AgentProviderRegistry().register(mock),
    ...extra,
  });
}

describe("runAgentWithStall", () => {
  test("agent defaults are centralized", () => {
    expect(DEFAULT_AGENT_PROVIDER).toBe("pi");
    expect(DEFAULT_SCHEMA_MAX_RETRIES).toBe(2);
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(60 * 60_000);
    expect(DEFAULT_STALL_RETRIES).toBe(1);
    expect(DEFAULT_AGENT_LENIENT).toBe(false);
    expect(DEFAULT_AGENT_ON_FAILURE).toBe("throw");
  });

  test("a stalled attempt is detected and retried, then succeeds", async () => {
    let attempt = 0;
    const stalls: number[] = [];
    const result = await runAgentWithStall(
      () => {
        const a = attempt++;
        // attempt 0 stalls (never resolves within timeout); attempt 1 is instant
        return a === 0
          ? new Promise(() => {})
          : Promise.resolve({
              output: { value: 1 },
              text: '{"value":1}',
              transcript: [],
              attempts: 1,
            });
      },
      { timeoutMs: 50, stallRetries: 2, onStall: (n) => stalls.push(n) },
    );
    expect(result.output).toEqual({ value: 1 });
    expect(stalls).toEqual([0]); // one stall detected on attempt 0
  });

  test("a perpetual stall throws StepTimeoutError after the retries", async () => {
    await expect(
      runAgentWithStall(() => new Promise(() => {}), { timeoutMs: 40, stallRetries: 1 }),
    ).rejects.toBeInstanceOf(StepTimeoutError);
  });
});

describe("ctx.agent stall-retry through the realm", () => {
  test("a stalling agent is detected, retried, and completes", async () => {
    const store = JournalStore.memory();
    // first call stalls (delay 5s >> 150ms timeout); second call is instant valid
    const mock = new MockProvider({
      responses: { slow: { outputs: ['{"value":7}', '{"value":7}'], delayMs: 5000 } },
    });
    // make only the FIRST generate slow: delayMs applies to every call, so instead
    // script two responses where attempt 0 is slow via a wrapper.
    let calls = 0;
    const wrapped = new Proxy(mock, {
      get(t, p) {
        if (p === "generate") {
          return async (...a: Parameters<typeof t.generate>) => {
            const n = calls++;
            if (n === 0) await Bun.sleep(5000); // stall the first attempt
            return { text: '{"value":7}', transcript: [] };
          };
        }
        return Reflect.get(t, p);
      },
    });
    const handle = await kernel(store, wrapped as MockProvider).run<{ value: number }>(
      stallUrl,
      {},
      { name: "stall", target: process.cwd() },
    );
    expect(handle.status).toBe("finished");
    expect(handle.output).toEqual({ value: 7 });
    // an agent.stalled event was emitted
    const stalled = store.listEvents("r").some((e) => e.type === "agent.stalled");
    expect(stalled).toBe(true);
  }, 20000);

  test("a perpetual stall fails the run with StepTimeoutError (unless tolerated)", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: { slow: { outputs: ['{"value":1}'], delayMs: 5000 } },
    });
    await expect(
      kernel(store, mock).run(stallUrl, {}, { name: "stall", target: process.cwd() }),
    ).rejects.toThrow(/stalled past/);
    expect(store.getRun("r")?.status).toBe("failed");
  }, 20000);

  test("a perpetual stall with onFailure:null is tolerated as null", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: { slow: { outputs: ['{"value":1}'], delayMs: 5000 } },
    });
    const handle = await kernel(store, mock).run<{ value: number } | null>(
      stallUrl,
      { onFailure: "null" },
      { name: "stall", target: process.cwd() },
    );
    expect(handle.status).toBe("finished");
    expect(handle.output).toBeNull();
  }, 20000);
});

describe("getBlockage", () => {
  function seedRun(store: JournalStore, status: string) {
    store.insertRun({
      runId: "r",
      workflowName: "w",
      definitionVersion: "v0",
      status: status as never,
      parentRunId: null,
      tenantId: null,
      inputRef: "null",
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      createdAtMs: 0,
    });
  }

  test("running with no stalled step reads as running", () => {
    const store = JournalStore.memory();
    seedRun(store, "running");
    expect(getBlockage(store, "r", 1000).reason).toBe("running");
  });

  test("a long-pending step reads as stalled_no_heartbeat with blockedOn", () => {
    const store = JournalStore.memory();
    seedRun(store, "running");
    store.putJournalRow({
      runId: "r",
      stableKey: "verify:x",
      effectType: "effectful",
      status: "pending",
      version: "v",
      inputHash: "h",
      startedAtMs: 1000,
    });
    const b = getBlockage(store, "r", 1000 + 40_000, 30_000);
    expect(b.reason).toBe("stalled_no_heartbeat");
    expect(b.blockedOn).toEqual({ stableKey: "verify:x", since: 1000 });
  });

  test("waiting-human maps to waiting_human; terminal maps to none", () => {
    const s1 = JournalStore.memory();
    seedRun(s1, "waiting-human");
    expect(getBlockage(s1, "r", 1).reason).toBe("waiting_human");
    const s2 = JournalStore.memory();
    seedRun(s2, "finished");
    expect(getBlockage(s2, "r", 1).reason).toBe("none");
  });
});
