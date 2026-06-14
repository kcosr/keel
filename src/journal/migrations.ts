// Forward-migration ladder (DESIGN.md §8.1, §19).
//
// The base DDL is `CREATE TABLE IF NOT EXISTS`, so it creates any MISSING tables
// at the current shape but cannot add columns to a pre-existing table. This ladder
// applies the column-adds, rebuilds, and data transitions needed to bring an older
// journal up to SCHEMA_VERSION. Migrations are forward-only; compatibility after
// startup is the current schema, not runtime branches for old record meanings.
//
// History: v1 base → v2 runs.workflow_ref → v3 schedules table → v4
// signals.consumed_key → v5 journal.seq → v6 approvals.prompt/requested_caps_json
// → v7 workflow_definitions → v8 capabilities → v9 schedule definitions
// → v10 nullable display names → v11 durable agent session tables
// → v12 workflow SDK ABI manifests and schedule failure state.

import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../hash.ts";

const DEFINITION_PREFIX = "wf_sha256_";
const WORKFLOW_SDK_ABI_V12 = 1;

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

function rebuildTable(db: Database, table: string, createSql: string, columns: string[]): void {
  const tmp = `${table}_new`;
  const cols = columns.join(", ");
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
  db.exec(createSql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${tmp}`));
  db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${table}_old`);
  db.exec(`DROP TABLE ${table}_old`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
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
    case 6: // → v7: workflow_definitions is a new TABLE, created by base DDL.
      break;
    case 7: // → v8: capabilities is a new TABLE, created by base DDL.
      break;
    case 8: // → v9: schedules.workflow_ref now stores definition hashes.
      db.exec("UPDATE schedules SET enabled = 0");
      break;
    case 9: // → v10: display names are nullable.
      rebuildTable(
        db,
        "runs",
        `CREATE TABLE runs (
          run_id             TEXT PRIMARY KEY,
          workflow_name      TEXT,
          definition_version TEXT NOT NULL,
          workflow_ref       TEXT,
          status             TEXT NOT NULL,
          parent_run_id      TEXT,
          tenant_id          TEXT,
          input_ref          TEXT,
          output_ref         TEXT,
          error_json         TEXT,
          heartbeat_at_ms    INTEGER,
          runtime_owner_id   TEXT,
          created_at_ms      INTEGER NOT NULL,
          finished_at_ms     INTEGER
        )`,
        [
          "run_id",
          "workflow_name",
          "definition_version",
          "workflow_ref",
          "status",
          "parent_run_id",
          "tenant_id",
          "input_ref",
          "output_ref",
          "error_json",
          "heartbeat_at_ms",
          "runtime_owner_id",
          "created_at_ms",
          "finished_at_ms",
        ],
      );
      rebuildTable(
        db,
        "workflow_definitions",
        `CREATE TABLE workflow_definitions (
          hash          TEXT PRIMARY KEY,
          name          TEXT,
          kind          TEXT NOT NULL,
          code          TEXT NOT NULL,
          source_map    TEXT,
          manifest_json TEXT,
          created_at_ms INTEGER NOT NULL
        )`,
        ["hash", "name", "kind", "code", "source_map", "manifest_json", "created_at_ms"],
      );
      break;
    case 10: // → v11: durable logical agent session metadata tables.
      break;
    case 11: // → v12: workflow SDK ABI manifests and durable schedule fire errors.
      addColumn(db, "schedules", "last_error_json", "TEXT");
      addColumn(db, "schedules", "last_failed_at_ms", "INTEGER");
      migrateWorkflowDefinitionManifestsToV12(db);
      break;
    default:
      throw new Error(`no migration defined from schema version ${fromVersion}`);
  }
}

interface RawWorkflowDefinitionV11 {
  hash: string;
  name: string | null;
  kind: string;
  code: string;
  source_map: string | null;
  manifest_json: string | null;
  created_at_ms: number;
}

