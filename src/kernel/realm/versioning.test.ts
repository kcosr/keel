// Phase 5: structural versions are computed and journaled in the realm — a
// comment edit leaves a step's version unchanged; a logic or schema edit changes
// it. (The resume-and-re-run-only-affected cascade is Phase 6.) Plus the lint gate.

import { describe, expect, test } from "bun:test";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const FIX = new URL("./fixtures/", import.meta.url);
const v1 = captureWorkflowFile(new URL("versioned-v1.workflow.ts", FIX).pathname);
const vComment = captureWorkflowFile(new URL("versioned-comment.workflow.ts", FIX).pathname);
const vLogic = captureWorkflowFile(new URL("versioned-logic.workflow.ts", FIX).pathname);
const badImportSource = 'import fs from "node:fs";\nexport default async () => fs;\n';

function fixed(store: JournalStore, extra: Record<string, unknown> = {}): RealmKernel {
  return new RealmKernel(store, {
    idgen: () => "r",
    clock: () => 1,
    rng: () => 0.5,
    ...extra,
  });
}

async function versionsOf(file: typeof v1): Promise<{ a: string; b: string }> {
  const store = JournalStore.memory();
  await fixed(store).run(file, { n: 4 }, { name: "v" });
  const a = store.getJournalRow("r", "a", 1);
  const b = store.getJournalRow("r", "b", 1);
  return { a: a?.version ?? "", b: b?.version ?? "" };
}

describe("structural versioning is journaled per step", () => {
  test("a comment-only edit to step a leaves BOTH steps' versions unchanged", async () => {
    const base = await versionsOf(v1);
    const commented = await versionsOf(vComment);
    expect(commented.a).toBe(base.a); // comment edit: no change
    expect(commented.b).toBe(base.b);
  });

  test("a logic edit to step b changes ONLY b's version", async () => {
    const base = await versionsOf(v1);
    const logic = await versionsOf(vLogic);
    expect(logic.a).toBe(base.a); // a unchanged
    expect(logic.b).not.toBe(base.b); // b's logic changed → version changed
  });
});

describe("realm determinism lint gate", () => {
  test("a forbidden import fails the run before it starts (no run row)", async () => {
    const store = JournalStore.memory();
    await expect(
      fixed(store).run({ source: badImportSource }, null, { name: "bad" }),
    ).rejects.toThrow(/workflow import "node:fs" from entry.ts is not allowed/);
    expect(store.listRuns()).toHaveLength(0);
  });

  test("lint disabled still does not bypass the source import allowlist", async () => {
    const store = JournalStore.memory();
    await expect(
      fixed(store, { lint: false }).run({ source: badImportSource }, null, { name: "bad" }),
    ).rejects.toThrow(/workflow import "node:fs" from entry.ts is not allowed/);
    expect(store.listRuns()).toHaveLength(0);
  });
});
