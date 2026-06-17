// Secrets side-channel for trusted-local agent env injection (DESIGN.md §11.2).
//
// Secret values are kept out of workflow source, step inputs, and provider
// configuration by storing them in-memory by run id and resolving named refs at
// invocation time. The realm host injects resolved refs as environment variables
// for the provider call and wipes the per-run entries when the run reaches a
// terminal cleanup path. Agent outputs/events/diffs/errors are journaled as-is;
// workflow authors should avoid prompting agents to print or persist secrets
// when they do not want those values recorded.

export interface SecretRef {
  name: string;
  value: string;
}

/** In-process side-channel store (never persisted by this store). */
export class SecretStore {
  private readonly byRun = new Map<string, Map<string, string>>();

  put(runId: string, name: string, value: string): void {
    let m = this.byRun.get(runId);
    if (!m) {
      m = new Map();
      this.byRun.set(runId, m);
    }
    m.set(name, value);
  }

  putMany(runId: string, secrets: Record<string, string>): void {
    for (const [name, value] of Object.entries(secrets)) this.put(runId, name, value);
  }

  /** Resolve named secret refs for env injection at invocation. */
  resolveOrThrow(runId: string, names: readonly string[]): SecretRef[] {
    const m = this.byRun.get(runId);
    const refs: SecretRef[] = [];
    for (const name of names) {
      const value = m?.get(name);
      if (value === undefined) {
        throw new Error(`run ${runId} is missing secret value for ${name}`);
      }
      refs.push({ name, value });
    }
    return refs;
  }

  /** Wipe a run's secrets on terminal cleanup. */
  wipe(runId: string): void {
    this.byRun.delete(runId);
  }
}
