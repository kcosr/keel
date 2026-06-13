// Large fan-out workload on mock: 20 finders, 90 verifiers, 1 synthesizer.
// Runs in seconds, survives a crash at "verifier 90", and re-runs exactly one
// agent on a synthPrompt edit.

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { MockProvider } from "../../src/agents/mock.ts";
import { AgentProviderRegistry } from "../../src/agents/types.ts";
import { JournalStore } from "../../src/journal/store.ts";
import { RealmKernel } from "../../src/kernel/realm/realm-host.ts";

const HERE = new URL(".", import.meta.url).pathname;
const reviewUrl = `${HERE}review.workflow.ts`;

const DOMAINS = [
  "ssh-boundary", "http-core", "http-auth", "priv-bootstrap", "container-exec",
  "runtime-pty", "health", "config-core", "config-targets", "gateway-core",
  "gateway-sockets", "agent-supervision", "utilities",
];
const LENSES = [
  "lens:injection", "lens:authz", "lens:privilege", "lens:fs-safety",
  "lens:concurrency", "lens:resources", "lens:secrets",
];
const FINDER_KEYS = [...DOMAINS.map((d) => `review:${d}`), ...LENSES];

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
}

/** Build a mock that makes the workflow produce `n` unique deduped findings. */
function buildMock(n: number): MockProvider {
  const byFinder = new Map<string, unknown[]>();
  const verifierResponses: Record<string, { outputs: string[] }> = {};
  for (let idx = 0; idx < n; idx++) {
    const f = {
      title: `finding ${idx}`,
      category: "bug",
      severity: idx % 2 ? "high" : "medium",
      file: `src/mod${idx}.rs`,
      line: String(idx + 1),
      description: "d",
      evidence: "e",
      recommendation: "r",
      confidence: "high",
    };
    const fk = FINDER_KEYS[idx % FINDER_KEYS.length] as string;
    if (!byFinder.has(fk)) byFinder.set(fk, []);
    byFinder.get(fk)?.push(f);
    verifierResponses[`verify:${f.file}|${norm(f.title)}`] = {
      outputs: [
        JSON.stringify({ is_real: true, verdict: "confirmed", adjusted_severity: "high", reasoning: "ok" }),
      ],
    };
  }
  const responses: Record<string, { outputs: string[] }> = { ...verifierResponses };
  for (const fk of FINDER_KEYS) {
    responses[fk] = { outputs: [JSON.stringify({ findings: byFinder.get(fk) ?? [] })] };
  }
  responses.synthesize = { outputs: ["## Executive Summary\nAll clear."] };
  return new MockProvider({ responses });
}

function kernel(store: JournalStore, mock: MockProvider, extra: Record<string, unknown> = {}): RealmKernel {
  let id = 0;
  return new RealmKernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => 1,
    rng: () => 0.5,
    agents: new AgentProviderRegistry().register(mock),
    ...extra,
  });
}

describe("review workload port on mock", () => {
  test("runs the full 20/90/1 shape (111 agents) in seconds", async () => {
    const store = JournalStore.memory();
    const handle = await kernel(store, buildMock(90)).run<{
      stats: { raw: number; deduped: number; confirmed: number };
    }>(reviewUrl, { root: "/repo", provider: "mock" }, { name: "review" });

    expect(handle.status).toBe("finished");
    expect(handle.output?.stats).toEqual({ raw: 90, deduped: 90, confirmed: 90 });

    const effectful = store.listJournalRows("run_0").filter((r) => r.effectType === "effectful");
    expect(effectful).toHaveLength(20 + 90 + 1); // finders + verifiers + synth = 111
  }, 30000);

  test("crash at verifier 90 resumes re-running only the in-flight verifier", async () => {
    const store = JournalStore.memory();
    let vCommits = 0;
    const k1 = kernel(store, buildMock(90), {
      fault: (p: string, key: string) => {
        if (p === "before-commit" && key.startsWith("verify:")) {
          vCommits++;
          if (vCommits === 90) throw new Error("CRASH at verifier 90");
        }
      },
    });
    await k1.run(reviewUrl, { root: "/repo", provider: "mock" }, { name: "review" }).catch(() => null);
    expect(store.getRun("run_0")?.status).toBe("running");

    const resumeExec: string[] = [];
    const k2 = kernel(store, buildMock(90), { onStepExecute: (key: string) => resumeExec.push(key) });
    const resumed = await k2.resume<{ stats: { confirmed: number } }>("run_0", reviewUrl);

    expect(resumed.status).toBe("finished");
    expect(resumed.output?.stats.confirmed).toBe(90);
    // on resume: 89 verifiers + all finders + dedupe replayed; exactly one
    // verifier re-executed, then synthesize ran for the first time.
    const reRunVerifiers = resumeExec.filter((k) => k.startsWith("verify:"));
    expect(reRunVerifiers).toHaveLength(1);
    expect(resumeExec).toContain("synthesize");
    expect(resumeExec.filter((k) => k.startsWith("review:") || k.startsWith("lens:"))).toHaveLength(0);
    expect(resumeExec).not.toContain("dedupe");
  }, 30000);

  test("editing synthPrompt re-runs exactly one agent (synthesize)", async () => {
    const store = JournalStore.memory();
    const mock = buildMock(20);
    await kernel(store, mock).run(reviewUrl, { root: "/repo", provider: "mock" }, { name: "review" });

    // Edit the synthPrompt helper's text and rerun against the edited file.
    const editedUrl = `${HERE}review-synthedit.workflow.ts`;
    const src = readFileSync(reviewUrl, "utf8").replace(
      "You are the lead reviewer writing the executive narrative.",
      "You are the lead reviewer writing the FINAL executive narrative.",
    );
    writeFileSync(editedUrl, src);
    try {
      const exec: string[] = [];
      const k2 = kernel(store, mock, { onStepExecute: (key: string) => exec.push(key) });
      const re = await k2.rerun("run_0", editedUrl);
      expect(re.status).toBe("finished");
      // only synthesize re-executed: its prompt (via the edited helper) changed,
      // so its version changed; everything upstream replayed.
      expect(exec).toEqual(["synthesize"]);
    } finally {
      rmSync(editedUrl, { force: true });
    }
  }, 30000);

  test("the orchestration body is <= ~145 lines (line-count acceptance)", () => {
    const src = readFileSync(reviewUrl, "utf8");
    const start = src.indexOf("export default async function review");
    const body = src.slice(start);
    const lines = body.split("\n").filter((l) => l.trim().length > 0).length;
    expect(lines).toBeLessThanOrEqual(145);
  });
});
