// Journal DDL (DESIGN.md Appendix A).
//
// Kept Postgres-compatible as discipline (L11/L17): no SQLite-only column types
// or tricks. Integers are epoch-ms; JSON travels as TEXT. Reserved tables
// (approvals/signals/timers) are created now though their effects land later.

export const SCHEMA_VERSION = 10;

export const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
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

CREATE TABLE IF NOT EXISTS journal (
  run_id          TEXT NOT NULL,
  stable_key      TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1,
  -- per-run monotonic insertion order (portable; replaces SQLite rowid for
  -- rewind/fork cuts so the dialect stays Postgres-compatible, L11/L17).
  seq             INTEGER NOT NULL DEFAULT 0,
  effect_type     TEXT NOT NULL,
  status          TEXT NOT NULL,
  version         TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  input_deps_json TEXT,
  key_set_hash    TEXT,
  result_inline   TEXT,
  result_artifact TEXT,
  session_token   TEXT,
  error_json      TEXT,
  started_at_ms   INTEGER,
  finished_at_ms  INTEGER,
  PRIMARY KEY (run_id, stable_key, attempt)
);

CREATE INDEX IF NOT EXISTS journal_by_run ON journal (run_id);

CREATE TABLE IF NOT EXISTS artifacts (
  hash          TEXT PRIMARY KEY,
  byte_len      INTEGER NOT NULL,
  ref_count     INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  data          BLOB
);

CREATE TABLE IF NOT EXISTS events (
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  emitted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS approvals (
  run_id            TEXT NOT NULL,
  stable_key        TEXT NOT NULL,
  status            TEXT NOT NULL,
  -- what the human is being asked (§17); persisted so a UI/API can render the
  -- decision without reading workflow source.
  prompt            TEXT,
  requested_caps_json TEXT,
  granted_caps_json TEXT,
  decided_by        TEXT,
  note              TEXT,
  requested_at_ms   INTEGER NOT NULL,
  decided_at_ms     INTEGER,
  PRIMARY KEY (run_id, stable_key)
);

CREATE TABLE IF NOT EXISTS signals (
  run_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  name           TEXT NOT NULL,
  correlation_id TEXT,
  payload_ref    TEXT,
  received_at_ms INTEGER NOT NULL,
  -- the ctx.signal call (stable key) that consumed this signal, NULL if pending.
  consumed_key   TEXT,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS timers (
  run_id     TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  fire_at_ms INTEGER NOT NULL,
  fired      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, stable_key)
);

CREATE TABLE IF NOT EXISTS schedules (
  name         TEXT PRIMARY KEY,
  workflow_ref TEXT NOT NULL,
  input_json   TEXT,
  interval_ms  INTEGER NOT NULL,
  next_fire_ms INTEGER NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_run_id  TEXT
);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  hash          TEXT PRIMARY KEY,
  name          TEXT,
  kind          TEXT NOT NULL,
  code          TEXT NOT NULL,
  source_map    TEXT,
  manifest_json TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS capabilities (
  id             TEXT PRIMARY KEY,
  secret_hash    TEXT NOT NULL UNIQUE,
  resource_json  TEXT NOT NULL,
  actions_json   TEXT NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  expires_at_ms  INTEGER,
  revoked_at_ms  INTEGER,
  note           TEXT
);
`;
