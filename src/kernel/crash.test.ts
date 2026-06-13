// Phase 3 driver: spawn the crash harness as a real child process, SIGKILL it at
// every write-ahead boundary, resume in a fresh process, and assert the
// crash-consistency matrix (§5.5, §16).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore } from "../journal/store.ts";

const HARNESS = join(import.meta.dir, "crash-harness.ts");
const N = 4;

interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

async function runHarness(env: Record<string, string>): Promise<SpawnResult> {
  const proc = Bun.spawn([process.execPath, HARNESS], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, signal: proc.signalCode, stdout, stderr };
}

function counts(logPath: string): Map<string, number> {
  const m = new Map<string, number>();
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    // no executions logged yet
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    m.set(line, (m.get(line) ?? 0) + 1);
  }
  return m;
}

describe("Phase 3 — write-ahead crash matrix (real kill -9)", () => {
  const points = ["after-pending", "before-commit"] as const;

  for (const point of points) {
    for (let idx = 0; idx < N; idx++) {
      const killKey = `s${idx}`;
      test(`SIGKILL at ${point}:${killKey} → resume completes; exactly-once / at-least-once`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "keel-crash-"));
        const dbPath = join(dir, "keel.db");
        const logPath = join(dir, "exec.log");
        const runId = "run_crash";
        const base = {
          KEEL_DB: dbPath,
          KEEL_LOG: logPath,
          KEEL_RUN_ID: runId,
          KEEL_N: String(N),
        };
        try {
          // 1) Run, self-killed at the boundary.
          const killed = await runHarness({
            ...base,
            KEEL_PHASE: "run",
            KEEL_KILL: `${point}:${killKey}`,
          });
          expect(killed.signal).toBe("SIGKILL");
          expect(killed.stdout).toBe(""); // never reached the clean print

          // 2) Resume in a fresh process, no kill.
          const resumed = await runHarness({
            ...base,
            KEEL_PHASE: "resume",
            KEEL_KILL: "",
          });
          expect(resumed.exitCode).toBe(0);
          expect(JSON.parse(resumed.stdout.trim())).toEqual({
            status: "finished",
            output: N,
          });

          // 3) Execution-count matrix.
          const c = counts(logPath);
          for (let i = 0; i < N; i++) {
            const key = `s${i}`;
            const got = c.get(key) ?? 0;
            if (point === "before-commit" && i === idx) {
              // fn ran pre-kill (pending), re-ran on resume → at-least-once (twice)
              expect(got).toBe(2);
            } else {
              // every other step executed exactly once across both processes
              expect(got).toBe(1);
            }
          }

          // 4) No corrupt/dangling journal state: every step has exactly one
          //    completed row and no leftover pending rows.
          const store = JournalStore.open(dbPath);
          try {
            const rows = store.listJournalRows(runId);
            const completed = rows.filter((r) => r.status === "completed");
            const pending = rows.filter((r) => r.status === "pending");
            expect(pending).toHaveLength(0);
            expect(new Set(completed.map((r) => r.stableKey)).size).toBe(N);
            expect(store.getRun(runId)?.status).toBe("finished");
          } finally {
            store.close();
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }, 20000);
    }
  }
});
