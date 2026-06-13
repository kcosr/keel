import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore } from "./store.ts";
import type { NewRunRow } from "./types.ts";

function newRun(runId: string): NewRunRow {
  return {
    runId,
    workflowName: "demo",
    definitionVersion: "v1",
    status: "running",
    parentRunId: null,
    tenantId: null,
    inputRef: null,
    outputRef: null,
    errorJson: null,
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    createdAtMs: 1000,
  };
}

describe("JournalStore (in-memory)", () => {
  let store: JournalStore;
  beforeEach(() => {
    store = JournalStore.memory();
  });
  afterEach(() => store.close());

  test("runs round-trip", () => {
    store.insertRun(newRun("r1"));
    const got = store.getRun("r1");
    expect(got).not.toBeNull();
    expect(got?.workflowName).toBe("demo");
    expect(got?.status).toBe("running");
    expect(got?.finishedAtMs).toBeNull();
  });

  test("updateRun patches only named columns", () => {
    store.insertRun(newRun("r1"));
    store.updateRun("r1", { status: "finished", finishedAtMs: 2000 });
    const got = store.getRun("r1");
    expect(got?.status).toBe("finished");
    expect(got?.finishedAtMs).toBe(2000);
    expect(got?.workflowName).toBe("demo");
  });

  test("journal rows round-trip with defaults", () => {
    store.insertRun(newRun("r1"));
    store.putJournalRow({
      runId: "r1",
      stableKey: "plan",
      effectType: "pure",
      status: "completed",
      version: "v",
      inputHash: "h",
      resultInline: '{"ok":true}',
    });
    const row = store.getJournalRow("r1", "plan", 1);
    expect(row?.attempt).toBe(1);
    expect(row?.status).toBe("completed");
    expect(row?.resultInline).toBe('{"ok":true}');
    expect(row?.inputDeps).toBeNull();
  });

  test("upsert replaces row at the same (key, attempt)", () => {
    store.insertRun(newRun("r1"));
    store.putJournalRow({
      runId: "r1",
      stableKey: "plan",
      effectType: "pure",
      status: "pending",
      version: "v",
      inputHash: "h",
    });
    store.putJournalRow({
      runId: "r1",
      stableKey: "plan",
      effectType: "pure",
      status: "completed",
      version: "v",
      inputHash: "h",
      resultInline: "1",
    });
    expect(store.getJournalRow("r1", "plan", 1)?.status).toBe("completed");
  });

  test("getLatestAttempt returns the highest attempt", () => {
    store.insertRun(newRun("r1"));
    for (const attempt of [1, 2, 3]) {
      store.putJournalRow({
        runId: "r1",
        stableKey: "verify",
        attempt,
        effectType: "effectful",
        status: attempt === 3 ? "pending" : "failed",
        version: "v",
        inputHash: "h",
      });
    }
    const latest = store.getLatestAttempt("r1", "verify");
    expect(latest?.attempt).toBe(3);
    expect(latest?.status).toBe("pending");
  });

  test("inputDeps serialize through JSON", () => {
    store.insertRun(newRun("r1"));
    store.putJournalRow({
      runId: "r1",
      stableKey: "synth",
      effectType: "effectful",
      status: "completed",
      version: "v",
      inputHash: "h",
      inputDeps: [{ stepKey: "dedupe", contentHash: "abc" }],
    });
    expect(store.getJournalRow("r1", "synth", 1)?.inputDeps).toEqual([
      { stepKey: "dedupe", contentHash: "abc" },
    ]);
  });

  test("events get monotonic per-run seq", () => {
    store.insertRun(newRun("r1"));
    expect(store.appendEvent("r1", "started", { a: 1 }, 100)).toBe(1);
    expect(store.appendEvent("r1", "step", { a: 2 }, 101)).toBe(2);
    const evs = store.listEvents("r1");
    expect(evs.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.listEvents("r1", 1).map((e) => e.type)).toEqual(["step"]);
  });

  test("transaction rolls back fully on throw (zero partial rows)", () => {
    store.insertRun(newRun("r1"));
    expect(() =>
      store.transaction(() => {
        store.putJournalRow({
          runId: "r1",
          stableKey: "a",
          effectType: "pure",
          status: "completed",
          version: "v",
          inputHash: "h",
        });
        store.putJournalRow({
          runId: "r1",
          stableKey: "b",
          effectType: "pure",
          status: "completed",
          version: "v",
          inputHash: "h",
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.listJournalRows("r1")).toHaveLength(0);
  });

  test("transaction commits all rows on success", () => {
    store.insertRun(newRun("r1"));
    store.transaction(() => {
      store.putJournalRow({
        runId: "r1",
        stableKey: "a",
        effectType: "pure",
        status: "completed",
        version: "v",
        inputHash: "h",
      });
      store.putJournalRow({
        runId: "r1",
        stableKey: "b",
        effectType: "pure",
        status: "completed",
        version: "v",
        inputHash: "h",
      });
    });
    expect(store.listJournalRows("r1")).toHaveLength(2);
  });
});

describe("JournalStore (file-backed durability)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keel-journal-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("rows survive close + reopen and reload identically", () => {
    const path = join(dir, "keel.db");
    const a = JournalStore.open(path);
    a.insertRun(newRun("r1"));
    a.putJournalRow({
      runId: "r1",
      stableKey: "plan",
      effectType: "pure",
      status: "completed",
      version: "v1",
      inputHash: "hash123",
      resultInline: '{"answer":42}',
      inputDeps: [{ stepKey: "x", contentHash: "y" }],
    });
    a.appendEvent("r1", "done", { ok: true }, 5);
    a.close();

    // Simulate a process restart: a fresh store on the same file.
    const b = JournalStore.open(path);
    expect(b.getRun("r1")?.workflowName).toBe("demo");
    const row = b.getJournalRow("r1", "plan", 1);
    expect(row?.resultInline).toBe('{"answer":42}');
    expect(row?.inputHash).toBe("hash123");
    expect(row?.inputDeps).toEqual([{ stepKey: "x", contentHash: "y" }]);
    expect(b.listEvents("r1")).toHaveLength(1);
    b.close();
  });

  test("a committed transaction is durable; an aborted one leaves nothing", () => {
    const path = join(dir, "keel.db");
    const a = JournalStore.open(path);
    a.insertRun(newRun("r1"));
    a.transaction(() => {
      a.putJournalRow({
        runId: "r1",
        stableKey: "committed",
        effectType: "pure",
        status: "completed",
        version: "v",
        inputHash: "h",
      });
    });
    try {
      a.transaction(() => {
        a.putJournalRow({
          runId: "r1",
          stableKey: "rolled-back",
          effectType: "pure",
          status: "completed",
          version: "v",
          inputHash: "h",
        });
        throw new Error("abort");
      });
    } catch {
      // expected
    }
    a.close();

    const b = JournalStore.open(path);
    const keys = b.listJournalRows("r1").map((r) => r.stableKey);
    expect(keys).toEqual(["committed"]);
    b.close();
  });
});
