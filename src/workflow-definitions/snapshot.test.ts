import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JournalStore } from "../journal/store.ts";
import { snapshotWorkflowSource } from "./snapshot.ts";

describe("workflow definition snapshots", () => {
  test("@kcosr/keel externals link to the package root", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-sdk-"));
    try {
      const source = `
          import { passthrough } from "@kcosr/keel";
          const Schema = passthrough<number>();
          export default async function wf(ctx, input) {
            return ctx.step("compute", Schema, { n: input.n }, ({ n }) => n);
          }
        `;
      const store = JournalStore.memory();
      try {
        const cacheRoot = join(dir, "definitions");
        const { snapshot } = snapshotWorkflowSource(store, source, {
          name: "sdk",
          nowMs: 1,
          cacheRoot,
        });
        const link = join(cacheRoot, snapshot.hash, "node_modules", "@kcosr", "keel");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(resolve(readlinkSync(link))).toBe(resolve(import.meta.dir, "..", ".."));
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("relative imports escaping the workflow root fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-escape-"));
    try {
      const source = `
          import { value } from "../outside";
          export default async function wf() { return value; }
        `;
      const store = JournalStore.memory();
      try {
        expect(() =>
          snapshotWorkflowSource(store, source, {
            name: "escape",
            nowMs: 1,
            cacheRoot: join(dir, "definitions"),
          }),
        ).toThrow(/single self-contained file/);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-SDK imports and SDK subpaths fail closed", () => {
    const store = JournalStore.memory();
    try {
      expect(() =>
        snapshotWorkflowSource(store, 'import fs from "node:fs"; export default async () => fs;', {
          name: "builtin",
          nowMs: 1,
        }),
      ).toThrow(/not allowed/);
      expect(() =>
        snapshotWorkflowSource(
          store,
          'import { runExecuteScript } from "@kcosr/keel/execute"; export default async () => runExecuteScript;',
          { name: "subpath", nowMs: 1 },
        ),
      ).toThrow(/not allowed/);
    } finally {
      store.close();
    }
  });
});
