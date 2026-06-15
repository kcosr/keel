import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { WorkflowProvenance } from "../rpc/contract.ts";
import {
  assertAllowedExternalWorkflowImport,
  isLocalWorkflowImport,
  isUrlLikeSpecifier,
  staticWorkflowImports,
  validateWorkflowModulePath,
} from "./imports.ts";
import {
  MAX_WORKFLOW_BUNDLE_MODULES,
  WORKFLOW_INDEX_MODULES,
  WORKFLOW_MODULE_EXTENSIONS,
  type WorkflowSourceBundle,
  type WorkflowSourceInput,
  type WorkflowSourceModule,
} from "./source.ts";

export interface CapturedWorkflowFile {
  source: WorkflowSourceInput;
  name: string | null;
  provenance: WorkflowProvenance;
}

export function captureWorkflowFile(path: string, name = basename(path)): CapturedWorkflowFile {
  const abs = resolve(path);
  return {
    source: captureWorkflowBundleFromFile(abs),
    name,
    provenance: { kind: "clientPath", path: abs },
  };
}

export function captureWorkflowBundleFromFile(entryPath: string): WorkflowSourceBundle {
  const entryAbs = resolve(entryPath);
  assertRegularWorkflowFile(entryAbs, "workflow entry");

  const visited = new Map<string, { abs: string; code: string }>();
  const physical = new Map<string, string>();
  const visit = (abs: string, importer?: { path: string; specifier: string }): void => {
    assertRegularWorkflowFile(
      abs,
      importer ? `workflow import "${importer.specifier}"` : "workflow entry",
    );
    const real = realpathSync(abs);
    const existing = physical.get(real);
    if (existing && existing !== abs) {
      throw new Error(`workflow module ${abs} duplicates already captured file ${existing}`);
    }
    physical.set(real, abs);
    if (visited.has(abs)) return;
    if (visited.size >= MAX_WORKFLOW_BUNDLE_MODULES) {
      throw new Error(`workflow bundle has more than ${MAX_WORKFLOW_BUNDLE_MODULES} modules`);
    }
    const code = readFileSync(abs, "utf8");
    visited.set(abs, { abs, code });
    for (const specifier of staticWorkflowImports(code, abs)) {
      if (isLocalWorkflowImport(specifier)) {
        visit(resolveLocalFileImport(abs, specifier), { path: abs, specifier });
      } else {
        if (isUrlLikeSpecifier(specifier)) {
          throw new Error(`workflow import "${specifier}" from ${abs} is not allowed`);
        }
        assertAllowedExternalWorkflowImport(specifier, abs);
      }
    }
  };
  visit(entryAbs);

  const root = lowestCommonAncestor([...visited.keys()].map((path) => dirname(path)));
  for (const { abs } of visited.values()) assertNoSymlinkSegmentsInBundle(root, abs);
  const modules: WorkflowSourceModule[] = [];
  const normalizedPaths = new Set<string>();
  for (const { abs, code } of visited.values()) {
    const normalized = relative(root, abs).split(sep).join("/");
    validateWorkflowModulePath(normalized);
    if (normalizedPaths.has(normalized)) {
      throw new Error(`workflow bundle contains duplicate module path ${normalized}`);
    }
    normalizedPaths.add(normalized);
    modules.push({ path: normalized, code });
  }
  modules.sort((a, b) => a.path.localeCompare(b.path));
  const entry = relative(root, entryAbs).split(sep).join("/");
  validateWorkflowModulePath(entry, "workflow entry path");
  return { kind: "bundle", entry, modules };
}

function assertNoSymlinkSegmentsInBundle(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || resolve(root, rel) !== path) {
    throw new Error(`workflow source path ${path} is outside inferred bundle root ${root}`);
  }
  let current = root;
  const segments = rel.split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`workflow source path ${path} contains symlink segment ${current}`);
    }
  }
}

function resolveLocalFileImport(importerPath: string, specifier: string): string {
  const base = resolve(dirname(importerPath), specifier);
  const explicitExt = extname(base);
  if (explicitExt) {
    if (!WORKFLOW_MODULE_EXTENSIONS.includes(explicitExt as ".ts" | ".tsx")) {
      throw new Error(
        `workflow import "${specifier}" from ${importerPath} uses unsupported extension "${explicitExt}"`,
      );
    }
    if (!existsSync(base) || !lstatSync(base).isFile()) {
      throw new Error(`workflow import "${specifier}" from ${importerPath} does not exist`);
    }
    return base;
  }

  const candidates = [
    ...WORKFLOW_MODULE_EXTENSIONS.map((candidateExt) => `${base}${candidateExt}`),
    ...WORKFLOW_INDEX_MODULES.map((indexName) => join(base, indexName)),
  ].filter((candidate) => existsSync(candidate) && lstatSync(candidate).isFile());
  if (candidates.length === 0) {
    throw new Error(`workflow import "${specifier}" from ${importerPath} does not exist`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `workflow import "${specifier}" from ${importerPath} is ambiguous: ${candidates.join(", ")}`,
    );
  }
  return candidates[0] as string;
}

function assertRegularWorkflowFile(path: string, label: string): void {
  if (!WORKFLOW_MODULE_EXTENSIONS.includes(extname(path) as ".ts" | ".tsx")) {
    throw new Error(`${label} ${path} must be a .ts or .tsx file`);
  }
  const lstat = lstatSync(path);
  if (lstat.isSymbolicLink()) throw new Error(`${label} ${path} must not be a symlink`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${label} ${path} must be a regular file`);
}

function lowestCommonAncestor(paths: string[]): string {
  if (paths.length === 0) throw new Error("workflow bundle has no modules");
  const [first, ...rest] = paths.map((path) => resolve(path).split(sep).filter(Boolean));
  if (!first) throw new Error("workflow bundle has no modules");
  const prefix = [...first];
  for (const parts of rest) {
    let i = 0;
    while (i < prefix.length && prefix[i] === parts[i]) i += 1;
    prefix.length = i;
  }
  const root = paths[0]?.startsWith(sep) ? sep : "";
  return prefix.length === 0 ? root || "." : join(root, ...prefix);
}
