import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { canonicalJson, sha256Hex } from "../hash.ts";
import type { JournalStore } from "../journal/store.ts";
import type { WorkflowDefinitionRow } from "../journal/types.ts";
import { formatViolations, lintWorkflowSource } from "../lint/determinism.ts";

type AnyNode = { type: string } & Record<string, unknown>;

interface CapturedModule {
  path: string;
  code: string;
}

interface WorkflowDefinitionManifest {
  format: "keel.workflow-definition.v1";
  entry: string;
  modules: CapturedModule[];
  externalImports: string[];
  externalPackages: CapturedExternalPackage[];
  sourceRoot: string;
  runtime: {
    bunVersion: string;
    keelDefinitionAbi: 1;
  };
}

interface CapturedExternalPackage {
  name: string;
  root: string;
  integrity: string;
}

export interface WorkflowDefinitionSnapshot {
  hash: string;
  name: string | null;
  kind: "source";
  code: string;
  manifest: WorkflowDefinitionManifest;
}

export interface SnapshotWorkflowOptions {
  name?: string | null;
  nowMs: number;
  lint?: boolean;
  cacheRoot?: string;
}

const DEFINITION_PREFIX = "wf_sha256_";
export const MAX_WORKFLOW_SOURCE_BYTES = 256 * 1024;
export const DEFAULT_WORKFLOW_DEFINITION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const KEEL_PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tsTranspiler = new Bun.Transpiler({ loader: "tsx" });

export function defaultDefinitionCacheRoot(): string {
  return process.env.KEEL_DEFINITION_CACHE_DIR ?? join(homedir(), ".keel", "definitions");
}

export function snapshotWorkflowSource(
  store: JournalStore,
  source: string,
  opts: SnapshotWorkflowOptions,
): { snapshot: WorkflowDefinitionSnapshot; entryPath: string } {
  const snapshot = createWorkflowDefinitionSnapshot(source, opts);
  store.putWorkflowDefinition({
    hash: snapshot.hash,
    name: snapshot.name,
    kind: snapshot.kind,
    code: snapshot.code,
    sourceMap: null,
    manifestJson: canonicalJson(snapshot.manifest),
    createdAtMs: opts.nowMs,
  });
  const entryPath = materializeWorkflowDefinition(
    store,
    snapshot.hash,
    opts.cacheRoot ?? defaultDefinitionCacheRoot(),
  );
  return { snapshot, entryPath };
}

