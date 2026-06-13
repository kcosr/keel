// Regression tests for review findings: helper-closure versioning (#1), resume
// uses immutable snapshots (#2), rerun persists override input + clears stale
// result (#3).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("#2 resume uses immutable workflow snapshots", () => {
  test("resuming a non-terminal run ignores a caller-supplied mutable workflow path", async () => {
    const store = JournalStore.memory();
    // start a run and abort it (leave non-terminal) using the clean fixture
    const k1 = fixed(store, {
      fault: (p: string, key: string) => {
        if (p === "after-pending" && key === "compute") throw new Error("CRASH");
      },
    });
    await k1.run(url("helper-v1.workflow.ts"), { n: 1 }, { name: "h" }).catch(() => null);
    expect(store.getRun("run_0")?.status).toBe("running");

    // The supplied path is ignored for snapshotted runs; resume uses the stored
    // immutable definition hash from launch.
    const resumed = await fixed(store).resume<number>("run_0", url("forbidden-import.workflow.ts"));
    expect(resumed.status).toBe("finished");
    expect(resumed.output).toBe(2);
  });

  test("resume succeeds after the original workflow file is deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-"));
    try {
      const workflow = join(dir, "snapshot.workflow.ts");
      const cacheRoot = join(dir, "definitions");
      writeFileSync(
        workflow,
        `
          export default async function wf(ctx, input) {
            const Schema = { parse: (v) => v };
            return ctx.step("compute", Schema, { n: input.n }, ({ n }) => n * 2);
          }
        `,
      );

      const store = JournalStore.memory();
      const k1 = fixed(store, {
        definitionCacheRoot: cacheRoot,
        fault: (p: string, key: string) => {
          if (p === "after-pending" && key === "compute") throw new Error("CRASH");
        },
      });
      await k1.run(workflow, { n: 7 }, { name: "snapshot" }).catch(() => null);
      expect(store.getRun("run_0")?.status).toBe("running");
      expect(store.getRun("run_0")?.definitionVersion.startsWith("wf_sha256_")).toBe(true);

      rmSync(workflow);

      const resumed = await fixed(store, { definitionCacheRoot: cacheRoot }).resume<number>(
        "run_0",
        workflow,
      );
      expect(resumed.status).toBe("finished");
      expect(resumed.output).toBe(14);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
