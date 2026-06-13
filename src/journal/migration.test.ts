// Commit 1: additive forward migrations — an older journal upgrades in place
// instead of failing to open (review-log Phase 19 finding).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore } from "./store.ts";

/** Build a minimal v4-era DB by hand: journal WITHOUT seq, approvals WITHOUT
 * prompt/requested_caps_json, schema_version = 4. */
function makeV4Db(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, workflow_name TEXT, definition_version TEXT,
      workflow_ref TEXT, status TEXT, parent_run_id TEXT, tenant_id TEXT, input_ref TEXT,
      output_ref TEXT, error_json TEXT, heartbeat_at_ms INTEGER, runtime_owner_id TEXT,
      created_at_ms INTEGER, finished_at_ms INTEGER);
    CREATE TABLE journal (run_id TEXT, stable_key TEXT, attempt INTEGER DEFAULT 1,
      effect_type TEXT, status TEXT, version TEXT, input_hash TEXT, input_deps_json TEXT,
      key_set_hash TEXT, result_inline TEXT, result_artifact TEXT, session_token TEXT,
      error_json TEXT, started_at_ms INTEGER, finished_at_ms INTEGER,
      PRIMARY KEY (run_id, stable_key, attempt));
    CREATE TABLE approvals (run_id TEXT, stable_key TEXT, status TEXT, granted_caps_json TEXT,
      decided_by TEXT, note TEXT, requested_at_ms INTEGER, decided_at_ms INTEGER,
      PRIMARY KEY (run_id, stable_key));
    CREATE TABLE signals (run_id TEXT, seq INTEGER, name TEXT, correlation_id TEXT,
      payload_ref TEXT, received_at_ms INTEGER, consumed_key TEXT, PRIMARY KEY (run_id, seq));
  `);
  db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '4')").run();
  // two journal rows so seq backfill has something to order
  db.query(
    "INSERT INTO journal (run_id, stable_key, effect_type, status, version, input_hash) VALUES ('r','a','pure','completed','v','h1')",
  ).run();
  db.query(
    "INSERT INTO journal (run_id, stable_key, effect_type, status, version, input_hash) VALUES ('r','b','pure','completed','v','h2')",
  ).run();
  db.close();
}

describe("schema migrations", () => {
  test("a v4 DB migrates forward to v6 in place, additively and idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-"));
    try {
      const path = join(dir, "old.db");
      makeV4Db(path);

      // Opening with current code must NOT throw; it migrates forward.
      const store = JournalStore.open(path);

      // schema bumped to current
      const ver = store.db
        .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get();
      expect(ver?.value).toBe("6");

      // new columns exist
      const jcols = store.db.query<{ name: string }, []>("PRAGMA table_info(journal)").all();
      expect(jcols.some((c) => c.name === "seq")).toBe(true);
      const acols = store.db.query<{ name: string }, []>("PRAGMA table_info(approvals)").all();
      expect(acols.some((c) => c.name === "prompt")).toBe(true);
      expect(acols.some((c) => c.name === "requested_caps_json")).toBe(true);

      // existing rows preserved (additive) and seq backfilled per-run monotonic
      const rows = store.listJournalRows("r");
      expect(rows.length).toBe(2);
      const seqs = store.db
        .query<{ seq: number }, []>("SELECT seq FROM journal WHERE run_id='r' ORDER BY seq")
        .all()
        .map((r) => r.seq);
      expect(seqs).toEqual([1, 2]);
      store.close();

      // re-open: idempotent, no migration runs again
      const store2 = JournalStore.open(path);
      expect(store2.listJournalRows("r").length).toBe(2);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh DB initializes at the current version with no migration", () => {
    const store = JournalStore.memory();
    const ver = store.db
      .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='schema_version'")
      .get();
    expect(ver?.value).toBe("6");
    store.close();
  });
});
