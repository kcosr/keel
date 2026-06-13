// Phase 7: ctx.agent against the deterministic mock provider — structured output,
// bounded schema retry, replay (exactly-once) vs re-execution (at-least-once),
// and crash consistency through the realm.

import { describe, expect, test } from "bun:test";
import { MockProvider } from "../../agents/mock.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const FIX = new URL("./fixtures/", import.meta.url);
const reviewUrl = captureWorkflowFile(new URL("agent-review.workflow.ts", FIX).pathname);
const singleUrl = captureWorkflowFile(new URL("agent-single.workflow.ts", FIX).pathname);

function kernel(
  store: JournalStore,
  mock: MockProvider,
  extra: Record<string, unknown> = {},
): RealmKernel {
  let id = 0;
  return new RealmKernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => 1,
    rng: () => 0.5,
    agents: new AgentProviderRegistry().register(mock),
    ...extra,
  });
}

describe("ctx.agent — structured output + fan-out", () => {
  test("a fan-out of agents validates output and aggregates", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: {
        "review:auth": { outputs: ['{"findings":[{"title":"a"},{"title":"b"}]}'] },
        "review:net": { outputs: ['```json\n{"findings":[{"title":"c"}]}\n```'] },
      },
    });
    const handle = await kernel(store, mock).run<number>(
      reviewUrl,
      { domains: ["auth", "net"] },
      { name: "review" },
    );
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe(3); // 2 + 1 findings
    // the agent steps are journaled as effectful
    const rows = store.listJournalRows("run_0");
    const agents = rows.filter((r) => r.effectType === "effectful");
    expect(agents.map((r) => r.stableKey).sort()).toEqual(["review:auth", "review:net"]);
  });
});

describe("ctx.agent — bounded schema retry", () => {
  test("invalid-then-valid output retries in-session and succeeds", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: {
        ask: {
          // first attempt: not valid JSON; second: valid
          outputs: ["sorry, no JSON here", '{"value":21}'],
        },
      },
    });
    const handle = await kernel(store, mock).run<number>(singleUrl, null, { name: "s" });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe(42); // 21 * 2
  });

  test("never-valid output fails the run after retries", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: { ask: { outputs: ["nope"] } },
    });
    await expect(kernel(store, mock).run(singleUrl, null, { name: "s" })).rejects.toThrow(
      /failed schema validation/,
    );
    expect(store.getRun("run_0")?.status).toBe("failed");
  });
});

describe("ctx.agent — replay vs re-execution", () => {
  test("a completed agent replays on resume (exactly-once); pending re-executes", async () => {
    const store = JournalStore.memory();
    let asks = 0;
    const mock = new MockProvider({
      responses: { ask: { outputs: ['{"value":5}'] } },
    });
    // wrap generate to count
    const counting = new Proxy(mock, {
      get(t, p) {
        if (p === "generate") {
          return async (...args: Parameters<typeof t.generate>) => {
            asks++;
            return t.generate(...args);
          };
        }
        return Reflect.get(t, p);
      },
    });

    // Run with a before-commit fault on the pure step AFTER the agent, so the
    // agent commits but the run aborts → resume replays the agent (no re-ask).
    const exec: string[] = [];
    const k1 = kernel(store, counting as MockProvider, {
      onStepExecute: (key: string) => exec.push(key),
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "double") throw new Error("CRASH");
      },
    });
    await k1.run(singleUrl, null, { name: "s" }).catch(() => null);
    expect(asks).toBe(1); // agent ran once
    expect(store.getRun("run_0")?.status).toBe("running"); // resumable

    const k2 = kernel(store, counting as MockProvider);
    const resumed = await k2.resume<number>("run_0");
    expect(resumed.output).toBe(10);
    expect(asks).toBe(1); // agent REPLAYED — not re-asked (exactly-once)
  });

  test("a crash before the agent commits re-executes it on resume (at-least-once)", async () => {
    const store = JournalStore.memory();
    let asks = 0;
    const mock = new MockProvider({ responses: { ask: { outputs: ['{"value":7}'] } } });
    const counting = new Proxy(mock, {
      get(t, p) {
        if (p === "generate") {
          return async (...args: Parameters<typeof t.generate>) => {
            asks++;
            return t.generate(...args);
          };
        }
        return Reflect.get(t, p);
      },
    });

    const k1 = kernel(store, counting as MockProvider, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "ask") throw new Error("CRASH");
      },
    });
    await k1.run(singleUrl, null, { name: "s" }).catch(() => null);
    expect(asks).toBe(1); // ran, but crashed before commit
    expect(store.getRun("run_0")?.status).toBe("running");

    const k2 = kernel(store, counting as MockProvider);
    const resumed = await k2.resume<number>("run_0");
    expect(resumed.output).toBe(14);
    expect(asks).toBe(2); // re-executed on resume (at-least-once)
  });
});
