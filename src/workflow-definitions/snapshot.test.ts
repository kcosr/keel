import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JournalStore } from "../journal/store.ts";
import { captureWorkflowFile } from "./capture.ts";
import {
  WORKFLOW_SDK_ABI_VERSION,
  evictWorkflowDefinitionCache,
  materializeWorkflowDefinition,
  resolveKeelPackageRoot,
  snapshotWorkflowSource,
} from "./snapshot.ts";

const NEXT_WORKFLOW_SDK_ABI_VERSION = WORKFLOW_SDK_ABI_VERSION + 1;

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
        expect(snapshot.manifest.externalPackages).toEqual([]);
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

  test("stdin relative imports fail with the file-capture guidance", () => {
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
        ).toThrow(/local workflow imports require launching from a file/);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file capture stores a sorted multi-module bundle with inferred entry path", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-bundle-"));
    const store = JournalStore.memory();
    try {
      mkdirSync(join(dir, "workflows", "shared"), { recursive: true });
      mkdirSync(join(dir, "workflows", "spec-review-loop"), { recursive: true });
      const workflow = join(dir, "workflows", "spec-review-loop", "spec-review-loop.workflow.ts");
      writeFileSync(
        join(dir, "workflows", "shared", "review-tasks.ts"),
        "export const task = 'review';\n",
      );
      writeFileSync(
        workflow,
        `
          import { task } from "../shared/review-tasks";
          export default async function wf() { return task; }
        `,
      );

      const captured = captureWorkflowFile(workflow);
      expect(captured.source).toMatchObject({
        kind: "bundle",
        entry: "spec-review-loop/spec-review-loop.workflow.ts",
      });
      const { snapshot } = snapshotWorkflowSource(store, captured.source, {
        name: "review",
        nowMs: 1,
        cacheRoot: join(dir, "definitions"),
      });
      expect(snapshot.manifest.entry).toBe("spec-review-loop/spec-review-loop.workflow.ts");
      expect(snapshot.manifest.modules.map((module) => module.path)).toEqual([
        "shared/review-tasks.ts",
        "spec-review-loop/spec-review-loop.workflow.ts",
      ]);
      expect(snapshot.code).toContain("../shared/review-tasks");
      expect(
        readFileSync(join(dir, "definitions", snapshot.hash, "shared", "review-tasks.ts"), "utf8"),
      ).toBe("export const task = 'review';\n");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("single-file path launches use the entry basename while stdin uses entry.ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-entry-"));
    const store = JournalStore.memory();
    try {
      const workflow = join(dir, "named.workflow.ts");
      writeFileSync(workflow, "export default async function wf() { return 1; }\n");
      const captured = captureWorkflowFile(workflow);
      expect(captured.source).toMatchObject({ kind: "bundle", entry: "named.workflow.ts" });
      const fileSnapshot = snapshotWorkflowSource(store, captured.source, {
        name: "file",
        nowMs: 1,
        cacheRoot: join(dir, "definitions"),
      }).snapshot;
      const stdinSnapshot = snapshotWorkflowSource(
        store,
        "export default async function wf() { return 1; }\n",
        { name: "stdin", nowMs: 2, cacheRoot: join(dir, "definitions") },
      ).snapshot;
      expect(fileSnapshot.manifest.entry).toBe("named.workflow.ts");
      expect(stdinSnapshot.manifest.entry).toBe("entry.ts");
      expect(fileSnapshot.hash).not.toBe(stdinSnapshot.hash);
    } finally {
      store.close();
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

  test("persisted definitions with non-SDK imports or SDK subpaths fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-persisted-imports-"));
    const store = JournalStore.memory();
    try {
      const cacheRoot = join(dir, "definitions");
      putPersistedDefinition(
        store,
        "wf_sha256_persisted_subpath",
        'import { runExecuteScript } from "@kcosr/keel/execute"; export default async () => runExecuteScript;\n',
        ["@kcosr/keel/execute"],
      );
      expect(() =>
        materializeWorkflowDefinition(store, "wf_sha256_persisted_subpath", cacheRoot),
      ).toThrow(/@kcosr\/keel\/execute" is not allowed/);

      putPersistedDefinition(
        store,
        "wf_sha256_persisted_package",
        'import x from "left-pad"; export default async () => x;\n',
        ["left-pad"],
      );
      expect(() =>
        materializeWorkflowDefinition(store, "wf_sha256_persisted_package", cacheRoot),
      ).toThrow(/left-pad" is not allowed/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persisted definitions reject malicious paths and unreachable modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-malicious-"));
    const store = JournalStore.memory();
    try {
      const cacheRoot = join(dir, "definitions");
      putPersistedDefinitionWithModules(store, "wf_sha256_persisted_escape", "entry.ts", [
        { path: "../escape.ts", code: "export const bad = 1;\n" },
        { path: "entry.ts", code: "export default async () => 1;\n" },
      ]);
      expect(() =>
        materializeWorkflowDefinition(store, "wf_sha256_persisted_escape", cacheRoot),
      ).toThrow(/normalized relative POSIX path/);

      putPersistedDefinitionWithModules(store, "wf_sha256_persisted_extra", "entry.ts", [
        { path: "entry.ts", code: "export default async () => 1;\n" },
        { path: "extra.ts", code: "export const extra = 1;\n" },
      ]);
      expect(() =>
        materializeWorkflowDefinition(store, "wf_sha256_persisted_extra", cacheRoot),
      ).toThrow(/unreachable modules: extra.ts/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
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

  test("cached materialization validates SDK ABI instead of SDK package integrity", () => {
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
        externalPackages: Array<{ name: string; root: string; integrity: string }>;
        runtime: { workflowSdkAbi: number };
      };
      manifest.externalPackages.push({
        name: "@kcosr/keel",
        root: "/old/keel",
        integrity: "sha256-bad",
      });
      store.db
        .query("UPDATE workflow_definitions SET manifest_json = ? WHERE hash = ?")
        .run(JSON.stringify(manifest), snapshot.hash);

      expect(materializeWorkflowDefinition(store, snapshot.hash, cacheRoot)).toBe(
        join(cacheRoot, snapshot.hash, "entry.ts"),
      );

      manifest.runtime.workflowSdkAbi = NEXT_WORKFLOW_SDK_ABI_VERSION;
      store.db
        .query("UPDATE workflow_definitions SET manifest_json = ? WHERE hash = ?")
        .run(JSON.stringify(manifest), snapshot.hash);
      expect(() => materializeWorkflowDefinition(store, snapshot.hash, cacheRoot)).toThrow(
        `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cached materialization repairs a stale SDK symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-stale-sdk-"));
    const store = JournalStore.memory();
    try {
      const cacheRoot = join(dir, "definitions");
      const source =
        'import { passthrough } from "@kcosr/keel";\nexport default async () => passthrough();\n';
      const { snapshot } = snapshotWorkflowSource(store, source, {
        name: "stale-sdk",
        nowMs: 1,
        cacheRoot,
      });
      const oldRoot = join(dir, "old-keel");
      mkdirSync(join(oldRoot, "src"), { recursive: true });
      writeFileSync(join(oldRoot, "package.json"), '{"name":"@kcosr/keel"}\n');
      writeFileSync(join(oldRoot, "src", "sdk.ts"), "export {};\n");
      const link = join(cacheRoot, snapshot.hash, "node_modules", "@kcosr", "keel");
      rmSync(link, { recursive: true, force: true });
      symlinkSync(oldRoot, link, "dir");

      materializeWorkflowDefinition(store, snapshot.hash, cacheRoot);
      expect(resolve(readlinkSync(link))).toBe(resolve(import.meta.dir, "..", ".."));
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

function putPersistedDefinition(
  store: JournalStore,
  hash: string,
  source: string,
  externalImports: string[],
): void {
  store.putWorkflowDefinition({
    hash,
    name: "persisted",
    kind: "source",
    code: source,
    sourceMap: null,
    manifestJson: JSON.stringify({
      format: "keel.workflow-definition.v1",
      entry: "entry.ts",
      modules: [{ path: "entry.ts", code: source }],
      externalImports,
      externalPackages: [],
      sourceRoot: "client-captured://source",
      runtime: {
        bunVersion: Bun.version,
        keelDefinitionAbi: 1,
        workflowSdkAbi: 2,
      },
    }),
    createdAtMs: 1,
  });
}

function putPersistedDefinitionWithModules(
  store: JournalStore,
  hash: string,
  entry: string,
  modules: Array<{ path: string; code: string }>,
): void {
  store.putWorkflowDefinition({
    hash,
    name: "persisted",
    kind: "source",
    code: modules.find((module) => module.path === entry)?.code ?? "",
    sourceMap: null,
    manifestJson: JSON.stringify({
      format: "keel.workflow-definition.v1",
      entry,
      modules,
      externalImports: [],
      externalPackages: [],
      sourceRoot: "client-captured://source",
      runtime: {
        bunVersion: Bun.version,
        keelDefinitionAbi: 1,
        workflowSdkAbi: WORKFLOW_SDK_ABI_VERSION,
      },
    }),
    createdAtMs: 1,
  });
}
