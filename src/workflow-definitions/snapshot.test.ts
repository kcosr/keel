import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JournalStore } from "../journal/store.ts";
import {
  evictWorkflowDefinitionCache,
  materializeWorkflowDefinition,
  resolveKeelPackageRoot,
  snapshotWorkflowSource,
} from "./snapshot.ts";

describe("workflow definition snapshots", () => {
  test("resolves the Keel package root from the source module location", () => {
    expect(resolveKeelPackageRoot({ moduleUrl: import.meta.url })).toBe(
      resolve(import.meta.dir, "..", ".."),
    );
  });

  test("bundled module paths fall back to real runtime paths without accepting filesystem root", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-package-root-"));
    try {
      const packageRoot = join(dir, "keel");
      mkdirSync(join(packageRoot, "src"), { recursive: true });
      mkdirSync(join(packageRoot, "dist"), { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), '{"name":"@kcosr/keel"}\n');
      writeFileSync(join(packageRoot, "src", "sdk.ts"), "export {};\n");
      writeFileSync(join(packageRoot, "dist", "keel"), "");

      expect(
        resolveKeelPackageRoot({
          moduleUrl: "file:///$bunfs/root/keel",
          cwd: "/",
          argv1: join(packageRoot, "dist", "keel"),
          execPath: "/usr/bin/bun",
        }),
      ).toBe(packageRoot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails with an actionable error when no candidate resolves", () => {
    expect(() =>
      resolveKeelPackageRoot({
        moduleUrl: "file:///$bunfs/root/keel",
        cwd: "/",
        argv1: "/",
        execPath: "/",
      }),
    ).toThrow("set KEEL_PACKAGE_ROOT to the repository root");
  });

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
        expect(readFileSync(join(cacheRoot, snapshot.hash, "entry.ts"), "utf8")).toContain(
          'from "./node_modules/@kcosr/keel/src/sdk.ts"',
        );
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

  test("materialization recovers from a partial cache directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-partial-"));
    const store = JournalStore.memory();
    try {
      const cacheRoot = join(dir, "definitions");
      const source = "export default async function wf() { return 1; }\n";
      const { snapshot } = snapshotWorkflowSource(store, source, {
        name: "partial",
        nowMs: 1,
        cacheRoot,
      });
      const root = join(cacheRoot, snapshot.hash);
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "partial.txt"), "incomplete");

      const entry = materializeWorkflowDefinition(store, snapshot.hash, cacheRoot);
      expect(readFileSync(entry, "utf8")).toBe(source);
      expect(existsSync(join(root, "partial.txt"))).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("materialization rebuilds a cache directory missing external links", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-link-"));
    const store = JournalStore.memory();
    try {
      const cacheRoot = join(dir, "definitions");
      const source =
        'import { passthrough } from "@kcosr/keel";\nexport default async () => passthrough();\n';
      const { snapshot } = snapshotWorkflowSource(store, source, {
        name: "link",
        nowMs: 1,
        cacheRoot,
      });
      const link = join(cacheRoot, snapshot.hash, "node_modules", "@kcosr", "keel");
      rmSync(link, { recursive: true, force: true });

      materializeWorkflowDefinition(store, snapshot.hash, cacheRoot);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cached materialization still validates external package integrity", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-integrity-"));
    const store = JournalStore.memory();
    try {
      const cacheRoot = join(dir, "definitions");
      const source =
        'import { passthrough } from "@kcosr/keel";\nexport default async () => passthrough();\n';
      const { snapshot } = snapshotWorkflowSource(store, source, {
        name: "integrity",
        nowMs: 1,
        cacheRoot,
      });
      const row = store.getWorkflowDefinition(snapshot.hash);
      if (!row?.manifestJson) throw new Error("missing workflow definition manifest");
      const manifest = JSON.parse(row.manifestJson) as {
        externalPackages: Array<{ integrity: string }>;
      };
      const pinned = manifest.externalPackages[0];
      if (!pinned) throw new Error("missing external package pin");
      pinned.integrity = "sha256-bad";
      store.db
        .query("UPDATE workflow_definitions SET manifest_json = ? WHERE hash = ?")
        .run(JSON.stringify(manifest), snapshot.hash);

      expect(() => materializeWorkflowDefinition(store, snapshot.hash, cacheRoot)).toThrow(
        /changed since snapshot/,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cache eviction skips definitions used by active runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-gc-"));
    const store = JournalStore.memory();
    try {
      const cacheRoot = join(dir, "definitions");
      const active = snapshotWorkflowSource(store, "export default async () => 1;\n", {
        name: "active",
        nowMs: 1,
        cacheRoot,
      }).snapshot.hash;
      const inactive = snapshotWorkflowSource(store, "export default async () => 2;\n", {
        name: "inactive",
        nowMs: 1,
        cacheRoot,
      }).snapshot.hash;
      store.insertRun({
        runId: "r_active",
        workflowName: "active",
        definitionVersion: active,
        workflowRef: "stdin",
        status: "waiting-human",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 1,
      });

      expect(
        evictWorkflowDefinitionCache(store, { cacheRoot, nowMs: Number.MAX_SAFE_INTEGER }),
      ).toBe(1);
      expect(existsSync(join(cacheRoot, active))).toBe(true);
      expect(existsSync(join(cacheRoot, inactive))).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
