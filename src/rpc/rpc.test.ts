// Phase 11: the RPC contract + canonical RunProjection. A workflow driven through
// the RPC layer yields the same result as direct kernel use; the projection is
// golden-locked; events stream through subscribeEvents.

import { describe, expect, test } from "bun:test";
import { MockProvider } from "../agents/mock.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { JournalStore } from "../journal/store.ts";
import { RealmKernel } from "../kernel/realm/realm-host.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { InProcessKeel } from "./in-process.ts";

const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const reviewUrl = captureWorkflowFile(new URL("agent-review.workflow.ts", FIX).pathname);
const chainUrl = captureWorkflowFile(new URL("chain.workflow.ts", FIX).pathname);
const flakyUrl = captureWorkflowFile(new URL("flaky.workflow.ts", FIX).pathname);

function keel(store: JournalStore, mock?: MockProvider): InProcessKeel {
  let id = 0;
  const kernel = new RealmKernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => 1,
    rng: () => 0.5,
    ...(mock ? { agents: new AgentProviderRegistry().register(mock) } : {}),
  });
  return new InProcessKeel(kernel, store);
}

describe("RPC contract drives a workflow end-to-end", () => {
  test("launchRun → waitForRun → getRun returns the canonical projection", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: {
        "review:auth": { outputs: ['{"findings":[{"title":"a"}]}'] },
        "review:net": { outputs: ['{"findings":[{"title":"b"},{"title":"c"}]}'] },
      },
    });
    const api = keel(store, mock);

    const { runId } = await api.launchRun({
      ...reviewUrl,
      input: { domains: ["auth", "net"] },
      name: "review",
    });
    const outcome = await api.waitForRun(runId);
    expect(outcome.status).toBe("finished");

    const projection = api.getRun(runId);
    expect(projection?.status).toBe("finished");
    expect(projection?.workflowName).toBe("review");
    expect(projection?.phase).toBe("Review");
    expect(projection?.stats).toEqual({ steps: 1, agents: 2, artifacts: 0 });
    // nodes: one pure (count) + two effectful (review:auth, review:net)
    expect(projection?.nodes.map((n) => n.stableKey)).toEqual([
      "count",
      "review:auth",
      "review:net",
    ]);
    expect(projection?.nodes.every((n) => n.status === "completed")).toBe(true);
  });

  test("listRuns summarizes every run", async () => {
    const store = JournalStore.memory();
    const api = keel(store);
    await api.launchRun({ ...chainUrl, input: { n: 3 }, name: "c1" });
    await api.launchRun({ ...chainUrl, input: { n: 2 }, name: "c2" });
    await api.waitForRun("run_0");
    await api.waitForRun("run_1");
    const runs = api.listRuns();
    expect(runs.map((r) => r.workflowName).sort()).toEqual(["c1", "c2"]);
    expect(runs.every((r) => r.status === "finished")).toBe(true);
  });
});

describe("projection is golden-locked", () => {
  test("a chain run produces the exact expected projection", async () => {
    const store = JournalStore.memory();
    const api = keel(store);
    await api.launchRun({ ...chainUrl, input: { n: 3 }, name: "chain" });
    await api.waitForRun("run_0");
    const p = api.getRun("run_0");
    const definitionVersion = p?.definitionVersion ?? "";
    expect(definitionVersion.startsWith("wf_sha256_")).toBe(true);
    expect(p).toEqual({
      runId: "run_0",
      workflowName: "chain",
      status: "finished",
      definitionVersion,
      parentRunId: null,
      phase: null,
      error: null,
      nodes: [
        {
          stableKey: "s0",
          effectType: "pure",
          status: "completed",
          attempt: 1,
          dependsOn: [],
          artifactBacked: false,
        },
        {
          stableKey: "s1",
          effectType: "pure",
          status: "completed",
          attempt: 1,
          dependsOn: [],
          artifactBacked: false,
        },
        {
          stableKey: "s2",
          effectType: "pure",
          status: "completed",
          attempt: 1,
          dependsOn: [],
          artifactBacked: false,
        },
      ],
      stats: { steps: 3, agents: 0, artifacts: 0 },
    });
  });
});

describe("event subscription", () => {
  test("subscribeEvents streams a run's events", async () => {
    const store = JournalStore.memory();
    const api = keel(store);
    const seen: { type: string; payload: unknown }[] = [];
    const { runId } = await api.launchRun({
      ...chainUrl,
      input: { n: 2 },
      name: "chain",
    });
    const unsub = api.subscribeEvents(runId, 0, (e) =>
      seen.push({ type: e.type, payload: e.payload }),
    );
    await api.waitForRun(runId);
    // give the poller a tick to drain
    await new Promise((r) => setTimeout(r, 60));
    unsub();
    expect(seen.map((e) => e.type)).toContain("run.started");
    expect(seen.map((e) => e.type)).toContain("run.finished");
    expect(seen.filter((e) => e.type === "step.completed").length).toBe(2);
    expect(seen.find((e) => e.type === "run.finished")?.payload).toEqual({ output: 2 });
  });
});

describe("lifecycle start methods", () => {
  test("retryRun starts work and waitForRun observes the terminal outcome", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: {
        flaky: { outputs: ['{"ok":true}'], throwOnce: true },
      },
    });
    const api = keel(store, mock);

    const { runId } = await api.launchRun({ ...flakyUrl, input: null, name: "flaky" });
    expect((await api.waitForRun(runId)).status).toBe("failed");

    const started = await api.retryRun(runId);
    expect(started).toEqual({ runId, status: "running" });
    expect(await api.waitForRun(runId)).toMatchObject({
      runId,
      status: "finished",
      output: "done:true",
    });
  });

  test("retryRun precondition errors reject without fake failed outcome", async () => {
    const store = JournalStore.memory();
    const api = keel(store);
    const { runId } = await api.launchRun({ ...chainUrl, input: { n: 2 }, name: "ok" });
    expect((await api.waitForRun(runId)).status).toBe("finished");

    await expect(api.retryRun(runId)).rejects.toThrow("retry needs a failed run (is finished)");
    expect(api.getRun(runId)?.status).toBe("finished");
    expect((await api.waitForRun(runId)).status).toBe("finished");
  });

  test("rewindRun to an unknown step rejects without starting work", async () => {
    const store = JournalStore.memory();
    const api = keel(store);
    const { runId } = await api.launchRun({ ...chainUrl, input: { n: 2 }, name: "ok" });
    expect((await api.waitForRun(runId)).status).toBe("finished");

    await expect(api.rewindRun(runId, "missing")).rejects.toThrow(
      'cannot rewind to unknown step "missing"',
    );
    expect(api.getRun(runId)?.status).toBe("finished");
  });
});
