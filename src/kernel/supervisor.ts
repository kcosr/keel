// Supervisor (DESIGN.md §16) — the daemon's background tick that drives durable
// time forward: it wakes runs whose timers are due and fires cron schedules.
// Everything it needs is in the journal, so it is correct across daemon restarts
// (a fresh supervisor reads due timers/schedules and proceeds).

import type { JournalStore } from "../journal/store.ts";
import type { RealmKernel } from "./realm/realm-host.ts";

export interface SupervisorDeps {
  store: JournalStore;
  kernel: RealmKernel;
  clock?: () => number;
  /** Claim a run before driving it (the daemon's CAS fence); default always-ok. */
  claim?: (runId: string) => boolean;
  /** Resolve a run's workflow ref (defaults to the stored workflow_ref). */
}

export class Supervisor {
  private readonly store: JournalStore;
  private readonly kernel: RealmKernel;
  private readonly clock: () => number;
  private readonly claim: (runId: string) => boolean;

  constructor(deps: SupervisorDeps) {
    this.store = deps.store;
    this.kernel = deps.kernel;
    this.clock = deps.clock ?? (() => Date.now());
    this.claim = deps.claim ?? (() => true);
  }

  /** One supervision pass. Returns what it acted on (for tests/telemetry). */
  async tick(): Promise<{ woken: string[]; fired: string[] }> {
    const now = this.clock();
    const woken = await this.wakeDueTimers(now);
    const fired = await this.fireDueSchedules(now);
    return { woken, fired };
  }

  private async wakeDueTimers(now: number): Promise<string[]> {
    const woken: string[] = [];
    for (const runId of this.store.dueTimerRunIds(now)) {
      const run = this.store.getRun(runId);
      if (!run) continue;
      if (run.status !== "waiting-timer") continue;
      if (!this.claim(runId)) continue;
      try {
        await this.kernel.resume(runId);
        woken.push(runId);
      } catch {
        // a resume that re-parks (a later timer) or errors is left for next tick
      }
    }
    return woken;
  }

  private async fireDueSchedules(now: number): Promise<string[]> {
    const fired: string[] = [];
    for (const s of this.store.dueSchedules(now)) {
      const { runId } = this.kernel.launchDefinition(
        s.workflowRef,
        s.inputJson ? JSON.parse(s.inputJson) : null,
        {
          name: s.name,
          workflowRef: s.workflowRef,
        },
      );
      // advance to the next slot from the scheduled time (not drifting on now)
      const next = Math.max(s.nextFireMs + s.intervalMs, now + s.intervalMs);
      this.store.advanceSchedule(s.name, next, runId);
      fired.push(s.name);
    }
    return fired;
  }
}
