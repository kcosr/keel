import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JournalStore } from "../journal/store.ts";
import { snapshotWorkflowPath } from "./snapshot.ts";

describe("workflow definition snapshots", () => {
  test("@kcosr/keel externals link to the package root", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-sdk-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
      const workflow = join(dir, "wf.ts");
      writeFileSync(
        workflow,
        `
          import { passthrough } from "@kcosr/keel";
          const Schema = passthrough<number>();
          export default async function wf(ctx, input) {
            return ctx.step("compute", Schema, { n: input.n }, ({ n }) => n);
          }
        `,
      );
      const store = JournalStore.memory();
      try {
        const cacheRoot = join(dir, "definitions");
        const { snapshot } = snapshotWorkflowPath(store, workflow, {
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
      const root = join(dir, "root");
      mkdirSync(root);
      writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
      writeFileSync(join(dir, "outside.ts"), "export const value = 1;\n");
      const workflow = join(root, "wf.ts");
      writeFileSync(
        workflow,
        `
          import { value } from "../outside";
          export default async function wf() { return value; }
        `,
      );
      const store = JournalStore.memory();
      try {
        expect(() =>
          snapshotWorkflowPath(store, workflow, {
            name: "escape",
            nowMs: 1,
            cacheRoot: join(dir, "definitions"),
          }),
        ).toThrow(/escapes workflow root/);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
