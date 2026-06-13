// Crash harness (Phase 3) — a standalone child process the driver test spawns.
//
// It runs (or resumes) a fixed N-step pure workflow against a file-backed
// journal and can SIGKILL ITSELF at a precise write-ahead boundary, exercising
// the real crash-consistency matrix. Each step fn appends its key to a log file
// so the driver can count executions ACROSS process boundaries and assert
// exactly-once replay / at-least-once re-execution.
//
// Env contract:
//   KEEL_DB     journal path
//   KEEL_LOG    exec-log path (one step key per line)
//   KEEL_RUN_ID fixed run id (shared by the run and resume invocations)
//   KEEL_PHASE  "run" | "resume"
//   KEEL_KILL   "" | "<point>:<key>"  e.g. "before-commit:s2"
//   KEEL_N      number of steps

import { appendFileSync } from "node:fs";
import { JournalStore } from "../journal/store.ts";
import type { FaultPoint } from "./ctx.ts";
import { Kernel, type Workflow } from "./kernel.ts";
import { passthrough } from "./schema.ts";

function env(name: string): string {
  const v = process.env[name];
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

const dbPath = env("KEEL_DB");
const logPath = env("KEEL_LOG");
const runId = env("KEEL_RUN_ID");
const phase = env("KEEL_PHASE");
const kill = process.env.KEEL_KILL ?? "";
const n = Number(env("KEEL_N"));

const [killPoint, killKey] = kill ? (kill.split(":") as [FaultPoint, string]) : [null, null];

const num = passthrough<number>();

const workflow: Workflow<null, number> = async (ctx) => {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const key = `s${i}`;
    acc = await ctx.step(key, num, { i }, () => {
      appendFileSync(logPath, `${key}\n`);
      return i + 1;
    });
  }
  return acc;
};

const store = JournalStore.open(dbPath);
const kernel = new Kernel(store, {
  idgen: () => runId,
  // Deterministic-ish clock; value is irrelevant to the crash assertions.
  clock: () => Date.now(),
  fault: (point, key) => {
    if (point === killPoint && key === killKey) {
      // Hard process death — no cleanup, no catch blocks run. The pending row is
      // already committed to the WAL; the completed row is not.
      process.kill(process.pid, "SIGKILL");
    }
  },
});

const handle =
  phase === "resume"
    ? await kernel.resume(runId, workflow)
    : await kernel.run(workflow, null, { name: "crash-chain" });

store.close();
process.stdout.write(`${JSON.stringify({ status: handle.status, output: handle.output })}\n`);
process.exit(0);
