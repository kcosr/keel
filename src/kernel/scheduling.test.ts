// Phase 16: durable ctx.sleep (park/wake), supervisor wake after restart, cron.

import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { snapshotWorkflowSource } from "../workflow-definitions/snapshot.ts";
import { RealmKernel } from "./realm/realm-host.ts";
import { Supervisor } from "./supervisor.ts";

const napUrl = captureWorkflowFile(
  new URL("./realm/fixtures/nap.workflow.ts", import.meta.url).pathname,
);
const chainUrl = captureWorkflowFile(
  new URL("./realm/fixtures/chain.workflow.ts", import.meta.url).pathname,
);

describe("durable ctx.sleep park/wake", () => {
  test("a run parks at sleep and a supervisor tick wakes it to finish", async () => {
    const store = JournalStore.memory();
    let t = 0;
    const clock = () => t;
    const kernel = new RealmKernel(store, { idgen: () => "r", clock });

    const handle = await kernel.run<number>(napUrl, null, { name: "nap" });
    expect(handle.status).toBe("waiting-timer"); // parked at sleep
    expect(store.getJournalRow("r", "before", 1)?.status).toBe("completed");
    expect(store.getJournalRow("r", "after", 1)).toBeNull(); // not reached yet

    // not due yet → supervisor does nothing
    t = 500;
    expect((await new Supervisor({ store, kernel, clock }).tick()).woken).toEqual([]);
    expect(store.getRun("r")?.status).toBe("waiting-timer");

    // timer due → supervisor wakes it; the run finishes
    t = 1500;
    const res = await new Supervisor({ store, kernel, clock }).tick();
    expect(res.woken).toEqual(["r"]);
    expect(store.getRun("r")?.status).toBe("finished");
    expect(JSON.parse(store.getRun("r")?.outputRef ?? "null")).toBe(2);
  });

  test("a due timer fires after a 'daemon restart' (fresh kernel + supervisor)", async () => {
    const store = JournalStore.memory();
    let t = 0;
    const clock = () => t;
    // park with one kernel…
    await new RealmKernel(store, { idgen: () => "r2", clock }).run(napUrl, null, { name: "nap" });
    expect(store.getRun("r2")?.status).toBe("waiting-timer");

    // …a brand-new kernel + supervisor (simulating restart) reads the journaled
    // timer and wakes it. Nothing in memory carried over.
    t = 2000;
    const fresh = new RealmKernel(store, { idgen: () => "r2", clock });
    const res = await new Supervisor({ store, kernel: fresh, clock }).tick();
    expect(res.woken).toEqual(["r2"]);
    expect(store.getRun("r2")?.status).toBe("finished");
  });
});

describe("cron schedules", () => {
  test("a due schedule launches a run and advances to the next slot", async () => {
    const store = JournalStore.memory();
    const t = 1000;
    let n = 0;
    const kernel = new RealmKernel(store, { idgen: () => `cron-${n++}`, clock: () => t });
    const { snapshot } = snapshotWorkflowSource(store, chainUrl.source, {
      name: "hourly",
      nowMs: t,
    });
    store.putSchedule({
      name: "hourly",
      workflowRef: snapshot.hash,
      inputJson: JSON.stringify({ n: 2 }),
      intervalMs: 3_600_000,
      nextFireMs: 500, // already due at t=1000
    });

    const res = await new Supervisor({
      store,
      kernel,
      clock: () => t,
      claim: (runId) => store.claimRun(runId, "daemon-A", 0, t),
    }).tick();
    expect(res.fired).toEqual(["hourly"]);
    const run = store.listRuns().find((r) => r.workflowName === "hourly");
    expect(run?.runtimeOwnerId).toBe("daemon-A");
    expect(run?.heartbeatAtMs).toBe(t);
    // advanced ~one interval forward, so not due again immediately
    const after = await new Supervisor({ store, kernel, clock: () => t }).tick();
    expect(after.fired).toEqual([]);
  });
});
