// Forward migrations — an older journal upgrades in place instead of failing to
// open, and persisted meaning changes are handled at the migration boundary.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../hash.ts";
import { RealmKernel } from "../kernel/realm/realm-host.ts";
import {
  materializeWorkflowDefinition,
  snapshotWorkflowSource,
} from "../workflow-definitions/snapshot.ts";
import {
  canonicalWorkflowDefinitionManifestV12,
  workflowDefinitionHashForV12Migration,
} from "./migrations.ts";
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

/** Build a v8 DB with the pre-v9 schedule meaning and pre-v10 NOT NULL names. */
function makeV8Db(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (
      run_id             TEXT PRIMARY KEY,
      workflow_name      TEXT NOT NULL,
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
    );
    CREATE TABLE schedules (
      name         TEXT PRIMARY KEY,
      workflow_ref TEXT NOT NULL,
      input_json   TEXT,
      interval_ms  INTEGER NOT NULL,
      next_fire_ms INTEGER NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_id  TEXT
    );
    CREATE TABLE workflow_definitions (
      hash          TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      code          TEXT NOT NULL,
      source_map    TEXT,
      manifest_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
  `);
  db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '8')").run();
  db.query(
    `INSERT INTO runs (
      run_id, workflow_name, definition_version, workflow_ref, status, input_ref, created_at_ms
    ) VALUES ('r_path', 'path-run', 'wf_sha256_old', '/daemon/path.workflow.ts', 'finished', 'null', 1)`,
  ).run();
  db.query(
    `INSERT INTO schedules (
      name, workflow_ref, input_json, interval_ms, next_fire_ms, enabled
    ) VALUES ('hourly', '/daemon/path.workflow.ts', 'null', 3600000, 1000, 1)`,
  ).run();
  db.query(
    `INSERT INTO workflow_definitions (
      hash, name, kind, code, source_map, manifest_json, created_at_ms
    ) VALUES ('wf_sha256_old', 'path-run', 'path', 'export default async () => 1;', NULL, '{}', 1)`,
  ).run();
  db.close();
}

const sdkWorkflowSource =
  'import { passthrough } from "@kcosr/keel";\nexport default async () => passthrough<number>().parse(1);\n';

function oldWorkflowManifest(source = sdkWorkflowSource, integrity = "sha256-old") {
  return {
    format: "keel.workflow-definition.v1",
    entry: "entry.ts",
    modules: [{ path: "entry.ts", code: source }],
    externalImports: ["@kcosr/keel"],
    externalPackages: [
      {
        name: "@kcosr/keel",
        root: "/old/keel",
        integrity,
      },
    ],
    sourceRoot: "client-captured://source",
    runtime: {
      bunVersion: Bun.version,
      keelDefinitionAbi: 1,
    },
  };
}

function makeV11Db(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (
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
    );
    CREATE TABLE schedules (
      name         TEXT PRIMARY KEY,
      workflow_ref TEXT NOT NULL,
      input_json   TEXT,
      interval_ms  INTEGER NOT NULL,
      next_fire_ms INTEGER NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_id  TEXT
    );
    CREATE TABLE workflow_definitions (
      hash          TEXT PRIMARY KEY,
      name          TEXT,
      kind          TEXT NOT NULL,
      code          TEXT NOT NULL,
      source_map    TEXT,
      manifest_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
  `);
  db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '11')").run();
  db.close();
}

function insertOldWorkflowDefinition(
  db: Database,
  hash: string,
  manifest: ReturnType<typeof oldWorkflowManifest>,
): void {
  const [entry] = manifest.modules;
  if (!entry) throw new Error("old workflow manifest is missing entry module");
  db.query(
    `INSERT INTO workflow_definitions (
      hash, name, kind, code, source_map, manifest_json, created_at_ms
    ) VALUES (?, 'wf', 'source', ?, NULL, ?, 1)`,
  ).run(hash, entry.code, JSON.stringify(manifest));
}

