// Review-fix regression (REVIEW_LOG open item #1): an onFailure:'null' agent
// whose failure is accepted must journal a COMPLETED null and replay it on
// resume — never re-call the agent.

import { describe, expect, test } from "bun:test";
import { MockProvider } from "../../agents/mock.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const url = captureWorkflowFile(
  new URL("./fixtures/tolerant.workflow.ts", import.meta.url).pathname,
);

function kernel(store: JournalStore, mock: MockProvider, extra: Record<string, unknown> = {}) {
  return new RealmKernel(store, {
    idgen: () => "r",
    clock: () => 1,
    rng: () => 0.5,
    agents: new AgentProviderRegistry().register(mock),
    ...extra,
  });
}

describe("onFailure:'null' is journaled as completed null and replays", () => {
  test("an accepted failure is a completed null row (not failed)", async () => {
    const store = JournalStore.memory();
    // never-valid output → the agent fails schema validation → tolerated as null
    const mock = new MockProvider({ responses: { maybe: { outputs: ["not json"] } } });
    const handle = await kernel(store, mock).run<number>(url, null, {
      name: "t",
      target: process.cwd(),
    });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe(1); // null → 0 → +1
    const row = store.getJournalRow("r", "maybe", 1);
    expect(row?.status).toBe("completed"); // NOT failed
    expect(row?.resultInline).toBe("null");
  });

  test("a crash after acceptance, then resume, does NOT re-call the agent", async () => {
    const store = JournalStore.memory();
    let calls = 0;
    const mock = new MockProvider({ responses: { maybe: { outputs: ["not json"] } } });
    const counting = new Proxy(mock, {
      get(t, p) {
        if (p === "generate") {
          return async (...a: Parameters<typeof t.generate>) => {
            calls++;
            return t.generate(...a);
          };
        }
        return Reflect.get(t, p);
      },
    });

    // crash at before-commit of the LATER step, after the agent was accepted null
    const k1 = kernel(store, counting as MockProvider, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "use") throw new Error("CRASH");
      },
    });
    await k1.run(url, null, { name: "t", target: process.cwd() }).catch(() => null);
    // the agent was called (schema-retried, then accepted null → completed)
    expect(calls).toBeGreaterThan(0);
    const afterRun = calls;
    expect(store.getJournalRow("r", "maybe", 1)?.status).toBe("completed");
    expect(store.getRun("r")?.status).toBe("running"); // resumable (crash on `use`)

    // resume: the agent REPLAYS its null; only `use` re-runs
    const k2 = kernel(store, counting as MockProvider);
    const resumed = await k2.resume<number>("r");
    expect(resumed.output).toBe(1);
    expect(calls).toBe(afterRun); // agent NOT re-called (the bug: it would increase)
  });
});
