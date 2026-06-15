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
// → v12 workflow SDK ABI manifests and schedule failure state
// → v13 run targets and retained agent session workspaces
// → v14 unified agent workspace retention policy table
// → v15 workflow-scoped direct/worktree workspace rows.

import type { Database } from "bun:sqlite";
import { parse } from "acorn";
import { canonicalJson, sha256Hex } from "../hash.ts";

const DEFINITION_PREFIX = "wf_sha256_";
const WORKFLOW_SDK_ABI_V12 = 1;
const tsTranspiler = new Bun.Transpiler({ loader: "tsx" });

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

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  return row !== null;
}

function workspaceIdForMigration(kind: "agent" | "agent_session", key: string): string {
  return `ws_${sha256Hex(canonicalJson({ kind, key })).slice(0, 32)}`;
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
    case 12: // → v13: run/schedule targets and retained session workspace metadata.
      addColumn(db, "runs", "run_target", "TEXT");
      addColumn(db, "schedules", "schedule_target", "TEXT");
      db.exec(`CREATE TABLE IF NOT EXISTS agent_session_workspaces (
        run_id              TEXT NOT NULL,
        agent_key           TEXT NOT NULL,
        workspace_path      TEXT NOT NULL,
        target              TEXT NOT NULL,
        base_commit         TEXT NOT NULL,
        status              TEXT NOT NULL,
        last_turn_key       TEXT,
        last_turn_attempt   INTEGER,
        last_diff_event_seq INTEGER,
        last_error_event_seq INTEGER,
        created_at_ms       INTEGER NOT NULL,
        updated_at_ms       INTEGER NOT NULL,
        merged_at_ms        INTEGER,
        discarded_at_ms     INTEGER,
        PRIMARY KEY (run_id, agent_key)
      )`);
      break;
    case 13: // → v14: unified workspace retention policy metadata.
      db.exec(`CREATE TABLE IF NOT EXISTS agent_workspaces (
        run_id               TEXT NOT NULL,
        workspace_id         TEXT NOT NULL,
        kind                 TEXT NOT NULL,
        key                  TEXT NOT NULL,
        last_attempt         INTEGER,
        retention_policy     TEXT NOT NULL,
        workspace_path       TEXT NOT NULL,
        target               TEXT NOT NULL,
        base_commit          TEXT NOT NULL,
        status               TEXT NOT NULL,
        failure_seen         INTEGER NOT NULL DEFAULT 0,
        last_turn_key        TEXT,
        last_turn_attempt    INTEGER,
        last_diff_event_seq  INTEGER,
        last_error_event_seq INTEGER,
        cleanup_error_json   TEXT,
        created_at_ms        INTEGER NOT NULL,
        updated_at_ms        INTEGER NOT NULL,
        merged_at_ms         INTEGER,
        discarded_at_ms      INTEGER,
        removed_at_ms        INTEGER,
        PRIMARY KEY (run_id, workspace_id)
      )`);
      if (tableExists(db, "agent_session_workspaces")) {
        const rows = db
          .query<RawAgentSessionWorkspaceV13, []>("SELECT * FROM agent_session_workspaces")
          .all();
        const insert = hasColumn(db, "agent_workspaces", "kind")
          ? db.query(
              `INSERT OR REPLACE INTO agent_workspaces (
                run_id, workspace_id, kind, key, last_attempt, retention_policy,
                workspace_path, target, base_commit, status, failure_seen,
                last_turn_key, last_turn_attempt, last_diff_event_seq, last_error_event_seq,
                cleanup_error_json, created_at_ms, updated_at_ms, merged_at_ms, discarded_at_ms, removed_at_ms
              ) VALUES (?, ?, 'agent_session', ?, NULL, 'always', ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
            )
          : db.query(
              `INSERT OR REPLACE INTO agent_workspaces (
                run_id, workspace_id, mode, owner_kind, key, last_attempt, retention_policy,
                workspace_path, source_path, supplied_path, source_ref, base_commit, owned, status,
                failure_seen, last_turn_key, last_turn_attempt, active_holder_kind, active_holder_key,
                active_holder_attempt, active_started_at_ms, last_diff_event_seq, last_error_event_seq,
                cleanup_error_json, created_at_ms, updated_at_ms, merged_at_ms, discarded_at_ms, removed_at_ms
              ) VALUES (?, ?, 'worktree', 'agent_session', ?, NULL, 'retain', ?, ?, NULL, 'HEAD', ?, 1, ?, 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
            );
        for (const row of rows) {
          insert.run(
            row.run_id,
            workspaceIdForMigration("agent_session", row.agent_key),
            row.agent_key,
            row.workspace_path,
            row.target,
            row.base_commit,
            row.status,
            row.last_turn_key,
            row.last_turn_attempt,
            row.last_diff_event_seq,
            row.last_error_event_seq,
            row.created_at_ms,
            row.updated_at_ms,
            row.merged_at_ms,
            row.discarded_at_ms,
          );
        }
        db.exec("DROP TABLE agent_session_workspaces");
      }
      break;
    case 14: // → v15: workflow-scoped direct/worktree workspace rows.
      if (!hasColumn(db, "agent_workspaces", "kind")) break;
      db.exec("ALTER TABLE agent_workspaces RENAME TO agent_workspaces_old");
      db.exec(`CREATE TABLE agent_workspaces (
        run_id                TEXT NOT NULL,
        workspace_id          TEXT NOT NULL,
        mode                  TEXT NOT NULL,
        owner_kind            TEXT NOT NULL,
        key                   TEXT NOT NULL,
        last_attempt          INTEGER,
        retention_policy      TEXT,
        workspace_path        TEXT NOT NULL,
        source_path           TEXT NOT NULL,
        supplied_path         TEXT,
        source_ref            TEXT,
        base_commit           TEXT,
        owned                 INTEGER NOT NULL DEFAULT 0,
        status                TEXT NOT NULL,
        failure_seen          INTEGER NOT NULL DEFAULT 0,
        last_turn_key         TEXT,
        last_turn_attempt     INTEGER,
        active_holder_kind    TEXT,
        active_holder_key     TEXT,
        active_holder_attempt INTEGER,
        active_started_at_ms  INTEGER,
        last_diff_event_seq   INTEGER,
        last_error_event_seq  INTEGER,
        cleanup_error_json    TEXT,
        created_at_ms         INTEGER NOT NULL,
        updated_at_ms         INTEGER NOT NULL,
        merged_at_ms          INTEGER,
        discarded_at_ms       INTEGER,
        removed_at_ms         INTEGER,
        PRIMARY KEY (run_id, workspace_id)
      )`);
      db.exec(`INSERT INTO agent_workspaces (
        run_id, workspace_id, mode, owner_kind, key, last_attempt, retention_policy,
        workspace_path, source_path, supplied_path, source_ref, base_commit, owned, status,
        failure_seen, last_turn_key, last_turn_attempt, active_holder_kind, active_holder_key,
        active_holder_attempt, active_started_at_ms, last_diff_event_seq, last_error_event_seq,
        cleanup_error_json, created_at_ms, updated_at_ms, merged_at_ms, discarded_at_ms, removed_at_ms
      )
      SELECT
        run_id,
        workspace_id,
        'worktree',
        kind,
        key,
        last_attempt,
        CASE retention_policy
          WHEN 'never' THEN 'remove'
          WHEN 'on-failure' THEN 'retain-on-failure'
          WHEN 'always' THEN 'retain'
          ELSE retention_policy
        END,
        workspace_path,
        target,
        NULL,
        'HEAD',
        base_commit,
        1,
        status,
        failure_seen,
        last_turn_key,
        last_turn_attempt,
        NULL,
        NULL,
        NULL,
        NULL,
        last_diff_event_seq,
        last_error_event_seq,
        cleanup_error_json,
        created_at_ms,
        updated_at_ms,
        merged_at_ms,
        discarded_at_ms,
        removed_at_ms
      FROM agent_workspaces_old`);
      db.exec("DROP TABLE agent_workspaces_old");
      break;
    default:
      throw new Error(`no migration defined from schema version ${fromVersion}`);
  }
}

