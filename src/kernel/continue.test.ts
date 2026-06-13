// Phase 19: continueAsNew chains a fresh run with bounded journal growth.

import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm/realm-host.ts";

const loopUrl = captureWorkflowFile(
  new URL("./realm/fixtures/loop.workflow.ts", import.meta.url).pathname,
);

describe("continueAsNew", () => {
  test("ends the run as 'continued' and chains a fresh run until it returns", async () => {
    const store = JournalStore.memory();
    let n = 0;
    const kernel = new RealmKernel(store, { idgen: () => `loop-${n++}` });

    const first = await kernel.run<{ continuedTo: string }>(
      loopUrl,
      { count: 0 },
      { name: "loop" },
    );
    expect(first.status).toBe("continued");
    expect(first.output?.continuedTo).toBe("loop-1");
    // the first run's journal holds only its own work step (bounded growth)
    expect(store.getJournalRow("loop-0", "work", 1)?.status).toBe("completed");

    // drive the chain to completion (each continued run launched the next)
    await until(() => store.listRuns().some((r) => r.status === "finished"), 4000);
    const runs = store.listRuns();
    // loop-0 and loop-1 continued; loop-2 (count=2) finished with output 2
    expect(runs.find((r) => r.runId === "loop-0")?.status).toBe("continued");
    expect(runs.find((r) => r.runId === "loop-1")?.status).toBe("continued");
    const final = runs.find((r) => r.status === "finished");
    expect(final).toBeDefined();
    expect(JSON.parse(final?.outputRef ?? "null")).toBe(2);

    // lineage: each successor points back to its predecessor
    expect(runs.find((r) => r.runId === "loop-0")?.parentRunId).toBeNull();
    expect(runs.find((r) => r.runId === "loop-1")?.parentRunId).toBe("loop-0");
    expect(runs.find((r) => r.runId === "loop-2")?.parentRunId).toBe("loop-1");
  });

  test("resuming a 'continued' run does NOT create a duplicate successor (atomic handoff)", async () => {
    const store = JournalStore.memory();
    let n = 0;
    const kernel = new RealmKernel(store, { idgen: () => `c-${n++}` });
    await kernel.run(loopUrl, { count: 1 }, { name: "loop" }); // c-0 continues to c-1 (count 2 finishes)
    await until(() => store.getRun("c-1")?.status === "finished", 4000);
    const before = store.listRuns().length;
    // c-0 is terminal 'continued'; resuming it must short-circuit, not re-launch
    const resumed = await kernel.resume("c-0");
    expect(resumed.status).toBe("continued");
    expect(store.listRuns().length).toBe(before); // no new run created
  });
});

async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await Bun.sleep(25);
  }
  throw new Error("chain did not finish in time");
}
