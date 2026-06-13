// Phase 17: human-in-the-loop (ctx.human) and external signals (ctx.signal),
// both built on the durable park/wake machinery.

import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { buildProjection, getBlockage } from "../rpc/projection.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm/realm-host.ts";

const gateUrl = captureWorkflowFile(
  new URL("./realm/fixtures/gate.workflow.ts", import.meta.url).pathname,
);
const sigUrl = captureWorkflowFile(
  new URL("./realm/fixtures/await-signal.workflow.ts", import.meta.url).pathname,
);

describe("ctx.human approval gate", () => {
  test("parks at ctx.human; a delivered decision resumes it with the decision", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, { idgen: () => "r" });

    const handle = await kernel.run<string>(gateUrl, null, { name: "gate" });
    expect(handle.status).toBe("waiting-human");
    expect(store.getJournalRow("r", "prepare", 1)?.status).toBe("completed");
    const appr = store.getApproval("r", "approve-deploy");
    expect(appr?.status).toBe("pending");
    // §17: the human-facing prompt is persisted, so a UI can render the ask
    expect(appr?.prompt).toBe("Deploy to prod?");
    expect(buildProjection(store, "r")).toBeDefined();
    expect(getBlockage(store, "r", 1).context).toContain("Deploy to prod?");

    // deliver the decision out-of-band, then resume (the daemon does both)
    store.decideApproval("r", "approve-deploy", { status: "approved", note: "lgtm" }, 1);
    const resumed = await kernel.resume<string>("r");
    expect(resumed.status).toBe("finished");
    expect(resumed.output).toBe("deploy:approved");
  });

  test("a denied decision flows through too, after a 'restart'", async () => {
    const store = JournalStore.memory();
    await new RealmKernel(store, { idgen: () => "r2" }).run(gateUrl, null, { name: "gate" });
    expect(store.getRun("r2")?.status).toBe("waiting-human");

    store.decideApproval("r2", "approve-deploy", { status: "denied" }, 1);
    // a brand-new kernel (restart) resumes from the journal
    const resumed = await new RealmKernel(store, { idgen: () => "r2" }).resume<string>("r2");
    expect(resumed.output).toBe("deploy:denied");
  });
});

describe("ctx.signal", () => {
  test("parks until a named signal arrives, then returns its payload", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, { idgen: () => "s" });

    const handle = await kernel.run<{ go: boolean; by: string }>(sigUrl, null, { name: "sig" });
    expect(handle.status).toBe("waiting-signal");

    // a non-matching signal does not wake it
    store.putSignal("s", "other", { x: 1 }, 1);
    expect((await kernel.resume<unknown>("s")).status).toBe("waiting-signal");

    // the matching signal delivers its payload
    store.putSignal("s", "proceed", { go: true, by: "alice" }, 2);
    const resumed = await kernel.resume<{ go: boolean; by: string }>("s");
    expect(resumed.status).toBe("finished");
    expect(resumed.output).toEqual({ go: true, by: "alice" });
  });
});