interface RawAgentSessionWorkspaceV13 {
  run_id: string;
  agent_key: string;
  workspace_path: string;
  target: string;
  base_commit: string;
  status: string;
  last_turn_key: string | null;
  last_turn_attempt: number | null;
  last_diff_event_seq: number | null;
  last_error_event_seq: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  merged_at_ms: number | null;
  discarded_at_ms: number | null;
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
    validateWorkflowDefinitionManifestForV12Migration(row.hash, row.code, manifest);

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
    db.query("UPDATE runs SET workflow_ref = ? WHERE workflow_ref = ?").run(newHash, row.hash);
    db.query("UPDATE schedules SET workflow_ref = ? WHERE workflow_ref = ?").run(newHash, row.hash);
    db.query(
      `DELETE FROM workflow_definitions
       WHERE hash = ?
         AND hash NOT IN (SELECT definition_version FROM runs)
         AND hash NOT IN (SELECT workflow_ref FROM runs WHERE workflow_ref IS NOT NULL)
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

function validateWorkflowDefinitionManifestForV12Migration(
  hash: string,
  code: string,
  manifest: WorkflowDefinitionManifestV11,
): void {
  if (!Array.isArray(manifest.modules)) {
    throw new Error(`workflow definition ${hash} manifest modules must be an array`);
  }
  if (!Array.isArray(manifest.externalImports)) {
    throw new Error(`workflow definition ${hash} manifest externalImports must be an array`);
  }
  if (!Array.isArray(manifest.externalPackages)) {
    throw new Error(`workflow definition ${hash} manifest externalPackages must be an array`);
  }
  const modules = manifest.modules.length > 0 ? manifest.modules : [{ path: "entry.ts", code }];
  for (const module of modules) {
    if (!isCapturedModuleV11(module)) {
      throw new Error(`workflow definition ${hash} manifest module entries are invalid`);
    }
  }
  const actualImports = collectExternalImportsForV12Migration(modules).sort();
  for (const spec of actualImports) {
    if (spec !== "@kcosr/keel") {
      throw new Error(`workflow import "${spec}" is not allowed; only @kcosr/keel is supported`);
    }
  }
  const declaredImports = [...manifest.externalImports].sort();
  if (canonicalJson(declaredImports) !== canonicalJson(actualImports)) {
    throw new Error(`workflow definition ${hash} manifest externalImports do not match source`);
  }
  for (const pinned of manifest.externalPackages) {
    if (!isCapturedExternalPackageV11(pinned)) {
      throw new Error(`workflow definition ${hash} manifest external package entries are invalid`);
    }
    if (pinned.name !== "@kcosr/keel") {
      throw new Error(
        `workflow definition ${hash} includes unsupported external package "${pinned.name}"`,
      );
    }
  }
}

function isCapturedModuleV11(value: unknown): value is { path: string; code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

function isCapturedExternalPackageV11(value: unknown): value is { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function collectExternalImportsForV12Migration(
  modules: Array<{ path: string; code: string }>,
): string[] {
  const imports = new Set<string>();
  for (const module of modules) {
    for (const spec of staticImportsForV12Migration(module.code, module.path)) {
      if (!spec.startsWith(".") && !spec.startsWith("/")) imports.add(spec);
    }
  }
  return [...imports];
}

function staticImportsForV12Migration(source: string, filename: string): string[] {
  let ast: { type: string } & Record<string, unknown>;
  try {
    ast = parse(tsTranspiler.transformSync(source), {
      ecmaVersion: "latest",
      sourceType: "module",
    }) as unknown as { type: string } & Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `could not parse workflow imports in ${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const imports: string[] = [];
  walkMigrationAst(ast, (node) => {
    if (node.type === "ImportExpression") {
      throw new Error(`dynamic import(...) is not allowed in workflow code: ${filename}`);
    }
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      const src = (node.source as ({ value?: unknown } & Record<string, unknown>) | undefined)
        ?.value;
      if (typeof src === "string") imports.push(src);
    }
  });
  return imports;
}

function walkMigrationAst(
  root: { type: string } & Record<string, unknown>,
  fn: (node: { type: string } & Record<string, unknown>) => void,
): void {
  const visit = (node: { type: string } & Record<string, unknown>): void => {
    fn(node);
    for (const child of childMigrationNodes(node)) visit(child);
  };
  visit(root);
}

function childMigrationNodes(
  node: { type: string } & Record<string, unknown>,
): Array<{ type: string } & Record<string, unknown>> {
  const out: Array<{ type: string } & Record<string, unknown>> = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const v of value) if (isMigrationAstNode(v)) out.push(v);
    } else if (isMigrationAstNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function isMigrationAstNode(value: unknown): value is { type: string } & Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