export function materializeWorkflowDefinition(
  store: JournalStore,
  hash: string,
  cacheRoot = defaultDefinitionCacheRoot(),
): string {
  const row = store.getWorkflowDefinition(hash);
  if (!row) throw new Error(`workflow definition ${hash} not found`);
  const manifest = parseManifest(row);
  const root = join(cacheRoot, hash);
  const entryPath = join(root, manifest.modules.length === 0 ? "entry.ts" : manifest.entry);
  if (existsSync(entryPath)) return entryPath;

  mkdirSync(cacheRoot, { recursive: true });
  const tmp = join(cacheRoot, `.tmp-${hash}-${randomUUID()}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const module of manifest.modules) {
    const dest = join(tmp, module.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, module.code, "utf8");
  }
  if (manifest.modules.length === 0) {
    const entry = join(tmp, "entry.ts");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, row.code, "utf8");
  }

  linkExternalResolution(
    tmp,
    manifest.sourceRoot,
    manifest.externalImports,
    manifest.externalPackages,
  );
  try {
    renameSync(tmp, root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw err;
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(entryPath)) {
      rmSync(root, { recursive: true, force: true });
      materializeWorkflowDefinition(store, hash, cacheRoot);
    }
  }
  return entryPath;
}

export function evictWorkflowDefinitionCache(
  store: JournalStore,
  opts: { cacheRoot?: string; nowMs: number; minAgeMs?: number },
): number {
  const cacheRoot = opts.cacheRoot ?? defaultDefinitionCacheRoot();
  if (!existsSync(cacheRoot)) return 0;
  const active = new Set(store.listActiveWorkflowDefinitionHashes());
  const minAgeMs = opts.minAgeMs ?? 0;
  let removed = 0;
  for (const name of readdirSync(cacheRoot)) {
    if (!isWorkflowDefinitionHash(name)) continue;
    if (active.has(name)) continue;
    const path = join(cacheRoot, name);
    const stat = lstatSync(path);
    if (!stat.isDirectory()) continue;
    if (opts.nowMs - stat.mtimeMs < minAgeMs) continue;
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export function isWorkflowDefinitionHash(value: string): boolean {
  return value.startsWith(DEFINITION_PREFIX);
}

function createWorkflowDefinitionSnapshot(
  source: string,
  opts: SnapshotWorkflowOptions,
): WorkflowDefinitionSnapshot {
  const size = new TextEncoder().encode(source).byteLength;
  if (size > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(
      `workflow source is ${size} bytes; maximum is ${MAX_WORKFLOW_SOURCE_BYTES} bytes`,
    );
  }
  const name = opts.name ?? null;
  const filename = name ?? "workflow";
  if (opts.lint ?? true) {
    const violations = lintWorkflowSource(source, filename);
    if (violations.length > 0) {
      throw new Error(
        `workflow failed the determinism lint:\n${formatViolations(violations, filename)}`,
      );
    }
  }
  const imports = staticImports(source, filename);
  for (const spec of imports) {
    if (spec.startsWith(".") || isAbsolute(spec)) {
      throw new Error(
        `workflow must be a single self-contained file; import "${spec}" is not supported yet`,
      );
    }
    if (spec !== "@kcosr/keel") {
      throw new Error(`workflow import "${spec}" is not allowed; only @kcosr/keel is supported`);
    }
  }
  const modules: CapturedModule[] = [{ path: "entry.ts", code: source }];
  const entry = "entry.ts";
  const externalImports = collectExternalImports(modules).sort();
  const sourceRoot = "client-captured://source";
  const manifest: WorkflowDefinitionManifest = {
    format: "keel.workflow-definition.v1",
    entry,
    modules,
    externalImports,
    externalPackages: collectExternalPackages(sourceRoot, externalImports),
    sourceRoot,
    runtime: {
      bunVersion: Bun.version,
      keelDefinitionAbi: 1,
    },
  };
  const hash = `${DEFINITION_PREFIX}${sha256Hex(
    canonicalJson({
      format: manifest.format,
      entry: manifest.entry,
      modules: manifest.modules,
      externalImports: manifest.externalImports,
      externalPackages: manifest.externalPackages,
      runtime: manifest.runtime,
    }),
  )}`;

  return {
    hash,
    name,
    kind: "source",
    code: source,
    manifest,
  };
}

function staticImports(source: string, filename: string): string[] {
  let ast: AnyNode;
  try {
    ast = parse(tsTranspiler.transformSync(source), {
      ecmaVersion: "latest",
      sourceType: "module",
    }) as unknown as AnyNode;
  } catch (err) {
    throw new Error(
      `could not parse workflow imports in ${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const imports: string[] = [];
  walk(ast, (node) => {
    if (node.type === "ImportExpression") {
      throw new Error(`dynamic import(...) is not allowed in workflow code: ${filename}`);
    }
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      const src = (node.source as AnyNode | undefined)?.value;
      if (typeof src === "string") imports.push(src);
    }
  });
  return imports;
}

function collectExternalImports(modules: CapturedModule[]): string[] {
  const imports = new Set<string>();
  for (const module of modules) {
    for (const spec of staticImports(module.code, module.path)) {
      if (!spec.startsWith(".") && !isAbsolute(spec)) imports.add(spec);
    }
  }
  return [...imports];
}

function parseManifest(row: WorkflowDefinitionRow): WorkflowDefinitionManifest {
  if (!row.manifestJson) {
    throw new Error(`workflow definition ${row.hash} is missing manifest_json`);
  }
  const parsed = JSON.parse(row.manifestJson) as WorkflowDefinitionManifest;
  if (parsed.format !== "keel.workflow-definition.v1") {
    throw new Error(`unsupported workflow definition manifest for ${row.hash}`);
  }
  return parsed;
}

function linkExternalResolution(
  cacheRoot: string,
  sourceRoot: string,
  externalImports: string[],
  packagePins: CapturedExternalPackage[],
): void {
  const nodeModules = join(cacheRoot, "node_modules");
  mkdirSync(nodeModules, { recursive: true });

  const packageNames = new Set<string>();
  for (const specifier of externalImports) {
    const packageName = packageNameForImport(specifier);
    if (packageName) packageNames.add(packageName);
  }
  for (const packageName of packageNames) {
    const pinned = packagePins.find((pkg) => pkg.name === packageName);
    if (packageName === "@kcosr/keel") {
      const src = KEEL_PACKAGE_ROOT;
      validatePackageIntegrity(packageName, src, pinned);
      linkPackage(join(nodeModules, "@kcosr", "keel"), src);
    } else {
      const src = join(sourceRoot, "node_modules", ...packageName.split("/"));
      if (!existsSync(src)) {
        throw new Error(
          `workflow definition requires external package "${packageName}", but ${src} does not exist`,
        );
      }
      validatePackageIntegrity(packageName, src, pinned);
      linkPackage(join(nodeModules, ...packageName.split("/")), src);
    }
  }
}

function collectExternalPackages(
  sourceRoot: string,
  externalImports: string[],
): CapturedExternalPackage[] {
  const names = new Set<string>();
  for (const specifier of externalImports) {
    const packageName = packageNameForImport(specifier);
    if (packageName) names.add(packageName);
  }
  return [...names].sort().map((name) => {
    const root =
      name === "@kcosr/keel"
        ? KEEL_PACKAGE_ROOT
        : join(sourceRoot, "node_modules", ...name.split("/"));
    if (!existsSync(root)) {
      throw new Error(`workflow external package "${name}" is missing at ${root}`);
    }
    return { name, root, integrity: hashPackageTree(root) };
  });
}

function validatePackageIntegrity(
  name: string,
  root: string,
  pinned: CapturedExternalPackage | undefined,
): void {
  if (!pinned) throw new Error(`workflow definition is missing integrity metadata for ${name}`);
  const actual = hashPackageTree(root);
  if (actual !== pinned.integrity) {
    throw new Error(`workflow external package "${name}" changed since snapshot`);
  }
}

function hashPackageTree(root: string): string {
  const files: { path: string; hash: string }[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (shouldSkipPackagePath(name)) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        visit(abs);
      } else if (st.isFile()) {
        files.push({
          path: relative(root, abs).split(sep).join("/"),
          hash: sha256Hex(readFileSync(abs, "utf8")),
        });
      }
    }
  };
  visit(root);
  return sha256Hex(canonicalJson(files));
}

function shouldSkipPackagePath(name: string): boolean {
  return (
    name === ".git" ||
    name === ".specs" ||
    name === "node_modules" ||
    name === "definitions" ||
    name === ".DS_Store"
  );
}

function packageNameForImport(specifier: string): string | null {
  if (NODE_BUILTINS.has(specifier)) return null;
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    if (!scope || !name) throw new Error(`invalid scoped package import "${specifier}"`);
    return `${scope}/${name}`;
  }
  const [name] = specifier.split("/");
  if (!name) throw new Error(`invalid package import "${specifier}"`);
  return name;
}

function linkPackage(dest: string, src: string): void {
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(src, dest, "dir");
}

function walk(root: AnyNode, fn: (node: AnyNode) => void): void {
  const visit = (node: AnyNode): void => {
    fn(node);
    for (const child of childNodes(node)) visit(child);
  };
  visit(root);
}

function childNodes(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const v of value) if (isNode(v)) out.push(v);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function isNode(value: unknown): value is AnyNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
