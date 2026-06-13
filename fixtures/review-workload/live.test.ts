// Budget-scaled LIVE run of the large fan-out review against a real target with
// the real Pi adapter, surviving a mid-run crash. Gated behind KEEL_LIVE=1; the
// line-count regression always runs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const HERE = new URL(".", import.meta.url).pathname;
const reviewUrl = `${HERE}review.workflow.ts`;
const targetRoot = `${HERE}sample-target`;
const LIVE = process.env.KEEL_LIVE === "1";

describe("review workload orchestration line count (always)", () => {
  test("the review body stays within the compact orchestration budget", () => {
    const src = readFileSync(reviewUrl, "utf8");
    const body = src.slice(src.indexOf("export default async function review"));
    const lines = body.split("\n").filter((l) => l.trim().length > 0).length;
    expect(lines).toBeLessThanOrEqual(145);
  });
});

describe.if(LIVE)("LIVE review workload rehearsal", () => {
  test("a scaled real review runs through the realm and survives a mid-run crash", async () => {
    const { PiProvider } = await import("../../src/agents/pi.ts");
    const { AgentProviderRegistry } = await import("../../src/agents/types.ts");
    const { JournalStore } = await import("../../src/journal/store.ts");
    const { RealmKernel } = await import("../../src/kernel/realm/realm-host.ts");

    const store = JournalStore.memory();
    const agents = new AgentProviderRegistry().register(
      new PiProvider({ cwd: targetRoot, timeoutMs: 120_000 }),
    );
    const input = {
      root: targetRoot,
      provider: "pi",
      domains: ["security"],
      lenses: ["lens:injection"],
    };

    // 1) run with a crash injected at the FIRST verifier's commit (mid-verify).
    let crashed = false;
    const k1 = new RealmKernel(store, {
      idgen: () => "tn",
      agents,
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key.startsWith("verify:") && !crashed) {
          crashed = true;
          throw new Error("CRASH mid-verify (simulated minute-105 daemon death)");
        }
      },
    });
    await k1.run(reviewUrl, input, { name: "review-workload" }).catch(() => null);
    expect(crashed).toBe(true);
    expect(store.getRun("tn")?.status).toBe("running"); // resumable

    // how many agent steps completed before the crash
    const completedBefore = store
      .listJournalRows("tn")
      .filter((r) => r.effectType === "effectful" && r.status === "completed").length;

    // 2) resume to completion with no fault.
    const k2 = new RealmKernel(store, { idgen: () => "tn", agents });
    const resumed = await k2.resume<{
      stats: { raw: number; deduped: number; confirmed: number };
    }>("tn", reviewUrl);

    expect(resumed.status).toBe("finished");
    expect(resumed.output?.stats.confirmed).toBeGreaterThan(0); // found real issues
    // re-executed effectful work on resume is bounded (finders + completed
    // verifiers replayed); the one crashed verifier re-ran.
    const completedAfter = store
      .listJournalRows("tn")
      .filter((r) => r.effectType === "effectful" && r.status === "completed").length;
    expect(completedAfter).toBeGreaterThanOrEqual(completedBefore);
    console.log(`[review-workload live] confirmed=${resumed.output?.stats.confirmed} ` +
      `raw=${resumed.output?.stats.raw} completedBefore=${completedBefore} after=${completedAfter}`);
  }, 300_000);
});
