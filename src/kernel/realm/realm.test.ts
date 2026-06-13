// Phase 4 — the deterministic realm. Proves: forbidden globals throw guidance;
// memoization/resume/crash hold inside the realm; tagged-envelope edges survive
// the JSON boundary; a throughput number is recorded.

import { beforeEach, describe, expect, test } from "bun:test";
import { hashJson } from "../../hash.ts";
import { JournalStore } from "../../journal/store.ts";
import { RealmKernel } from "./realm-host.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const chainUrl = new URL("chain.workflow.ts", FIXTURES).pathname;
const edgesUrl = new URL("edges.workflow.ts", FIXTURES).pathname;
const ambientUrl = new URL("ambient.workflow.ts", FIXTURES).pathname;
const forbiddenUrl = new URL("forbidden.workflow.ts", FIXTURES).pathname;

function fixed(store: JournalStore, extra: Record<string, unknown> = {}): RealmKernel {
  let id = 0;
  let t = 1000;
  let seed = 7;
  return new RealmKernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => t++,
    rng: () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    },
    ...extra,
  });
}

describe("realm — forbidden ambient globals throw guidance", () => {
  let store: JournalStore;
  beforeEach(() => {
    store = JournalStore.memory();
  });

  const cases: [string, RegExp][] = [
    ["math-random", /Math\.random\(\) is not allowed/],
    ["date-now", /Date\.now\(\) is not allowed/],
    ["new-date", /new Date\(\) is not allowed/],
    ["fetch", /fetch\(\) is not allowed/],
  ];
  for (const [what, re] of cases) {
    test(`${what} is unreachable inside the realm (runtime layer)`, async () => {
      // lint:false so the call reaches the worker and the RUNTIME shim throws
      // (the static lint catching these is covered separately in Phase 5).
      const kernel = fixed(store, { lint: false });
      await expect(kernel.run(forbiddenUrl, { what }, { name: "forbidden" })).rejects.toThrow(re);
      // and the run is recorded as failed
      expect(store.getRun("run_0")?.status).toBe("failed");
    });
  }

  test("ctx.now()/ctx.random() are the only sources and are journaled", async () => {
    const kernel = fixed(store);
    const handle = await kernel.run<{ t: number; r: number }>(ambientUrl, null, {
      name: "ambient",
    });
    expect(handle.status).toBe("finished");
    const rows = store.listJournalRows("run_0");
    const ambientKeys = rows.filter((r) => r.effectType === "ambient").map((r) => r.stableKey);
    expect(ambientKeys).toEqual(["__now#0", "__random#0"]);
    // output values are exactly the journaled ambient values (replayable)
    const nowRow = store.getJournalRow("run_0", "__now#0", 1);
    const randRow = store.getJournalRow("run_0", "__random#0", 1);
    expect(handle.output?.t).toBe(JSON.parse(nowRow?.resultInline ?? "null"));
    expect(handle.output?.r).toBe(JSON.parse(randRow?.resultInline ?? "null"));
  });
});

describe("realm — memoization and resume", () => {
  test("a chain runs to completion in the realm", async () => {
    const store = JournalStore.memory();
    const kernel = fixed(store);
    const handle = await kernel.run<number>(chainUrl, { n: 5 }, { name: "chain" });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe(5);
    const completed = store.listJournalRows("run_0").filter((r) => r.status === "completed");
    expect(completed).toHaveLength(5);
  });
});

describe("realm — crash consistency (write-ahead through the realm)", () => {
  test("a fault before-commit leaves pending; resume re-executes only that step", async () => {
    const store = JournalStore.memory();
    const exec = new Map<string, number>();
    const tick = (k: string) => exec.set(k, (exec.get(k) ?? 0) + 1);

    // Run with a host fault that throws just before committing s1.
    const crashing = fixed(store, {
      onStepExecute: tick,
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "s1") throw new Error("INJECTED CRASH");
      },
    });
    await crashing.run(chainUrl, { n: 4 }, { name: "chain" }).catch(() => null);
    expect(store.getRun("run_0")?.status).toBe("running"); // resumable

    // Resume with no fault.
    const healthy = fixed(store, { onStepExecute: tick });
    const handle = await healthy.resume<number>("run_0", chainUrl);
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe(4);

    // s1 executed twice (at-least-once); every other step exactly once.
    expect(exec.get("s0")).toBe(1);
    expect(exec.get("s1")).toBe(2);
    expect(exec.get("s2")).toBe(1);
    expect(exec.get("s3")).toBe(1);
    // no dangling pending rows
    expect(store.listJournalRows("run_0").filter((r) => r.status === "pending")).toHaveLength(0);
  });
});

describe("realm — tagged-envelope edge detection across the JSON boundary", () => {
  test("step b's inputDeps records the edge from step a", async () => {
    const store = JournalStore.memory();
    const kernel = fixed(store);
    await kernel.run<number>(edgesUrl, null, { name: "edges" });
    const b = store.getJournalRow("run_0", "b", 1);
    expect(b?.inputDeps).not.toBeNull();
    expect(b?.inputDeps).toEqual([{ stepKey: "a", contentHash: hashJson({ items: [1, 2, 3] }) }]);
  });
});

describe("realm — throughput benchmark (recorded, not gated)", () => {
  test("records steps/sec for a many-step chain", async () => {
    const store = JournalStore.memory();
    const kernel = fixed(store);
    const N = 300;
    const startNs = Bun.nanoseconds();
    const handle = await kernel.run<number>(chainUrl, { n: N }, { name: "bench" });
    const elapsedSec = (Bun.nanoseconds() - startNs) / 1e9;
    const perSec = N / elapsedSec;
    // Recorded to CI logs (the AST-rewrite fast path is cut; this is informational).
    console.log(
      `[realm bench] ${N} steps in ${elapsedSec.toFixed(3)}s = ${perSec.toFixed(0)} steps/sec`,
    );
    expect(handle.output).toBe(N);
    expect(perSec).toBeGreaterThan(10); // functioning floor, not a perf gate
  }, 30000);
});
