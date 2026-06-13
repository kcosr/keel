// Regression tests for review findings: helper-closure versioning (#1), resume
// lints (#2), rerun persists override input + clears stale result (#3).

import { describe, expect, test } from "bun:test";
import { JournalStore } from "../../journal/store.ts";
import { RealmKernel } from "./realm-host.ts";

const FIX = new URL("./fixtures/", import.meta.url);
const url = (f: string) => new URL(f, FIX).pathname;

function fixed(store: JournalStore, extra: Record<string, unknown> = {}): RealmKernel {
  let id = 0;
  return new RealmKernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => 1,
    rng: () => 0.5,
    ...extra,
  });
}

describe("#1 helper-closure versioning", () => {
  test("editing a module helper re-executes the step that calls it", async () => {
    const store = JournalStore.memory();
    const exec: string[] = [];
    const k = fixed(store, { onStepExecute: (key: string) => exec.push(key) });

    const first = await k.run<number>(url("helper-v1.workflow.ts"), { n: 5 }, { name: "h" });
    expect(first.output).toBe(10); // 5 * 2
    expect(exec).toEqual(["compute"]);
    exec.length = 0;

    // Same fn body, but the `transform` helper changed (×2 → ×3).
    const second = await k.rerun<number>("run_0", url("helper-v2.workflow.ts"));
    expect(second.output).toBe(15); // 5 * 3 — the step RE-EXECUTED
    expect(exec).toEqual(["compute"]);
  });
});

describe("#2 resume runs the determinism lint", () => {
  test("resuming a non-terminal run with a forbidden-import workflow is rejected", async () => {
    const store = JournalStore.memory();
    // start a run and abort it (leave non-terminal) using the clean fixture
    const k1 = fixed(store, {
      fault: (p: string, key: string) => {
        if (p === "after-pending" && key === "compute") throw new Error("CRASH");
      },
    });
    await k1.run(url("helper-v1.workflow.ts"), { n: 1 }, { name: "h" }).catch(() => null);
    expect(store.getRun("run_0")?.status).toBe("running");

    // resume against a workflow with a forbidden import → lint must reject
    await expect(fixed(store).resume("run_0", url("forbidden-import.workflow.ts"))).rejects.toThrow(
      /determinism lint/,
    );
  });
});

describe("#3 rerun persists override input and clears stale result", () => {
  test("an override input is persisted; a later input-less rerun uses it", async () => {
    const store = JournalStore.memory();
    const k = fixed(store);
    await k.run<number>(url("helper-v1.workflow.ts"), { n: 5 }, { name: "h" });
    expect(JSON.parse(store.getRun("run_0")?.inputRef ?? "null")).toEqual({ n: 5 });

    // rerun with an override input
    const r1 = await k.rerun<number>("run_0", url("helper-v1.workflow.ts"), { n: 9 });
    expect(r1.output).toBe(18);
    expect(JSON.parse(store.getRun("run_0")?.inputRef ?? "null")).toEqual({ n: 9 });

    // a later input-less rerun uses the persisted (n:9) input, not the original (n:5)
    const r2 = await k.rerun<number>("run_0", url("helper-v1.workflow.ts"));
    expect(r2.output).toBe(18);
  });
});
