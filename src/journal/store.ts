// JournalStore — the durable substrate (DESIGN.md §8, Appendix A).
//
// The single-writer daemon owns one of these; clients never touch SQLite
// directly (L3). This class is deliberately low-level: it persists and reads
// rows and exposes one transaction primitive. Memoization/resume logic lives in
// the kernel (Phase 2), not here.

import { Database } from "bun:sqlite";
import { applyMigration } from "./migrations.ts";
import { DDL, SCHEMA_VERSION } from "./schema.ts";
import type {
  ArtifactRow,
  EventRow,
  InputDep,
  JournalRow,
  NewJournalRow,
  NewRunRow,
  RunRow,
} from "./types.ts";

export class JournalStore {
  readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
    this.migrate();
  }

  /** Open (or create) a file-backed journal in WAL mode at a stable path. */
  static open(path: string): JournalStore {
    const db = new Database(path, { create: true });
    // WAL is what makes a single-writer + many-reader file safe (L11). The
    // daemon's exclusive-writer property is enforced above this layer.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    return new JournalStore(db);
  }

  /** In-memory journal for tests. */
  static memory(): JournalStore {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    return new JournalStore(db);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    // Base DDL creates any missing tables at the current shape; it is a no-op for
    // tables that already exist (CREATE TABLE IF NOT EXISTS).
    this.db.exec(DDL);
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = ?")
      .get("schema_version");
    if (row === null) {
      // Fresh DB — base DDL already built everything at the current version.
      this.db
        .query("INSERT INTO schema_meta (key, value) VALUES (?, ?)")
        .run("schema_version", String(SCHEMA_VERSION));
      return;
    }
    let version = Number(row.value);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `journal is newer (v${version}) than this code (v${SCHEMA_VERSION}); cannot downgrade`,
      );
    }
    // Migrate forward additively (no data loss) rather than refusing to open.
    this.transaction(() => {
      while (version < SCHEMA_VERSION) {
        applyMigration(this.db, version);
        version += 1;
      }
      if (Number(row.value) !== SCHEMA_VERSION) {
        this.db
          .query("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'")
          .run(String(SCHEMA_VERSION));
      }
    });
  }

  /**
   * Run `fn` inside a single SQLite transaction. If `fn` throws, the
   * transaction rolls back and no partial rows persist (Phase 1 exit criterion).
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- runs ---------------------------------------------------------------

  insertRun(row: NewRunRow): void {
    this.db
      .query(
        `INSERT INTO runs (
           run_id, workflow_name, definition_version, workflow_ref, status, parent_run_id,
           tenant_id, input_ref, output_ref, error_json, heartbeat_at_ms,
           runtime_owner_id, created_at_ms, finished_at_ms
         ) VALUES (
           $runId, $workflowName, $definitionVersion, $workflowRef, $status, $parentRunId,
           $tenantId, $inputRef, $outputRef, $errorJson, $heartbeatAtMs,
           $runtimeOwnerId, $createdAtMs, $finishedAtMs
         )`,
      )
      .run({
        $runId: row.runId,
        $workflowName: row.workflowName,
        $definitionVersion: row.definitionVersion,
        $workflowRef: row.workflowRef ?? null,
        $status: row.status,
        $parentRunId: row.parentRunId,
        $tenantId: row.tenantId,
        $inputRef: row.inputRef,
        $outputRef: row.outputRef,
        $errorJson: row.errorJson,
        $heartbeatAtMs: row.heartbeatAtMs,
        $runtimeOwnerId: row.runtimeOwnerId,
        $createdAtMs: row.createdAtMs,
        $finishedAtMs: row.finishedAtMs ?? null,
      });
  }

  getRun(runId: string): RunRow | null {
    const r = this.db.query<RawRunRow, [string]>("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return r ? mapRun(r) : null;
  }

  /** Patch a subset of mutable run columns. */
  updateRun(
    runId: string,
    patch: Partial<
      Pick<
        RunRow,
        | "status"
        | "inputRef"
        | "outputRef"
        | "errorJson"
        | "heartbeatAtMs"
        | "runtimeOwnerId"
        | "finishedAtMs"
      >
    >,
  ): void {
    const sets: string[] = [];
    type Bind = string | number | bigint | boolean | null | Uint8Array;
    const params: Record<string, Bind> = { $runId: runId };
    const add = (col: string, key: string, val: Bind) => {
      sets.push(`${col} = $${key}`);
      params[`$${key}`] = val;
    };
    if ("status" in patch) add("status", "status", patch.status ?? null);
    if ("inputRef" in patch) add("input_ref", "inputRef", patch.inputRef ?? null);
    if ("outputRef" in patch) add("output_ref", "outputRef", patch.outputRef ?? null);
    if ("errorJson" in patch) add("error_json", "errorJson", patch.errorJson ?? null);
    if ("heartbeatAtMs" in patch)
      add("heartbeat_at_ms", "heartbeatAtMs", patch.heartbeatAtMs ?? null);
    if ("runtimeOwnerId" in patch)
      add("runtime_owner_id", "runtimeOwnerId", patch.runtimeOwnerId ?? null);
    if ("finishedAtMs" in patch) add("finished_at_ms", "finishedAtMs", patch.finishedAtMs ?? null);
    if (sets.length === 0) return;
    this.db.query(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = $runId`).run(params);
  }

  listRuns(): RunRow[] {
    return this.db
      .query<RawRunRow, []>("SELECT * FROM runs ORDER BY created_at_ms ASC")
      .all()
      .map(mapRun);
  }

  listRunsByStatus(status: RunRow["status"]): RunRow[] {
    return this.db
      .query<RawRunRow, [string]>("SELECT * FROM runs WHERE status = ? ORDER BY created_at_ms ASC")
      .all(status)
      .map(mapRun);
  }

  /**
   * Compare-and-set ownership fence (DESIGN.md §6.3/§7.4). Claim a run for
   * `ownerId` only if it is currently unowned, already ours, or owned by a stale
   * owner (heartbeat older than `staleBeforeMs`). Returns true if we now own it.
   */
  claimRun(runId: string, ownerId: string, staleBeforeMs: number, atMs: number): boolean {
    const res = this.db
      .query(
        `UPDATE runs SET runtime_owner_id = $owner, heartbeat_at_ms = $now
         WHERE run_id = $runId
           AND (runtime_owner_id IS NULL
                OR runtime_owner_id = $owner
                OR heartbeat_at_ms IS NULL
                OR heartbeat_at_ms < $stale)`,
      )
      .run({ $owner: ownerId, $now: atMs, $runId: runId, $stale: staleBeforeMs });
    return res.changes > 0;
  }

  /** Refresh the heartbeat for runs this owner drives (liveness fence). */
  heartbeat(runId: string, ownerId: string, atMs: number): void {
    this.db
      .query("UPDATE runs SET heartbeat_at_ms = ? WHERE run_id = ? AND runtime_owner_id = ?")
      .run(atMs, runId, ownerId);
  }

  // ---- journal ------------------------------------------------------------

  /** Upsert a journal row by (run_id, stable_key, attempt). */
  putJournalRow(row: NewJournalRow): void {
    const full = withJournalDefaults(row);
    // Assign a per-run monotonic seq on first insert; DO UPDATE keeps it.
    const nextSeq =
      (this.db
        .query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM journal WHERE run_id = ?")
        .get(full.runId)?.m ?? 0) + 1;
    this.db
      .query(
        `INSERT INTO journal (
           run_id, stable_key, attempt, seq, effect_type, status, version,
           input_hash, input_deps_json, key_set_hash, result_inline,
           result_artifact, session_token, error_json, started_at_ms,
           finished_at_ms
         ) VALUES (
           $runId, $stableKey, $attempt, $seq, $effectType, $status, $version,
           $inputHash, $inputDepsJson, $keySetHash, $resultInline,
           $resultArtifact, $sessionToken, $errorJson, $startedAtMs,
           $finishedAtMs
         )
         ON CONFLICT (run_id, stable_key, attempt) DO UPDATE SET
           effect_type     = excluded.effect_type,
           status          = excluded.status,
           version         = excluded.version,
           input_hash      = excluded.input_hash,
           input_deps_json = excluded.input_deps_json,
           key_set_hash    = excluded.key_set_hash,
           result_inline   = excluded.result_inline,
           result_artifact = excluded.result_artifact,
           session_token   = excluded.session_token,
           error_json      = excluded.error_json,
           started_at_ms   = excluded.started_at_ms,
           finished_at_ms  = excluded.finished_at_ms`,
      )
      .run({
        $runId: full.runId,
        $stableKey: full.stableKey,
        $attempt: full.attempt,
        $seq: nextSeq,
        $effectType: full.effectType,
        $status: full.status,
        $version: full.version,
        $inputHash: full.inputHash,
        $inputDepsJson: full.inputDeps ? JSON.stringify(full.inputDeps) : null,
        $keySetHash: full.keySetHash,
        $resultInline: full.resultInline,
        $resultArtifact: full.resultArtifact,
        $sessionToken: full.sessionToken,
        $errorJson: full.errorJson,
        $startedAtMs: full.startedAtMs,
        $finishedAtMs: full.finishedAtMs,
      });
  }

  getJournalRow(runId: string, stableKey: string, attempt: number): JournalRow | null {
    const r = this.db
      .query<RawJournalRow, [string, string, number]>(
        "SELECT * FROM journal WHERE run_id = ? AND stable_key = ? AND attempt = ?",
      )
      .get(runId, stableKey, attempt);
    return r ? mapJournal(r) : null;
  }

  /** The highest-attempt row for a key — the one memoization consults (§5.5). */
  getLatestAttempt(runId: string, stableKey: string): JournalRow | null {
    const r = this.db
      .query<RawJournalRow, [string, string]>(
        `SELECT * FROM journal WHERE run_id = ? AND stable_key = ?
         ORDER BY attempt DESC LIMIT 1`,
      )
      .get(runId, stableKey);
    return r ? mapJournal(r) : null;
  }

  listJournalRows(runId: string): JournalRow[] {
    return this.db
      .query<RawJournalRow, [string]>(
        "SELECT * FROM journal WHERE run_id = ? ORDER BY stable_key, attempt",
      )
      .all(runId)
      .map(mapJournal);
  }

  // ---- events -------------------------------------------------------------

  /** Append an event; returns the assigned per-run sequence number. */
  appendEvent(runId: string, type: string, payload: unknown, atMs: number): number {
    const next = this.db
      .query<{ next: number }, [string]>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE run_id = ?",
      )
      .get(runId);
    const seq = next?.next ?? 1;
    this.db
      .query(
        `INSERT INTO events (run_id, seq, type, payload_json, emitted_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, seq, type, JSON.stringify(payload ?? null), atMs);
    return seq;
  }

  listEvents(runId: string, afterSeq = 0): EventRow[] {
    return this.db
      .query<RawEventRow, [string, number]>(
        "SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
      )
      .all(runId, afterSeq)
      .map(mapEvent);
  }

  // ---- artifacts (two-tier store, Phase 8) --------------------------------

  getArtifact(hash: string): ArtifactRow | null {
    const r = this.db
      .query<RawArtifactRow, [string]>("SELECT * FROM artifacts WHERE hash = ?")
      .get(hash);
    return r ? mapArtifact(r) : null;
  }

  /** Content-addressed put: insert a new blob (refCount 1) or bump the refCount
   * of an existing one (dedup). */
  putArtifact(hash: string, data: Uint8Array, atMs: number): void {
    const existing = this.db
      .query<{ ref_count: number }, [string]>("SELECT ref_count FROM artifacts WHERE hash = ?")
      .get(hash);
    if (existing) {
      this.db.query("UPDATE artifacts SET ref_count = ref_count + 1 WHERE hash = ?").run(hash);
    } else {
      this.db
        .query(
          "INSERT INTO artifacts (hash, byte_len, ref_count, created_at_ms, data) VALUES (?, ?, 1, ?, ?)",
        )
        .run(hash, data.byteLength, atMs, data);
    }
  }

  /** The raw bytes of an artifact, or null. */
  getArtifactData(hash: string): Uint8Array | null {
    const r = this.db
      .query<{ data: Uint8Array | null }, [string]>("SELECT data FROM artifacts WHERE hash = ?")
      .get(hash);
    return r?.data ?? null;
  }

  // ---- timers (durable ctx.sleep, §16) -----------------------------------

  /** Record (or return the existing) timer for a sleep; idempotent on resume. */
  upsertTimer(
    runId: string,
    stableKey: string,
    fireAtMs: number,
  ): { fireAtMs: number; fired: boolean } {
    const existing = this.db
      .query<{ fire_at_ms: number; fired: number }, [string, string]>(
        "SELECT fire_at_ms, fired FROM timers WHERE run_id = ? AND stable_key = ?",
      )
      .get(runId, stableKey);
    if (existing) return { fireAtMs: existing.fire_at_ms, fired: existing.fired === 1 };
    this.db
      .query("INSERT INTO timers (run_id, stable_key, fire_at_ms, fired) VALUES (?, ?, ?, 0)")
      .run(runId, stableKey, fireAtMs);
    return { fireAtMs, fired: false };
  }

  markTimerFired(runId: string, stableKey: string): void {
    this.db
      .query("UPDATE timers SET fired = 1 WHERE run_id = ? AND stable_key = ?")
      .run(runId, stableKey);
  }

  /** Distinct run ids with an unfired timer due at or before `nowMs`. */
  dueTimerRunIds(nowMs: number): string[] {
    return this.db
      .query<{ run_id: string }, [number]>(
        "SELECT DISTINCT run_id FROM timers WHERE fired = 0 AND fire_at_ms <= ?",
      )
      .all(nowMs)
      .map((r) => r.run_id);
  }

  // ---- schedules (cron, §16) ---------------------------------------------

  putSchedule(s: {
    name: string;
    workflowRef: string;
    inputJson: string | null;
    intervalMs: number;
    nextFireMs: number;
  }): void {
    this.db
      .query(
        `INSERT INTO schedules (name, workflow_ref, input_json, interval_ms, next_fire_ms, enabled)
         VALUES ($name, $ref, $input, $interval, $next, 1)
         ON CONFLICT(name) DO UPDATE SET
           workflow_ref = $ref, input_json = $input, interval_ms = $interval, next_fire_ms = $next, enabled = 1`,
      )
      .run({
        $name: s.name,
        $ref: s.workflowRef,
        $input: s.inputJson,
        $interval: s.intervalMs,
        $next: s.nextFireMs,
      });
  }

  dueSchedules(nowMs: number): Array<{
    name: string;
    workflowRef: string;
    inputJson: string | null;
    intervalMs: number;
    nextFireMs: number;
  }> {
    return this.db
      .query<
        {
          name: string;
          workflow_ref: string;
          input_json: string | null;
          interval_ms: number;
          next_fire_ms: number;
        },
        [number]
      >("SELECT * FROM schedules WHERE enabled = 1 AND next_fire_ms <= ?")
      .all(nowMs)
      .map((r) => ({
        name: r.name,
        workflowRef: r.workflow_ref,
        inputJson: r.input_json,
        intervalMs: r.interval_ms,
        nextFireMs: r.next_fire_ms,
      }));
  }

  advanceSchedule(name: string, nextFireMs: number, lastRunId: string): void {
    this.db
      .query("UPDATE schedules SET next_fire_ms = ?, last_run_id = ? WHERE name = ?")
      .run(nextFireMs, lastRunId, name);
  }

  // ---- time travel (retry/rewind/fork, §18) ------------------------------

  /** Delete the failed rows of a run (retry: the failed step re-executes). */
  deleteFailedRows(runId: string): void {
    this.db.query("DELETE FROM journal WHERE run_id = ? AND status = 'failed'").run(runId);
  }

  /** Delete everything journaled AFTER a target step (rewind to that step). */
  /**
   * Rewind a run's durable state to a target step (§18). Deletes journal rows
   * AFTER the target's seq, decrements artifact refcounts for the discarded rows,
   * and clears UNRESOLVED transient waits (unfired timers, pending approvals,
   * unconsumed signals) so re-execution re-parks fresh. RESOLVED waits (fired
   * timers, decided approvals, consumed signals) are preserved — the journal
   * replay and resolved-wait replay rely on them. Events are append-only history
   * (a run.rewind marker is appended by the caller); they are not trimmed.
   */
  deleteRunStateAfter(runId: string, stableKey: string): void {
    this.transaction(() => {
      const cut = this.db
        .query<{ m: number | null }, [string, string]>(
          "SELECT MAX(seq) AS m FROM journal WHERE run_id = ? AND stable_key = ?",
        )
        .get(runId, stableKey)?.m;
      if (cut == null) return;
      // decrement refcounts for artifact-backed rows about to be discarded
      const orphans = this.db
        .query<{ result_artifact: string }, [string, number]>(
          "SELECT DISTINCT result_artifact FROM journal WHERE run_id = ? AND seq > ? AND result_artifact IS NOT NULL",
        )
        .all(runId, cut);
      for (const o of orphans) this.decrementArtifactRefcount(o.result_artifact);
      this.db.query("DELETE FROM journal WHERE run_id = ? AND seq > ?").run(runId, cut);
      // clear unresolved waits — the run no longer parks where it did
      this.db.query("DELETE FROM timers WHERE run_id = ? AND fired = 0").run(runId);
      this.db.query("DELETE FROM approvals WHERE run_id = ? AND status = 'pending'").run(runId);
      this.db.query("DELETE FROM signals WHERE run_id = ? AND consumed_key IS NULL").run(runId);
    });
  }

  decrementArtifactRefcount(hash: string): void {
    // CASE, not MAX() — MAX is an aggregate in Postgres; keep the dialect portable.
    this.db
      .query(
        "UPDATE artifacts SET ref_count = CASE WHEN ref_count > 0 THEN ref_count - 1 ELSE 0 END WHERE hash = ?",
      )
      .run(hash);
  }

  /**
   * Fork a run into a new independent run sharing the journal prefix (up to
   * `atStableKey` inclusive, or the whole journal). The new run can then be
   * resumed/rerun to diverge. Artifact refcounts are bumped for shared blobs.
   */
  forkRun(srcRunId: string, newRunId: string, atStableKey: string | null, atMs: number): void {
    const src = this.getRun(srcRunId);
    if (!src) throw new Error(`fork source run ${srcRunId} not found`);
    this.transaction(() => {
      this.insertRun({
        runId: newRunId,
        workflowName: src.workflowName,
        definitionVersion: src.definitionVersion,
        workflowRef: src.workflowRef,
        status: "running",
        parentRunId: srcRunId,
        tenantId: src.tenantId,
        inputRef: src.inputRef,
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: atMs,
      });
      const cutoff = atStableKey
        ? (this.db
            .query<{ m: number | null }, [string, string]>(
              "SELECT MAX(seq) AS m FROM journal WHERE run_id = ? AND stable_key = ?",
            )
            .get(srcRunId, atStableKey)?.m ?? null)
        : null;
      const rows = this.db
        .query<RawJournalRow, [string]>("SELECT * FROM journal WHERE run_id = ? ORDER BY seq ASC")
        .all(srcRunId)
        .filter((r) => cutoff === null || r.seq <= cutoff)
        .map(mapJournal);
      for (const r of rows) {
        this.putJournalRow({ ...r, runId: newRunId });
        if (r.resultArtifact) this.incrementArtifactRefcount(r.resultArtifact);
      }
      // Copy the source's RESOLVED durable-wait history ONLY for a FULL fork.
      // Durable waits (sleep/human/signal) aren't journal rows and carry no seq,
      // so for a PARTIAL fork (atStableKey set) we can't tell which waits fall
      // before vs after the cut — copying all of them could drag a post-cutoff
      // wait into the prefix. A full fork is an exact, terminal-source clone where
      // every wait is resolved, so copying is safe and correct. A partial fork
      // re-encounters any prefix waits fresh on rerun (documented, §18).
      if (cutoff === null) {
        this.db
          .query(
            `INSERT INTO timers (run_id, stable_key, fire_at_ms, fired)
             SELECT ?, stable_key, fire_at_ms, fired FROM timers WHERE run_id = ?`,
          )
          .run(newRunId, srcRunId);
        this.db
          .query(
            `INSERT INTO approvals (run_id, stable_key, status, prompt, requested_caps_json, granted_caps_json, decided_by, note, requested_at_ms, decided_at_ms)
             SELECT ?, stable_key, status, prompt, requested_caps_json, granted_caps_json, decided_by, note, requested_at_ms, decided_at_ms FROM approvals WHERE run_id = ?`,
          )
          .run(newRunId, srcRunId);
        this.db
          .query(
            `INSERT INTO signals (run_id, seq, name, correlation_id, payload_ref, received_at_ms, consumed_key)
             SELECT ?, seq, name, correlation_id, payload_ref, received_at_ms, consumed_key FROM signals WHERE run_id = ?`,
          )
          .run(newRunId, srcRunId);
      }
    });
  }

  incrementArtifactRefcount(hash: string): void {
    this.db.query("UPDATE artifacts SET ref_count = ref_count + 1 WHERE hash = ?").run(hash);
  }

  /**
   * Reclaim artifacts no journal row references (§19). Refcounts are recomputed
   * from the journal (the source of truth — so it self-heals after rewind/fork
   * deletes), then zero-ref blobs are dropped. Returns the count removed.
   */
  gcArtifacts(): number {
    this.db.exec(
      `UPDATE artifacts SET ref_count =
         (SELECT COUNT(*) FROM journal WHERE journal.result_artifact = artifacts.hash)`,
    );
    const removed =
      this.db
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM artifacts WHERE ref_count <= 0")
        .get()?.c ?? 0;
    this.db.exec("DELETE FROM artifacts WHERE ref_count <= 0");
    return removed;
  }

  // ---- approvals (ctx.human, §17) ----------------------------------------

  /** Record a pending approval request (idempotent on resume). */
  requestApproval(
    runId: string,
    stableKey: string,
    request: { prompt: string; requestedCaps?: unknown },
    atMs: number,
  ): void {
    // Persist WHAT the human is being asked so a UI/API can render it without
    // reading workflow source (§17). Idempotent on resume (DO NOTHING).
    this.db
      .query(
        `INSERT INTO approvals (run_id, stable_key, status, prompt, requested_caps_json, requested_at_ms)
         VALUES (?, ?, 'pending', ?, ?, ?)
         ON CONFLICT (run_id, stable_key) DO NOTHING`,
      )
      .run(
        runId,
        stableKey,
        request.prompt,
        request.requestedCaps != null ? JSON.stringify(request.requestedCaps) : null,
        atMs,
      );
  }

  decideApproval(
    runId: string,
    stableKey: string,
    decision: {
      status: "approved" | "denied";
      note?: string;
      grantedCaps?: unknown;
      decidedBy?: string;
    },
    atMs: number,
  ): void {
    this.db
      .query(
        `UPDATE approvals SET status = ?, note = ?, granted_caps_json = ?, decided_by = ?, decided_at_ms = ?
         WHERE run_id = ? AND stable_key = ?`,
      )
      .run(
        decision.status,
        decision.note ?? null,
        decision.grantedCaps != null ? JSON.stringify(decision.grantedCaps) : null,
        decision.decidedBy ?? null,
        atMs,
        runId,
        stableKey,
      );
  }

  getApproval(
    runId: string,
    stableKey: string,
  ): {
    status: string;
    prompt: string | null;
    requestedCaps: unknown;
    note: string | null;
    grantedCaps: unknown;
  } | null {
    const r = this.db
      .query<
        {
          status: string;
          prompt: string | null;
          requested_caps_json: string | null;
          note: string | null;
          granted_caps_json: string | null;
        },
        [string, string]
      >(
        "SELECT status, prompt, requested_caps_json, note, granted_caps_json FROM approvals WHERE run_id = ? AND stable_key = ?",
      )
      .get(runId, stableKey);
    if (!r) return null;
    return {
      status: r.status,
      prompt: r.prompt,
      requestedCaps: r.requested_caps_json ? JSON.parse(r.requested_caps_json) : null,
      note: r.note,
      grantedCaps: r.granted_caps_json ? JSON.parse(r.granted_caps_json) : null,
    };
  }

  /** All pending approvals for a run (for projection / UI). */
  listPendingApprovals(
    runId: string,
  ): Array<{ stableKey: string; prompt: string | null; requestedCaps: unknown }> {
    return this.db
      .query<
        { stable_key: string; prompt: string | null; requested_caps_json: string | null },
        [string]
      >(
        "SELECT stable_key, prompt, requested_caps_json FROM approvals WHERE run_id = ? AND status = 'pending'",
      )
      .all(runId)
      .map((r) => ({
        stableKey: r.stable_key,
        prompt: r.prompt,
        requestedCaps: r.requested_caps_json ? JSON.parse(r.requested_caps_json) : null,
      }));
  }

  // ---- signals (ctx.signal, §17) -----------------------------------------

  /** Deliver an external signal to a run (appended; consumed by a ctx.signal call). */
  putSignal(runId: string, name: string, payload: unknown, atMs: number): void {
    const next =
      (this.db
        .query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM signals WHERE run_id = ?")
        .get(runId)?.m ?? 0) + 1;
    this.db
      .query(
        "INSERT INTO signals (run_id, seq, name, payload_ref, received_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, next, name, payload != null ? JSON.stringify(payload) : null, atMs);
  }

  /** The signal already consumed by a given ctx.signal call (replay path). */
  signalConsumedBy(runId: string, consumedKey: string): { payload: unknown } | null {
    const r = this.db
      .query<{ payload_ref: string | null }, [string, string]>(
        "SELECT payload_ref FROM signals WHERE run_id = ? AND consumed_key = ?",
      )
      .get(runId, consumedKey);
    if (!r) return null;
    return { payload: r.payload_ref ? JSON.parse(r.payload_ref) : null };
  }

  /** Consume the oldest pending signal of `name` for `consumedKey`; null if none. */
  consumeSignal(runId: string, name: string, consumedKey: string): { payload: unknown } | null {
    const r = this.db
      .query<{ seq: number; payload_ref: string | null }, [string, string]>(
        "SELECT seq, payload_ref FROM signals WHERE run_id = ? AND name = ? AND consumed_key IS NULL ORDER BY seq ASC LIMIT 1",
      )
      .get(runId, name);
    if (!r) return null;
    this.db
      .query("UPDATE signals SET consumed_key = ? WHERE run_id = ? AND seq = ?")
      .run(consumedKey, runId, r.seq);
    return { payload: r.payload_ref ? JSON.parse(r.payload_ref) : null };
  }
}

function withJournalDefaults(row: NewJournalRow): JournalRow {
  return {
    attempt: 1,
    inputDeps: null,
    keySetHash: null,
    resultInline: null,
    resultArtifact: null,
    sessionToken: null,
    errorJson: null,
    startedAtMs: null,
    finishedAtMs: null,
    ...row,
  };
}

// ---- raw row shapes + mappers ---------------------------------------------

interface RawRunRow {
  run_id: string;
  workflow_name: string;
  definition_version: string;
  workflow_ref: string | null;
  status: string;
  parent_run_id: string | null;
  tenant_id: string | null;
  input_ref: string | null;
  output_ref: string | null;
  error_json: string | null;
  heartbeat_at_ms: number | null;
  runtime_owner_id: string | null;
  created_at_ms: number;
  finished_at_ms: number | null;
}

interface RawJournalRow {
  run_id: string;
  stable_key: string;
  attempt: number;
  seq: number;
  effect_type: string;
  status: string;
  version: string;
  input_hash: string;
  input_deps_json: string | null;
  key_set_hash: string | null;
  result_inline: string | null;
  result_artifact: string | null;
  session_token: string | null;
  error_json: string | null;
  started_at_ms: number | null;
  finished_at_ms: number | null;
}

interface RawEventRow {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
  emitted_at_ms: number;
}

interface RawArtifactRow {
  hash: string;
  byte_len: number;
  ref_count: number;
  created_at_ms: number;
  data: Uint8Array | null;
}

function mapRun(r: RawRunRow): RunRow {
  return {
    runId: r.run_id,
    workflowName: r.workflow_name,
    definitionVersion: r.definition_version,
    workflowRef: r.workflow_ref,
    status: r.status as RunRow["status"],
    parentRunId: r.parent_run_id,
    tenantId: r.tenant_id,
    inputRef: r.input_ref,
    outputRef: r.output_ref,
    errorJson: r.error_json,
    heartbeatAtMs: r.heartbeat_at_ms,
    runtimeOwnerId: r.runtime_owner_id,
    createdAtMs: r.created_at_ms,
    finishedAtMs: r.finished_at_ms,
  };
}

function mapJournal(r: RawJournalRow): JournalRow {
  return {
    runId: r.run_id,
    stableKey: r.stable_key,
    attempt: r.attempt,
    effectType: r.effect_type as JournalRow["effectType"],
    status: r.status as JournalRow["status"],
    version: r.version,
    inputHash: r.input_hash,
    inputDeps: r.input_deps_json ? (JSON.parse(r.input_deps_json) as InputDep[]) : null,
    keySetHash: r.key_set_hash,
    resultInline: r.result_inline,
    resultArtifact: r.result_artifact,
    sessionToken: r.session_token,
    errorJson: r.error_json,
    startedAtMs: r.started_at_ms,
    finishedAtMs: r.finished_at_ms,
  };
}

function mapEvent(r: RawEventRow): EventRow {
  return {
    runId: r.run_id,
    seq: r.seq,
    type: r.type,
    payloadJson: r.payload_json,
    emittedAtMs: r.emitted_at_ms,
  };
}

function mapArtifact(r: RawArtifactRow): ArtifactRow {
  return {
    hash: r.hash,
    byteLen: r.byte_len,
    refCount: r.ref_count,
    createdAtMs: r.created_at_ms,
    data: r.data,
  };
}
