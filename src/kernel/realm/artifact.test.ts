// Phase 8: two-tier artifact store — large outputs go content-addressed, round
// trip on replay, dedup by content, and the artifact+journal write is atomic.

import { describe, expect, test } from "bun:test";
import { hashJson, sha256Hex } from "../../hash.ts";
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

describe("two-tier artifact store", () => {
  test(">1KB results are content-addressed; <=1KB stay inline; refcount dedups", async () => {
    const store = JournalStore.memory();
    const handle = await fixed(store).run<number>(
      url("artifact.workflow.ts"),
      { size: 5000 },
      { name: "a" },
    );
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe(5000 + 5000 + 4);

    const big = store.getJournalRow("run_0", "big", 1);
    const echo = store.getJournalRow("run_0", "echo", 1);
    const small = store.getJournalRow("run_0", "small", 1);

    // big/echo are artifact-backed; small is inline
    expect(big?.resultArtifact).not.toBeNull();
    expect(big?.resultInline).toBeNull();
    expect(small?.resultArtifact).toBeNull();
    expect(small?.resultInline).not.toBeNull();

    // identical content → same artifact hash → refcount 2 (dedup)
    expect(echo?.resultArtifact).toBe(big?.resultArtifact as string);
    const art = store.getArtifact(big?.resultArtifact as string);
    expect(art?.refCount).toBe(2);
    // the hash is the content hash of the JSON
    expect(big?.resultArtifact).toBe(
      sha256Hex(JSON.stringify({ blob: "x".repeat(5000), len: 5000 })),
    );
  });

  test("artifact-backed results round-trip on replay (resume)", async () => {
    const store = JournalStore.memory();
    // abort after the big step via a fault on `small`, then resume — big must
    // replay from its artifact.
    const exec: string[] = [];
    const k1 = fixed(store, {
      onStepExecute: (k: string) => exec.push(k),
      fault: (p: string, k: string) => {
        if (p === "before-commit" && k === "small") throw new Error("CRASH");
      },
    });
    await k1.run(url("artifact.workflow.ts"), { size: 4000 }, { name: "a" }).catch(() => null);
    expect(exec).toContain("big");
    exec.length = 0;

    const k2 = fixed(store, { onStepExecute: (k: string) => exec.push(k) });
    const resumed = await k2.resume<number>("run_0", url("artifact.workflow.ts"));
    expect(resumed.output).toBe(4000 + 4000 + 4);
    // big and echo replayed from artifacts (not re-executed); only small ran
    expect(exec).not.toContain("big");
    expect(exec).not.toContain("echo");
    expect(exec).toContain("small");
  });

  test("crash before commit leaves NEITHER artifact nor completed row (atomic)", async () => {
    const store = JournalStore.memory();
    const k1 = fixed(store, {
      fault: (p: string, k: string) => {
        if (p === "before-commit" && k === "big") throw new Error("CRASH");
      },
    });
    await k1.run(url("artifact.workflow.ts"), { size: 6000 }, { name: "a" }).catch(() => null);
    // big is pending (not completed), and no artifact was committed
    const big = store.getJournalRow("run_0", "big", 1);
    expect(big?.status).toBe("pending");
    expect(big?.resultArtifact).toBeNull();
    const expectedHash = sha256Hex(JSON.stringify({ blob: "x".repeat(6000), len: 6000 }));
    expect(store.getArtifact(expectedHash)).toBeNull(); // no dangling artifact

    // resume completes; now both exist
    const resumed = await fixed(store).resume<number>("run_0", url("artifact.workflow.ts"));
    expect(resumed.status).toBe("finished");
    expect(store.getArtifact(expectedHash)).not.toBeNull();
  });
});

describe("inline hashing is unaffected", () => {
  test("hashJson still hashes values (small inputs)", () => {
    expect(hashJson({ a: 1 })).toBe(hashJson({ a: 1 }));
  });
});