interface WorkflowDefinitionManifestV11 {
  format?: unknown;
  entry?: unknown;
  modules?: unknown;
  externalImports?: unknown;
  externalPackages?: unknown;
  sourceRoot?: unknown;
  runtime?: Record<string, unknown>;
}

function migrateWorkflowDefinitionManifestsToV12(db: Database): void {
  const rows = db.query<RawWorkflowDefinitionV11, []>("SELECT * FROM workflow_definitions").all();
  for (const row of rows) {
    if (!row.manifest_json) continue;
    const manifest = JSON.parse(row.manifest_json) as WorkflowDefinitionManifestV11;
    if (manifest.format !== "keel.workflow-definition.v1") continue;
    if (typeof manifest.runtime?.workflowSdkAbi === "number") continue;

    const canonicalManifest = canonicalWorkflowDefinitionManifestV12(manifest);
    const canonicalManifestJson = canonicalJson(canonicalManifest);
    const newHash = workflowDefinitionHashForV12Migration(canonicalManifest);
    const existing = db
      .query<RawWorkflowDefinitionV11, [string]>(
        "SELECT * FROM workflow_definitions WHERE hash = ?",
      )
      .get(newHash);

    if (existing) {
      assertWorkflowDefinitionCollisionIsMergeable(existing, row, canonicalManifestJson, newHash);
    } else {
      db.query(
        `INSERT INTO workflow_definitions (
           hash, name, kind, code, source_map, manifest_json, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newHash,
        row.name,
        row.kind,
        row.code,
        row.source_map,
        canonicalManifestJson,
        row.created_at_ms,
      );
    }

    db.query("UPDATE runs SET definition_version = ? WHERE definition_version = ?").run(
      newHash,
      row.hash,
    );
    db.query("UPDATE schedules SET workflow_ref = ? WHERE workflow_ref = ?").run(newHash, row.hash);
    db.query(
      `DELETE FROM workflow_definitions
       WHERE hash = ?
         AND hash NOT IN (SELECT definition_version FROM runs)
         AND hash NOT IN (SELECT workflow_ref FROM schedules)`,
    ).run(row.hash);
  }
}

function assertWorkflowDefinitionCollisionIsMergeable(
  existing: RawWorkflowDefinitionV11,
  oldRow: RawWorkflowDefinitionV11,
  canonicalManifestJson: string,
  newHash: string,
): void {
  if (
    existing.kind !== oldRow.kind ||
    existing.code !== oldRow.code ||
    existing.source_map !== oldRow.source_map ||
    existing.manifest_json !== canonicalManifestJson
  ) {
    throw new Error(
      `workflow definition migration collision for ${newHash}: existing row differs from migrated content`,
    );
  }
}

export function canonicalWorkflowDefinitionManifestV12(
  manifest: WorkflowDefinitionManifestV11,
): Record<string, unknown> {
  const runtime =
    manifest.runtime && typeof manifest.runtime === "object" && !Array.isArray(manifest.runtime)
      ? manifest.runtime
      : {};
  const packages = Array.isArray(manifest.externalPackages)
    ? manifest.externalPackages.filter(
        (pkg) =>
          !(
            pkg &&
            typeof pkg === "object" &&
            "name" in pkg &&
            (pkg as { name?: unknown }).name === "@kcosr/keel"
          ),
      )
    : [];
  return {
    format: manifest.format,
    entry: manifest.entry,
    modules: manifest.modules,
    externalImports: manifest.externalImports,
    externalPackages: packages,
    sourceRoot: manifest.sourceRoot,
    runtime: {
      ...runtime,
      workflowSdkAbi: WORKFLOW_SDK_ABI_V12,
    },
  };
}

export function workflowDefinitionHashForV12Migration(manifest: Record<string, unknown>): string {
  return `${DEFINITION_PREFIX}${sha256Hex(
    canonicalJson({
      format: manifest.format,
      entry: manifest.entry,
      modules: manifest.modules,
      externalImports: manifest.externalImports,
      externalPackages: manifest.externalPackages,
      runtime: manifest.runtime,
    }),
  )}`;
}
