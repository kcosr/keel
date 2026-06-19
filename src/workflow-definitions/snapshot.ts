import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "../hash.ts";
import type { JournalStore } from "../journal/store.ts";
import type { WorkflowDefinitionRow } from "../journal/types.ts";
import { formatViolations, lintWorkflowSource } from "../lint/determinism.ts";
import {
  assertAllowedExternalWorkflowImport,
  isLocalWorkflowImport,
  isUrlLikeSpecifier,
  resolveBundledLocalImport,
  staticWorkflowImports,
  validateWorkflowModulePath,
} from "./imports.ts";
import {
  MAX_WORKFLOW_BUNDLE_MODULES,
  WORKFLOW_SOURCE_ROOT,
  type WorkflowSourceInput,
  type WorkflowSourceModule,
} from "./source.ts";

type CapturedModule = WorkflowSourceModule;

interface WorkflowDefinitionManifest {
  format: "keel.workflow-definition.v1";
  entry: string;
  modules: CapturedModule[];
  externalImports: string[];
  externalPackages: CapturedExternalPackage[];
  sourceRoot: string;
  runtime: {
    bunVersion: string;
    keelDefinitionAbi: typeof WORKFLOW_DEFINITION_ABI_VERSION;
    workflowSdkAbi: typeof WORKFLOW_SDK_ABI_VERSION;
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
export const WORKFLOW_DEFINITION_ABI_VERSION = 1;
export const WORKFLOW_SDK_ABI_VERSION = 11;
export const CURRENT_WORKFLOW_SDK_ABI_VERSION = WORKFLOW_SDK_ABI_VERSION;
export const MAX_WORKFLOW_SOURCE_BYTES = 256 * 1024;
export const MAX_WORKFLOW_BUNDLE_BYTES = MAX_WORKFLOW_SOURCE_BYTES;
export const DEFAULT_WORKFLOW_DEFINITION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export class UnsupportedWorkflowSdkAbiError extends Error {
  readonly requiredAbi: number;
  readonly supportedAbi: number;
  readonly definitionHash: string;

  constructor(
    definitionHash: string,
    requiredAbi: number,
    supportedAbi = CURRENT_WORKFLOW_SDK_ABI_VERSION,
  ) {
    super(
      `workflow definition ${definitionHash} requires workflow SDK ABI ${requiredAbi}, but this daemon supports ABI ${supportedAbi}`,
    );
    this.name = "UnsupportedWorkflowSdkAbiError";
    this.requiredAbi = requiredAbi;
    this.supportedAbi = supportedAbi;
    this.definitionHash = definitionHash;
  }
}

export function isUnsupportedWorkflowSdkAbiError(
  err: unknown,
): err is UnsupportedWorkflowSdkAbiError {
  return err instanceof UnsupportedWorkflowSdkAbiError;
}

interface KeelPackageRootInputs {
  envRoot?: string | undefined;
  moduleUrl?: string | undefined;
  cwd?: string | undefined;
  argv1?: string | undefined;
  execPath?: string | undefined;
}

export function resolveKeelPackageRoot(inputs: KeelPackageRootInputs = {}): string {
  const candidates: string[] = [];
  const envRoot = inputs.envRoot ?? process.env.KEEL_PACKAGE_ROOT;
  if (envRoot) candidates.push(envRoot);

  const moduleUrl = inputs.moduleUrl ?? import.meta.url;
  try {
    candidates.push(resolve(fileURLToPath(new URL("../../", moduleUrl))));
  } catch {
    // Bundled binaries may expose a virtual import.meta.url. Try runtime paths below.
  }

  candidates.push(
    inputs.cwd ?? process.cwd(),
    inputs.argv1 ?? process.argv[1] ?? "",
    inputs.execPath ?? process.execPath,
  );

  for (const candidate of candidates) {
    if (!candidate) continue;
    const root = findKeelPackageRoot(candidate);
    if (root) return root;
  }

  throw new Error(
    "could not locate @kcosr/keel package root; set KEEL_PACKAGE_ROOT to the repository root",
  );
}

let cachedKeelPackageRoot: string | null = null;

/**
 * On-disk root of the @kcosr/keel SDK package, used to link the daemon-provided
 * SDK into snapshotted workflows. Resolved lazily (never at import) and
 * memoized, so `keel --help` and read-only commands neither pay for nor crash on
 * resolution. The daemon asserts it explicitly at startup so a misconfigured
 * root fails fast with a clear message instead of a transitive import crash.
 */
export function keelPackageRoot(): string {
  if (cachedKeelPackageRoot === null) cachedKeelPackageRoot = resolveKeelPackageRoot();
  return cachedKeelPackageRoot;
}

export function defaultDefinitionCacheRoot(): string {
  return process.env.KEEL_DEFINITION_CACHE_DIR ?? join(homedir(), ".keel", "definitions");
}

export function snapshotWorkflowSource(
  store: JournalStore,
  source: WorkflowSourceInput,
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
  validateWorkflowSdkAbi(hash, manifest);
  const root = join(cacheRoot, hash);
  const entryPath = join(root, manifest.entry);
  if (isMaterializationComplete(root, manifest)) {
    validateExternalPackagePins(manifest.externalPackages);
    return entryPath;
  }

  mkdirSync(cacheRoot, { recursive: true });
  const tmp = join(cacheRoot, `.tmp-${hash}-${randomUUID()}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  for (const module of manifest.modules) {
    const dest = join(tmp, module.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, rewriteSdkImportsForMaterialization(module.code, module.path), "utf8");
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
    if (!isMaterializationComplete(root, manifest)) {
      rmSync(root, { recursive: true, force: true });
      materializeWorkflowDefinition(store, hash, cacheRoot);
    } else {
      validateExternalPackagePins(manifest.externalPackages);
    }
  }
  return entryPath;
}

function isMaterializationComplete(root: string, manifest: WorkflowDefinitionManifest): boolean {
  const entryPath = join(root, manifest.entry);
  if (!existsSync(entryPath)) return false;
  for (const module of manifest.modules) {
    if (!existsSync(join(root, module.path))) return false;
  }
  for (const specifier of manifest.externalImports) {
    const packageName = packageNameForImport(specifier);
    if (!packageName) continue;
    const linked =
      packageName === "@kcosr/keel"
        ? join(root, "node_modules", "@kcosr", "keel")
        : join(root, "node_modules", ...packageName.split("/"));
    if (!existsSync(linked)) return false;
    if (packageName === "@kcosr/keel" && !isCurrentSdkLink(linked)) return false;
  }
  return true;
}

function validateExternalPackagePins(packagePins: CapturedExternalPackage[]): void {
  for (const pinned of packagePins) {
    if (pinned.name === "@kcosr/keel") continue;
    validatePackageIntegrity(pinned.name, pinned.root, pinned);
  }
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

export function createWorkflowDefinitionSnapshot(
  source: WorkflowSourceInput,
  opts: SnapshotWorkflowOptions,
): WorkflowDefinitionSnapshot {
  const bundle = normalizeWorkflowSourceInput(source);
  const size = bundle.modules.reduce(
    (sum, module) => sum + new TextEncoder().encode(module.code).byteLength,
    0,
  );
  if (size > MAX_WORKFLOW_BUNDLE_BYTES) {
    throw new Error(`workflow bundle is ${size} bytes; maximum is ${MAX_WORKFLOW_BUNDLE_BYTES}`);
  }
  const name = opts.name ?? null;
  if (opts.lint ?? true) {
    const violations = bundle.modules.flatMap((module) =>
      lintWorkflowSource(module.code, module.path).map((violation) => ({
        modulePath: module.path,
        violation,
      })),
    );
    if (violations.length > 0) {
      throw new Error(
        `workflow failed the determinism lint:\n${violations
          .map(({ modulePath, violation }) => formatViolations([violation], modulePath))
          .join("\n")}`,
      );
    }
  }
  const modules = bundle.modules;
  const entry = bundle.entry;
  const externalImports = collectExternalImports(modules).sort();
  const sourceRoot = WORKFLOW_SOURCE_ROOT;
  const manifest: WorkflowDefinitionManifest = {
    format: "keel.workflow-definition.v1",
    entry,
    modules,
    externalImports,
    externalPackages: collectExternalPackages(sourceRoot, externalImports),
    sourceRoot,
    runtime: {
      bunVersion: Bun.version,
      keelDefinitionAbi: WORKFLOW_DEFINITION_ABI_VERSION,
      workflowSdkAbi: WORKFLOW_SDK_ABI_VERSION,
    },
  };
  const hash = workflowDefinitionHashForManifest(manifest);

  return {
    hash,
    name,
    kind: "source",
    code: modules.find((module) => module.path === entry)?.code ?? "",
    manifest,
  };
}

function normalizeWorkflowSourceInput(source: WorkflowSourceInput): {
  entry: string;
  modules: WorkflowSourceModule[];
} {
  if (typeof source === "string") {
    const bundle = { entry: "entry.ts", modules: [{ path: "entry.ts", code: source }] };
    validateSourceBundle(bundle, true);
    return bundle;
  }
  if (
    typeof source !== "object" ||
    source === null ||
    source.kind !== "bundle" ||
    typeof source.entry !== "string" ||
    !Array.isArray(source.modules)
  ) {
    throw new Error("workflow source must be a string or bundle");
  }
  const bundle = {
    entry: source.entry,
    modules: source.modules.map((module) => {
      if (
        typeof module !== "object" ||
        module === null ||
        typeof module.path !== "string" ||
        typeof module.code !== "string"
      ) {
        throw new Error("workflow source bundle modules must contain path and code strings");
      }
      return { path: module.path, code: module.code };
    }),
  };
  validateSourceBundle(bundle, false);
  return {
    entry: bundle.entry,
    modules: [...bundle.modules].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function validateSourceBundle(
  bundle: { entry: string; modules: WorkflowSourceModule[] },
  inlineSource: boolean,
): void {
  if (bundle.modules.length === 0) throw new Error("workflow source bundle must contain modules");
  if (bundle.modules.length > MAX_WORKFLOW_BUNDLE_MODULES) {
    throw new Error(`workflow bundle has more than ${MAX_WORKFLOW_BUNDLE_MODULES} modules`);
  }
  validateWorkflowModulePath(bundle.entry, "workflow entry path");
  const modulesByPath = new Map<string, WorkflowSourceModule>();
  for (const module of bundle.modules) {
    validateWorkflowModulePath(module.path);
    if (modulesByPath.has(module.path)) {
      throw new Error(`workflow source bundle contains duplicate module ${module.path}`);
    }
    modulesByPath.set(module.path, module);
  }
  if (!modulesByPath.has(bundle.entry)) {
    throw new Error(`workflow source bundle entry ${bundle.entry} is missing`);
  }
  const reachable = validateBundleGraph(
    bundle.entry,
    modulesByPath,
    "workflow source bundle",
    inlineSource,
  );
  if (reachable.size !== bundle.modules.length) {
    const extra = bundle.modules
      .map((module) => module.path)
      .filter((path) => !reachable.has(path));
    throw new Error(`workflow source bundle contains unreachable modules: ${extra.join(", ")}`);
  }
}

function validateBundleGraph(
  entry: string,
  modulesByPath: Map<string, WorkflowSourceModule>,
  label: string,
  inlineSource = false,
): Set<string> {
  const reachable = new Set<string>();
  const visit = (modulePath: string): void => {
    if (reachable.has(modulePath)) return;
    const module = modulesByPath.get(modulePath);
    if (!module) throw new Error(`${label} is missing module ${modulePath}`);
    reachable.add(modulePath);
    for (const specifier of staticWorkflowImports(module.code, module.path)) {
      if (isLocalWorkflowImport(specifier)) {
        if (inlineSource) {
          throw new Error(
            "local workflow imports require launching from a file so Keel can capture the helper graph",
          );
        }
        visit(resolveBundledLocalImport(module.path, specifier, modulesByPath));
        continue;
      }
      if (isUrlLikeSpecifier(specifier)) {
        throw new Error(`workflow import "${specifier}" from ${module.path} is not allowed`);
      }
      assertAllowedExternalWorkflowImport(specifier, module.path);
    }
  };
  visit(entry);
  return reachable;
}

function collectExternalImports(modules: CapturedModule[]): string[] {
  const imports = new Set<string>();
  for (const module of modules) {
    for (const spec of staticWorkflowImports(module.code, module.path)) {
      if (!isLocalWorkflowImport(spec)) imports.add(spec);
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
  if (typeof parsed.runtime?.workflowSdkAbi !== "number") {
    throw new Error(`workflow definition ${row.hash} is missing runtime.workflowSdkAbi`);
  }
  validatePersistedImportBoundary(row, parsed);
  return parsed;
}

export function workflowDefinitionHashForManifest(
  manifest: Pick<
    WorkflowDefinitionManifest,
    "format" | "entry" | "modules" | "externalImports" | "externalPackages" | "runtime"
  >,
): string {
  return `${DEFINITION_PREFIX}${sha256Hex(
    canonicalJson({
      format: manifest.format,
      entry: manifest.entry,
      modules: manifest.modules,
      externalImports: manifest.externalImports,
      externalPackages: manifest.externalPackages,
      runtime: manifest.runtime,
    }),
  )}`;
}

function validateWorkflowSdkAbi(hash: string, manifest: WorkflowDefinitionManifest): void {
  if (manifest.runtime.workflowSdkAbi !== CURRENT_WORKFLOW_SDK_ABI_VERSION) {
    throw new UnsupportedWorkflowSdkAbiError(hash, manifest.runtime.workflowSdkAbi);
  }
}

function validatePersistedImportBoundary(
  row: WorkflowDefinitionRow,
  manifest: WorkflowDefinitionManifest,
): void {
  if (typeof manifest.entry !== "string") {
    throw new Error(`workflow definition ${row.hash} manifest entry must be a string`);
  }
  if (!Array.isArray(manifest.modules)) {
    throw new Error(`workflow definition ${row.hash} manifest modules must be an array`);
  }
  if (!Array.isArray(manifest.externalImports)) {
    throw new Error(`workflow definition ${row.hash} manifest externalImports must be an array`);
  }
  if (!Array.isArray(manifest.externalPackages)) {
    throw new Error(`workflow definition ${row.hash} manifest externalPackages must be an array`);
  }
  if (manifest.modules.length === 0) {
    throw new Error(`workflow definition ${row.hash} manifest modules must not be empty`);
  }
  if (manifest.modules.length > MAX_WORKFLOW_BUNDLE_MODULES) {
    throw new Error(
      `workflow definition ${row.hash} manifest has more than ${MAX_WORKFLOW_BUNDLE_MODULES} modules`,
    );
  }
  const totalBytes = manifest.modules.reduce(
    (sum, module) =>
      sum +
      (typeof module.code === "string" ? new TextEncoder().encode(module.code).byteLength : 0),
    0,
  );
  if (totalBytes > MAX_WORKFLOW_BUNDLE_BYTES) {
    throw new Error(
      `workflow definition ${row.hash} manifest source is ${totalBytes} bytes; maximum is ${MAX_WORKFLOW_BUNDLE_BYTES}`,
    );
  }
  const modulesByPath = new Map<string, WorkflowSourceModule>();
  const expectedOrder = [...manifest.modules].sort((a, b) => a.path.localeCompare(b.path));
  if (
    canonicalJson(manifest.modules.map((module) => module.path)) !==
    canonicalJson(expectedOrder.map((module) => module.path))
  ) {
    throw new Error(`workflow definition ${row.hash} manifest modules must be sorted by path`);
  }
  for (const module of manifest.modules) {
    if (typeof module.path !== "string" || typeof module.code !== "string") {
      throw new Error(`workflow definition ${row.hash} manifest module entries are invalid`);
    }
    try {
      validateWorkflowModulePath(module.path);
    } catch (err) {
      throw new Error(
        `workflow definition ${row.hash} manifest ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (modulesByPath.has(module.path)) {
      throw new Error(
        `workflow definition ${row.hash} manifest has duplicate module ${module.path}`,
      );
    }
    modulesByPath.set(module.path, module);
  }
  try {
    validateWorkflowModulePath(manifest.entry, "workflow entry path");
  } catch (err) {
    throw new Error(
      `workflow definition ${row.hash} manifest ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!modulesByPath.has(manifest.entry)) {
    throw new Error(`workflow definition ${row.hash} manifest entry ${manifest.entry} is missing`);
  }
  const reachable = validateBundleGraph(
    manifest.entry,
    modulesByPath,
    `workflow definition ${row.hash}`,
  );
  if (reachable.size !== manifest.modules.length) {
    const extra = manifest.modules
      .map((module) => module.path)
      .filter((path) => !reachable.has(path));
    throw new Error(
      `workflow definition ${row.hash} manifest contains unreachable modules: ${extra.join(", ")}`,
    );
  }
  const actualImports = collectExternalImports(manifest.modules).sort();
  for (const spec of actualImports) {
    try {
      assertAllowedExternalWorkflowImport(spec, "workflow definition manifest");
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }
  const declaredImports = [...manifest.externalImports].sort();
  if (canonicalJson(declaredImports) !== canonicalJson(actualImports)) {
    throw new Error(`workflow definition ${row.hash} manifest externalImports do not match source`);
  }
  for (const pinned of manifest.externalPackages) {
    if (pinned.name !== "@kcosr/keel") {
      throw new Error(
        `workflow definition ${row.hash} includes unsupported external package "${pinned.name}"`,
      );
    }
  }
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
      const src = keelPackageRoot();
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
    if (packageName && packageName !== "@kcosr/keel") names.add(packageName);
  }
  return [...names].sort().map((name) => {
    const root = join(sourceRoot, "node_modules", ...name.split("/"));
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

function findKeelPackageRoot(start: string): string | null {
  let current = normalizePackageRootCandidate(start);
  while (true) {
    if (isKeelPackageRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function normalizePackageRootCandidate(start: string): string {
  let current = resolve(start);
  try {
    current = realpathSync(current);
  } catch {
    // Keep the resolved path and walk upward; a parent may still identify the package.
  }
  try {
    if (existsSync(current) && lstatSync(current).isFile()) current = dirname(current);
  } catch {
    current = dirname(current);
  }
  return current;
}

function isKeelPackageRoot(dir: string): boolean {
  const packageJson = join(dir, "package.json");
  if (!existsSync(packageJson)) return false;
  try {
    const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
    return pkg.name === "@kcosr/keel" && existsSync(join(dir, "src", "sdk.ts"));
  } catch {
    return false;
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

function isCurrentSdkLink(path: string): boolean {
  try {
    return (
      lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(keelPackageRoot())
    );
  } catch {
    return false;
  }
}

function rewriteSdkImportsForMaterialization(code: string, modulePath: string): string {
  const sdkPath = sdkMaterializedSpecifier(modulePath);
  return code
    .replace(/(\bfrom\s*)["@']@kcosr\/keel["@']/g, `$1"${sdkPath}"`)
    .replace(/(\bimport\s*)["@']@kcosr\/keel["@']/g, `$1"${sdkPath}"`);
}

function sdkMaterializedSpecifier(modulePath: string): string {
  const fromDir = posix.dirname(modulePath.split(sep).join(posix.sep));
  const rel = posix.relative(fromDir, "node_modules/@kcosr/keel/src/sdk.ts");
  return rel.startsWith(".") ? rel : `./${rel}`;
}