describe("schema migrations", () => {
  test("a v4 DB migrates forward to v12 in place and idempotently", () => {
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
      expect(ver?.value).toBe("12");

      // new columns exist
      const jcols = store.db.query<{ name: string }, []>("PRAGMA table_info(journal)").all();
      expect(jcols.some((c) => c.name === "seq")).toBe(true);
      const acols = store.db.query<{ name: string }, []>("PRAGMA table_info(approvals)").all();
      expect(acols.some((c) => c.name === "prompt")).toBe(true);
      expect(acols.some((c) => c.name === "requested_caps_json")).toBe(true);
      const wdefs = store.db
        .query<{ name: string }, []>("PRAGMA table_info(workflow_definitions)")
        .all();
      expect(wdefs.some((c) => c.name === "hash")).toBe(true);
      expect(wdefs.some((c) => c.name === "manifest_json")).toBe(true);
      const caps = store.db.query<{ name: string }, []>("PRAGMA table_info(capabilities)").all();
      expect(caps.some((c) => c.name === "secret_hash")).toBe(true);
      expect(caps.some((c) => c.name === "resource_json")).toBe(true);
      const sessions = store.db
        .query<{ name: string }, []>("PRAGMA table_info(agent_sessions)")
        .all();
      expect(sessions.some((c) => c.name === "identity_hash")).toBe(true);
      const turns = store.db
        .query<{ name: string }, []>("PRAGMA table_info(agent_session_turns)")
        .all();
      expect(turns.some((c) => c.name === "observed_session_token")).toBe(true);

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
    expect(ver?.value).toBe("12");
    store.close();
  });

  test("v8 path schedules are disabled and display-name columns become nullable", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v8-"));
    try {
      const path = join(dir, "old.db");
      makeV8Db(path);

      const store = JournalStore.open(path);
      const ver = store.db
        .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get();
      expect(ver?.value).toBe("12");

      const schedule = store.db
        .query<{ enabled: number; workflow_ref: string }, []>(
          "SELECT enabled, workflow_ref FROM schedules WHERE name = 'hourly'",
        )
        .get();
      expect(schedule).toEqual({ enabled: 0, workflow_ref: "/daemon/path.workflow.ts" });
      expect(store.getRun("r_path")?.workflowName).toBe("path-run");
      expect(store.getWorkflowDefinition("wf_sha256_old")?.name).toBe("path-run");

      store.insertRun({
        runId: "r_null",
        workflowName: null,
        definitionVersion: "wf_sha256_new",
        workflowRef: "stdin",
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 2,
      });
      store.putWorkflowDefinition({
        hash: "wf_sha256_new",
        name: null,
        kind: "source",
        code: "export default async () => 1;",
        sourceMap: null,
        manifestJson: "{}",
        createdAtMs: 2,
      });
      expect(store.getRun("r_null")?.workflowName).toBeNull();
      expect(store.getWorkflowDefinition("wf_sha256_new")?.name).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v11 workflow definitions migrate to SDK ABI manifests and repoint runs and schedules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v11-"));
    try {
      const path = join(dir, "old.db");
      makeV11Db(path);
      const db = new Database(path);
      const oldHash = "wf_sha256_old_sdk";
      const oldManifest = oldWorkflowManifest();
      const newHash = workflowDefinitionHashForV12Migration(
        canonicalWorkflowDefinitionManifestV12(oldManifest),
      );
      insertOldWorkflowDefinition(db, oldHash, oldManifest);
      db.query(
        `INSERT INTO runs (
          run_id, workflow_name, definition_version, workflow_ref, status,
          input_ref, created_at_ms
        ) VALUES ('r_active', 'wf', ?, 'stdin', 'waiting-timer', 'null', 1)`,
      ).run(oldHash);
      db.query(
        `INSERT INTO schedules (
          name, workflow_ref, input_json, interval_ms, next_fire_ms, enabled
        ) VALUES ('hourly', ?, 'null', 60000, 1, 1)`,
      ).run(oldHash);
      db.close();

      const cacheRoot = join(dir, "definitions");
      const store = JournalStore.open(path);
      expect(store.getRun("r_active")?.definitionVersion).toBe(newHash);
      const schedule = store.db
        .query<{ workflow_ref: string; last_error_json: string | null }, []>(
          "SELECT workflow_ref, last_error_json FROM schedules WHERE name = 'hourly'",
        )
        .get();
      expect(schedule).toEqual({ workflow_ref: newHash, last_error_json: null });
      expect(store.getWorkflowDefinition(oldHash)).toBeNull();
      expect(store.getWorkflowDefinition(newHash)).not.toBeNull();

      const entry = materializeWorkflowDefinition(store, newHash, cacheRoot);
      expect(entry.endsWith("entry.ts")).toBe(true);
      const kernel = new RealmKernel(store, { clock: () => 2, definitionCacheRoot: cacheRoot });
      const out = await kernel.resume("r_active");
      expect(out.status).toBe("finished");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v11 workflow migration fails on a recomputed hash collision with different content", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v11-collision-"));
    try {
      const path = join(dir, "old.db");
      makeV11Db(path);
      const db = new Database(path);
      const oldManifest = oldWorkflowManifest();
      const newHash = workflowDefinitionHashForV12Migration(
        canonicalWorkflowDefinitionManifestV12(oldManifest),
      );
      insertOldWorkflowDefinition(db, "wf_sha256_old_collision", oldManifest);
      db.query(
        `INSERT INTO workflow_definitions (
          hash, name, kind, code, source_map, manifest_json, created_at_ms
        ) VALUES (?, 'other', 'source', 'export default async () => 2;', NULL, '{}', 1)`,
      ).run(newHash);
      db.close();

      expect(() => JournalStore.open(path)).toThrow(/workflow definition migration collision/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v11 workflow migration collapses duplicate definitions that differ only by SDK pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v11-duplicates-"));
    try {
      const path = join(dir, "old.db");
      makeV11Db(path);
      const db = new Database(path);
      const oldA = oldWorkflowManifest(sdkWorkflowSource, "sha256-old-a");
      const oldB = oldWorkflowManifest(sdkWorkflowSource, "sha256-old-b");
      const newHash = workflowDefinitionHashForV12Migration(
        canonicalWorkflowDefinitionManifestV12(oldA),
      );
      insertOldWorkflowDefinition(db, "wf_sha256_old_a", oldA);
      insertOldWorkflowDefinition(db, "wf_sha256_old_b", oldB);
      db.query(
        `INSERT INTO runs (
          run_id, workflow_name, definition_version, workflow_ref, status,
          input_ref, created_at_ms
        ) VALUES ('r_a', 'wf', 'wf_sha256_old_a', 'stdin', 'running', 'null', 1)`,
      ).run();
      db.query(
        `INSERT INTO schedules (
          name, workflow_ref, input_json, interval_ms, next_fire_ms, enabled
        ) VALUES ('hourly', 'wf_sha256_old_b', 'null', 60000, 1, 0)`,
      ).run();
      db.close();

      const store = JournalStore.open(path);
      expect(store.getRun("r_a")?.definitionVersion).toBe(newHash);
      expect(
        store.db.query<{ workflow_ref: string }, []>("SELECT workflow_ref FROM schedules").get()
          ?.workflow_ref,
      ).toBe(newHash);
      expect(store.getWorkflowDefinition("wf_sha256_old_a")).toBeNull();
      expect(store.getWorkflowDefinition("wf_sha256_old_b")).toBeNull();
      expect(
        store.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM workflow_definitions").get()
          ?.c,
      ).toBe(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v12 migration hash projection matches current snapshot creation at ship time", () => {
    const store = JournalStore.memory();
    try {
      const { snapshot } = snapshotWorkflowSource(store, sdkWorkflowSource, {
        name: "lock",
        nowMs: 1,
      });
      const { workflowSdkAbi: _workflowSdkAbi, ...oldRuntime } = snapshot.manifest.runtime;
      const migrated = canonicalWorkflowDefinitionManifestV12({
        ...snapshot.manifest,
        externalPackages: [{ name: "@kcosr/keel", root: "/old/keel", integrity: "sha256-old" }],
        runtime: oldRuntime,
      });
      expect(canonicalJson(migrated)).toBe(canonicalJson(snapshot.manifest));
      expect(workflowDefinitionHashForV12Migration(migrated)).toBe(snapshot.hash);
    } finally {
      store.close();
    }
  });
});
