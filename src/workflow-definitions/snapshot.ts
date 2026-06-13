import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  name: string;
  kind: "path";
  code: string;
  manifest: WorkflowDefinitionManifest;
  provenance: string;
}

export interface SnapshotWorkflowOptions {
  name: string;
  nowMs: number;
  lint?: boolean;
  cacheRoot?: string;
}

const DEFINITION_PREFIX = "wf_sha256_";
const IMPORT_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const INDEX_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const KEEL_PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const tsTranspiler = new Bun.Transpiler({ loader: "tsx" });

export function defaultDefinitionCacheRoot(): string {
  return process.env.KEEL_DEFINITION_CACHE_DIR ?? join(homedir(), ".keel", "definitions");
}

export function snapshotWorkflowPath(
  store: JournalStore,
  workflowUrl: string,
  opts: SnapshotWorkflowOptions,
): { snapshot: WorkflowDefinitionSnapshot; entryPath: string } {
  const snapshot = createWorkflowDefinitionSnapshot(workflowUrl, opts);
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

  for (const module of manifest.modules) {
    const dest = join(root, module.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, module.code, "utf8");
  }
  if (manifest.modules.length === 0) {
    const entry = join(root, "entry.ts");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, row.code, "utf8");
    return entry;
  }

  linkExternalResolution(
    root,
    manifest.sourceRoot,
    manifest.externalImports,
    manifest.externalPackages,
  );
  return join(root, manifest.entry);
}

export function isWorkflowDefinitionHash(value: string): boolean {
  return value.startsWith(DEFINITION_PREFIX);
}

function createWorkflowDefinitionSnapshot(
  workflowUrl: string,
  opts: SnapshotWorkflowOptions,
): WorkflowDefinitionSnapshot {
  const entryPath = pathFromWorkflowUrl(workflowUrl);
  const sourceRoot = findPackageRoot(dirname(entryPath));
  const modules = collectModules(entryPath, sourceRoot, opts.lint ?? true);
  const entry = relativeModulePath(sourceRoot, entryPath);
  const entryModule = modules.find((m) => m.path === entry);
  if (!entryModule) throw new Error(`workflow entry ${entryPath} was not captured`);

  const externalImports = collectExternalImports(modules).sort();
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
    name: opts.name,
    kind: "path",
    code: entryModule.code,
    manifest,
    provenance: entryPath,
  };
}

function collectModules(entryPath: string, sourceRoot: string, lint: boolean): CapturedModule[] {
  const seen = new Set<string>();
  const modules = new Map<string, CapturedModule>();
  const visit = (file: string) => {
    const abs = resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);

    const rel = relativeModulePath(sourceRoot, abs);
    const code = readFileSync(abs, "utf8");
    if (lint) {
      const violations = lintWorkflowSource(code, abs);
      if (violations.length > 0) {
        throw new Error(
          `workflow failed the determinism lint:\n${formatViolations(violations, abs)}`,
        );
      }
    }
    modules.set(rel, { path: rel, code });

    for (const spec of staticImports(code, abs)) {
      if (spec.startsWith(".")) {
        const dep = resolveRelativeImport(abs, spec);
        assertInsideRoot(sourceRoot, dep, spec);
        visit(dep);
      } else if (isAbsolute(spec)) {
        throw new Error(`absolute workflow import "${spec}" is not allowed in ${abs}`);
      }
    }
  };
  visit(entryPath);
  return [...modules.values()].sort((a, b) => a.path.localeCompare(b.path));
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

function resolveRelativeImport(fromFile: string, spec: string): string {
  const base = resolve(dirname(fromFile), spec);
  for (const ext of IMPORT_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  for (const ext of INDEX_EXTENSIONS) {
    const candidate = join(base, `index${ext}`);
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  throw new Error(`could not resolve workflow import "${spec}" from ${fromFile}`);
}

function pathFromWorkflowUrl(workflowUrl: string): string {
  const path = workflowUrl.startsWith("file:") ? fileURLToPath(workflowUrl) : workflowUrl;
  const abs = resolve(path);
  if (!existsSync(abs) || !lstatSync(abs).isFile()) {
    throw new Error(`workflow path ${workflowUrl} is not a readable file`);
  }
  return abs;
}

function findPackageRoot(startDir: string): string {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

function relativeModulePath(root: string, file: string): string {
  assertInsideRoot(root, file, file);
  return relative(root, file).split(sep).join("/");
}

function assertInsideRoot(root: string, file: string, label: string): void {
  const rel = relative(root, file);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`workflow import "${label}" escapes workflow root ${root}`);
  }
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
