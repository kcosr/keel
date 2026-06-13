// Phase 19: artifact GC + Postgres-dialect discipline.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JournalStore } from "./store.ts";

describe("artifact GC", () => {
  test("reclaims only unreferenced blobs; refcounts self-heal from the journal", () => {
    const store = JournalStore.memory();
    const bytes = new TextEncoder().encode("x".repeat(2000));
    store.putArtifact("hash1", bytes, 0);
    store.putJournalRow({
      runId: "r",
      stableKey: "big",
      effectType: "pure",
      status: "completed",
      version: "v",
      inputHash: "i",
      resultArtifact: "hash1",
    });
    // referenced → kept even though we GC
    expect(store.gcArtifacts()).toBe(0);
    expect(store.getArtifact("hash1")).not.toBeNull();

    // an orphan blob nobody references → reclaimed
    store.putArtifact("hash2", bytes, 0);
    expect(store.gcArtifacts()).toBe(1);
    expect(store.getArtifact("hash2")).toBeNull();
    expect(store.getArtifact("hash1")).not.toBeNull();

    // after the referencing row is gone (e.g. rewind), GC reclaims it too
    store.db.query("DELETE FROM journal WHERE run_id = 'r'").run();
    expect(store.gcArtifacts()).toBe(1);
    expect(store.getArtifact("hash1")).toBeNull();
  });
});

describe("Postgres-dialect discipline (L11/L17)", () => {
  test("no SQLite-only SQL constructs leak into the schema or store queries", () => {
    const schema = readFileSync(new URL("./schema.ts", import.meta.url).pathname, "utf8");
    const store = readFileSync(new URL("./store.ts", import.meta.url).pathname, "utf8");
    // strip comments so the word "rowid" in a doc comment doesn't trip the scan
    const strip = (s: string) => s.replace(/--.*$/gm, "").replace(/\/\/.*$/gm, "");
    const sql = strip(schema) + strip(store);
    expect(sql).not.toMatch(/\browid\b/i);
    expect(sql).not.toMatch(/autoincrement/i);
    expect(sql).not.toMatch(/insert\s+or\s+(ignore|replace)/i); // sqlite-only upserts
    // MAX(x, y) / MIN(x, y) as a scalar is SQLite-only; Postgres uses GREATEST/CASE.
    // (single-arg aggregate MAX(col) is fine — only the 2-arg form has a comma in parens)
    expect(sql).not.toMatch(/\b(max|min)\s*\([^)]*,/i);
  });
});
