// Secrets side-channel + journal-boundary redaction (DESIGN.md §11.2).
//
// The journal is forever, so secrets NEVER enter it. They travel via an
// encrypted-at-rest side channel keyed runId+stableKey, are injected sealed at
// agent invocation, and wiped on completion. As defense-in-depth, agent outputs
// are scanned for exact secret values and redacted at the journal boundary —
// this is NOT the guarantee (it catches only exact values; the by-construction
// side channel is the guarantee).

export interface SecretRef {
  name: string;
  value: string;
}

/** In-process side-channel store (never persisted to the journal). */
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

  /** Resolve named secret refs for a step (injected at invocation). */
  resolve(runId: string, names: string[]): SecretRef[] {
    const m = this.byRun.get(runId);
    if (!m) return [];
    return names
      .map((name) => ({ name, value: m.get(name) }))
      .filter((r): r is SecretRef => r.value !== undefined);
  }

  /** All secret values for a run (for redaction scanning). */
  values(runId: string): string[] {
    return [...(this.byRun.get(runId)?.values() ?? [])];
  }

  /** Wipe a run's secrets (on completion). */
  wipe(runId: string): void {
    this.byRun.delete(runId);
  }
}

/** Replace any exact secret value occurrence with a redaction marker. */
export function redact(text: string, secrets: string[]): { text: string; redacted: boolean } {
  let out = text;
  let redacted = false;
  for (const s of secrets) {
    if (!s) continue;
    // Also match the JSON-escaped form: callers redact a JSON.stringify'd blob,
    // and a secret containing a quote/backslash appears there escaped (e.g. " →
    // \"), so the raw substring would miss it.
    const escaped = JSON.stringify(s).slice(1, -1);
    for (const variant of escaped === s ? [s] : [s, escaped]) {
      if (out.includes(variant)) {
        out = out.split(variant).join("«redacted»");
        redacted = true;
      }
    }
  }
  return { text: out, redacted };
}
