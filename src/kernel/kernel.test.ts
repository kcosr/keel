import { beforeEach, describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import type { Ctx } from "./ctx.ts";
import { KeelAbort, Kernel, type Workflow } from "./kernel.ts";
import { passthrough } from "./schema.ts";

/** Deterministic kernel: fixed id sequence, monotonic clock, seeded rng. */
function fixedKernel(store: JournalStore): Kernel {
  let id = 0;
  let t = 1000;
  let seed = 1;
  return new Kernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => t++,
    rng: () => {
      // deterministic LCG in [0,1)
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    },
  });
}

const num = passthrough<number>();

describe("Kernel — pure step memoization", () => {
  let store: JournalStore;
  let kernel: Kernel;
  beforeEach(() => {
    store = JournalStore.memory();
    kernel = fixedKernel(store);
  });

  test("a linear pure workflow runs and returns its output", async () => {
    const wf: Workflow<number, number> = async (ctx, n) => {
      const a = await ctx.step("a", num, { n }, ({ n }) => n + 1);
      const b = await ctx.step("b", num, { a }, ({ a }) => a * 2);
      return b;
    };
    const handle = await kernel.run(wf, 5, { name: "lin" });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe(12);
  });

  test("resume replays completed steps without re-executing them", async () => {
    const calls: string[] = [];
    const wf: Workflow<number, number> = async (ctx, n) => {
      const a = await ctx.step("a", num, { n }, ({ n }) => {
        calls.push("a");
        return n + 1;
      });
      const b = await ctx.step("b", num, { a }, ({ a }) => {
        calls.push("b");
        return a * 2;
      });
      return b;
    };
    const first = await kernel.run(wf, 5, { name: "lin" });
    expect(calls).toEqual(["a", "b"]);

    // Resume the (now finished) run: terminal short-circuit, nothing re-executes.
    calls.length = 0;
    const again = await kernel.resume(first.runId, wf);
    expect(again.output).toBe(12);
    expect(calls).toEqual([]);
  });
});

describe("Kernel — abort at every step boundary", () => {
  let store: JournalStore;
  let kernel: Kernel;
  beforeEach(() => {
    store = JournalStore.memory();
    kernel = fixedKernel(store);
  });

  // A 4-step chain; we abort just before step index `abortAt` runs, then resume
  // and assert exactly the not-yet-completed steps re-execute.
  function chain(calls: string[], abortAt: number): Workflow<number, number> {
    const steps = ["s0", "s1", "s2", "s3"];
    return async (ctx, n) => {
      let acc = n;
      for (let i = 0; i < steps.length; i++) {
        const key = steps[i] as string;
        if (i === abortAt) throw new KeelAbort(`before ${key}`);
        acc = await ctx.step(key, num, { acc, i }, ({ acc }) => {
          calls.push(key);
          return acc + 1;
        });
      }
      return acc;
    };
  }

  for (let boundary = 1; boundary <= 3; boundary++) {
    test(`abort before s${boundary}, resume re-runs only s${boundary}..s3`, async () => {
      const calls: string[] = [];
      const handle = await kernel.run(chain(calls, boundary), 0, { name: "chain" }).catch((e) => {
        expect(e).toBeInstanceOf(KeelAbort);
        return null;
      });
      expect(handle).toBeNull();
      // steps before the boundary completed and journaled
      expect(calls).toEqual(["s0", "s1", "s2", "s3"].slice(0, boundary));

      // Resume with a non-aborting body: completed steps replay, the rest run.
      const resumeCalls: string[] = [];
      const finished = await kernel.resume("run_0", chain(resumeCalls, -1));
      expect(finished.status).toBe("finished");
      expect(finished.output).toBe(4);
      // only the steps from the boundary onward re-execute
      expect(resumeCalls).toEqual(["s0", "s1", "s2", "s3"].slice(boundary));
    });
  }
});

describe("Kernel — ambient determinism", () => {
  let store: JournalStore;
  beforeEach(() => {
    store = JournalStore.memory();
  });

  test("now()/random() are recorded once and replayed verbatim on resume", async () => {
    const seen: { now: number[]; rand: number[] } = { now: [], rand: [] };
    const prefix = (ctx: Ctx): { t: number; r: number } => {
      const t = ctx.now();
      const r = ctx.random();
      seen.now.push(t);
      seen.rand.push(r);
      return { t, r };
    };
    // First run records the ambient values, then aborts before finishing.
    const aborting: Workflow<null, never> = async (ctx) => {
      prefix(ctx);
      throw new KeelAbort();
    };
    // Resume re-runs the body; the ambient calls must replay the recorded values.
    const finishing: Workflow<null, { t: number; r: number }> = async (ctx) => {
      const v = prefix(ctx);
      await ctx.step("noop", passthrough(), { t: v.t }, () => 1);
      return v;
    };

    const kernel = fixedKernel(store);
    await kernel
      .run(aborting, null, { name: "amb" })
      .catch((e) => expect(e).toBeInstanceOf(KeelAbort));
    const resumed = await kernel.resume("run_0", finishing);

    expect(seen.now).toHaveLength(2);
    expect(seen.now[0]).toBe(seen.now[1] as number);
    expect(seen.rand[0]).toBe(seen.rand[1] as number);
    expect(resumed.output).toEqual({ t: seen.now[0] as number, r: seen.rand[0] as number });
  });
});

describe("Kernel — identical ctx.* sequence across N re-runs (property)", () => {
  test("a deterministic body journals the same key sequence every run", async () => {
    const wf: Workflow<number, number> = async (ctx, n) => {
      ctx.now();
      const xs = [1, 2, 3];
      let acc = n;
      for (const x of xs) {
        acc = await ctx.step(
          ctx.stepKey("add", String(x)),
          num,
          { acc, x },
          ({ acc, x }) => acc + x,
        );
      }
      ctx.random();
      return acc;
    };

    const sequences: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const store = JournalStore.memory();
      const kernel = fixedKernel(store);
      const handle = await kernel.run(wf, 10, { name: "seq" });
      expect(handle.output).toBe(16);
      const seq = store.listJournalRows(handle.runId).map((r) => `${r.effectType}:${r.stableKey}`);
      sequences.push(seq);
    }
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toEqual(sequences[0] as string[]);
    }
  });
});
