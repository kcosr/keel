// Additive forward-migration ladder (DESIGN.md §8.1, §19).
//
// The base DDL is `CREATE TABLE IF NOT EXISTS`, so it creates any MISSING tables
// at the current shape but cannot add columns to a pre-existing table. This ladder
// applies the column-adds (and any backfills) needed to bring an older journal up
// to SCHEMA_VERSION. Every step is additive — no data loss — so an existing DB
// upgrades in place instead of failing to open.
//
// History: v1 base → v2 runs.workflow_ref → v3 schedules table → v4
// signals.consumed_key → v5 journal.seq → v6 approvals.prompt/requested_caps_json.

import type { Database } from "bun:sqlite";

/** True if `table` already has `column` (so we don't re-add it). */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function addColumn(db: Database, table: string, column: string, type: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** Apply the single step that upgrades a DB from `fromVersion` to `fromVersion+1`. */
export function applyMigration(db: Database, fromVersion: number): void {
  switch (fromVersion) {
    case 1: // → v2
      addColumn(db, "runs", "workflow_ref", "TEXT");
      break;
    case 2: // → v3: schedules is a new TABLE, created by the base DDL's CREATE IF NOT EXISTS
      break;
    case 3: // → v4
      addColumn(db, "signals", "consumed_key", "TEXT");
      break;
    case 4: // → v5: per-run insertion order; backfill so existing rows stay monotonic
      addColumn(db, "journal", "seq", "INTEGER NOT NULL DEFAULT 0");
      db.exec(
        `UPDATE journal SET seq = sub.rn FROM (
           SELECT rowid AS rid, row_number() OVER (PARTITION BY run_id ORDER BY rowid) AS rn
           FROM journal
         ) AS sub WHERE journal.rowid = sub.rid`,
      );
      break;
    case 5: // → v6
      addColumn(db, "approvals", "prompt", "TEXT");
      addColumn(db, "approvals", "requested_caps_json", "TEXT");
      break;
    default:
      throw new Error(`no migration defined from schema version ${fromVersion}`);
  }
}
