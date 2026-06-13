// Phase 18: time travel — retry a failed run, rewind to a step, fork a run.

import { describe, expect, test } from "bun:test";
import { MockProvider } from "../../agents/mock.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const tripleUrl = captureWorkflowFile(
  new URL("./fixtures/triple.workflow.ts", import.meta.url).pathname,
);
const flakyUrl = captureWorkflowFile(
  new URL("./fixtures/flaky.workflow.ts", import.meta.url).pathname,
);
const napUrl = captureWorkflowFile(new URL("./fixtures/nap.workflow.ts", import.meta.url).pathname);

describe("retry", () => {
  test("a failed run retries only from the failed step; upstream replays", async () => {
    const store = JournalStore.memory();
    // attempts 0..2 (run 1, all invalid) fail terminally; attempt 3 (retry) is valid
    const mock = new MockProvider({
      responses: { flaky: { outputs: ["bad", "bad", "bad", '{"ok":true}'] } },
    });
    const executed: string[] = [];
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(mock),
      onStepExecute: (k) => executed.push(k),
    });

    const first = await kernel.run<string>(flakyUrl, null, { name: "flaky" }).catch(() => null);
    expect(store.getRun("r")?.status).toBe("failed");
    expect(executed).toEqual(["pre", "flaky"]); // pre + the failing agent ran
    expect(first).toBeNull();

    executed.length = 0;
    const retried = await kernel.retry<string>("r");
    expect(retried.status).toBe("finished");
    expect(retried.output).toBe("done:true");
    // pre REPLAYED (not re-executed); only the flaky agent + post ran on retry
    expect(executed).toEqual(["flaky", "post"]);
  });
});

describe("rewind", () => {
  test("rewinding to step b discards c and re-runs only c", async () => {
    const store = JournalStore.memory();
    const executed: string[] = [];
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      onStepExecute: (k) => executed.push(k),
    });

    const done = await kernel.run<number>(tripleUrl, null, { name: "triple" });
    expect(done.output).toBe(3);
    expect(executed).toEqual(["a", "b", "c"]);
    expect(store.getLatestAttempt("r", "c")).not.toBeNull();

    executed.length = 0;
    const rewound = await kernel.rewind<number>("r", "b");
    expect(rewound.status).toBe("finished");
    expect(rewound.output).toBe(3);
    // a, b replayed; only c re-executed
    expect(executed).toEqual(["c"]);
  });
});

describe("rewind clears unresolved durable-wait state", () => {
  test("rewinding a parked run drops the unfired timer so it re-parks fresh", async () => {
    const store = JournalStore.memory();
    let t = 0;
    const kernel = new RealmKernel(store, { idgen: () => "r", clock: () => t });
    // parks at the nap sleep (an unfired timer + a completed 'before' step)
    const parked = await kernel.run(napUrl, null, { name: "nap" });
    expect(parked.status).toBe("waiting-timer");
    expect(
      store.db.query("SELECT count(*) AS c FROM timers WHERE run_id='r' AND fired=0").get(),
    ).toEqual({ c: 1 });

    // rewind to the 'before' step → the unfired timer is cleared
    t = 5; // not yet elapsed for a fresh timer
    const rewound = await kernel.rewind("r", "before");
    expect(rewound.status).toBe("waiting-timer"); // re-parked fresh
    // exactly one timer again (the freshly re-created one), still unfired
    expect(
      store.db.query("SELECT count(*) AS c FROM timers WHERE run_id='r' AND fired=0").get(),
    ).toEqual({ c: 1 });
  });
});

describe("fork fencing + state copy", () => {
  test("forking a non-terminal (parked) run is rejected", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, { idgen: () => "r", clock: () => 0 });
    const parked = await kernel.run(napUrl, null, { name: "nap" });
    expect(parked.status).toBe("waiting-timer");
    expect(() => kernel.fork("r")).toThrow(/non-terminal/);
  });

  test("forking a terminal run copies its resolved timer history", async () => {
    const store = JournalStore.memory();
    let t = 0;
    let n = 0;
    const kernel = new RealmKernel(store, { idgen: () => `run-${n++}`, clock: () => t });
    // run the nap to completion (timer fires)
    await kernel.run(napUrl, null, { name: "nap" }); // run-0 parks
    t = 5000;
    await kernel.resume("run-0"); // run-0 finishes; its timer is fired
    expect(store.getRun("run-0")?.status).toBe("finished");

    const forkId = kernel.fork("run-0", { newRunId: "fork-1" });
    // the fork carries the resolved (fired) timer so it replays rather than re-parks
    const t1 = store.db
      .query<{ fired: number }, []>("SELECT fired FROM timers WHERE run_id='fork-1'")
      .get();
    expect(t1?.fired).toBe(1);
    expect(forkId).toBe("fork-1");
  });
});

describe("fork", () => {
  test("fork shares the prefix and diverges independently of the source", async () => {
    const store = JournalStore.memory();
    let n = 0;
    const kernel = new RealmKernel(store, { idgen: () => `run-${n++}` });

    const src = await kernel.run<number>(tripleUrl, null, { name: "triple" });
    const srcId = src.runId;
    expect(src.output).toBe(3);

    // fork at step b → the new run has a, b but not c
    const forkId = kernel.fork(srcId, { atStableKey: "b", newRunId: "fork-1" });
    expect(store.getLatestAttempt(forkId, "a")).not.toBeNull();
    expect(store.getLatestAttempt(forkId, "b")).not.toBeNull();
    expect(store.getLatestAttempt(forkId, "c")).toBeNull();
    expect(store.getRun(forkId)?.parentRunId).toBe(srcId);

    // complete the fork independently; the source is untouched
    const forked = await kernel.rerun<number>(forkId, tripleUrl);
    expect(forked.status).toBe("finished");
    expect(forked.output).toBe(3);
    expect(store.getRun(srcId)?.status).toBe("finished"); // source intact
    expect(store.getLatestAttempt(srcId, "c")).not.toBeNull();
  });
});
