import { isAbsolute, posix } from "node:path";
import { parse } from "acorn";
import {
  WORKFLOW_INDEX_MODULES,
  WORKFLOW_MODULE_EXTENSIONS,
  type WorkflowSourceModule,
} from "./source.ts";

type AnyNode = { type: string } & Record<string, unknown>;

const tsTranspiler = new Bun.Transpiler({ loader: "tsx" });

export function staticWorkflowImports(source: string, filename: string): string[] {
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

export function isLocalWorkflowImport(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

export function isUrlLikeSpecifier(specifier: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier);
}

export function validateWorkflowModulePath(path: string, label = "workflow module path"): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\")) {
    throw new Error(`${label} "${path}" is not a normalized relative POSIX path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} "${path}" is not a normalized relative POSIX path`);
  }
  if (segments.includes("node_modules")) {
    throw new Error(`${label} "${path}" must not include node_modules`);
  }
  if (!WORKFLOW_MODULE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    throw new Error(`${label} "${path}" must end in .ts or .tsx`);
  }
}

export function resolveBundledLocalImport(
  importerPath: string,
  specifier: string,
  modulesByPath: Map<string, WorkflowSourceModule>,
): string {
  if (!isLocalWorkflowImport(specifier)) {
    throw new Error(`workflow import "${specifier}" is not a local relative import`);
  }
  const base = posix.normalize(posix.join(posix.dirname(importerPath), specifier));
  if (base.startsWith("../") || base === ".." || base.startsWith("/") || base.includes("/../")) {
    throw new Error(`workflow import "${specifier}" from ${importerPath} escapes the bundle`);
  }
  const ext = posix.extname(base);
  if (ext) {
    if (!WORKFLOW_MODULE_EXTENSIONS.includes(ext as ".ts" | ".tsx")) {
      throw new Error(
        `workflow import "${specifier}" from ${importerPath} uses unsupported extension "${ext}"`,
      );
    }
    if (!modulesByPath.has(base)) {
      throw new Error(`workflow import "${specifier}" from ${importerPath} is missing from bundle`);
    }
    return base;
  }
  const candidates = [
    ...WORKFLOW_MODULE_EXTENSIONS.map((candidateExt) => `${base}${candidateExt}`),
    ...WORKFLOW_INDEX_MODULES.map((indexName) => posix.join(base, indexName)),
  ].filter((candidate) => modulesByPath.has(candidate));
  if (candidates.length === 0) {
    throw new Error(`workflow import "${specifier}" from ${importerPath} is missing from bundle`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `workflow import "${specifier}" from ${importerPath} is ambiguous: ${candidates.join(", ")}`,
    );
  }
  return candidates[0] as string;
}

export function assertAllowedExternalWorkflowImport(specifier: string, importerPath: string): void {
  if (isAbsolute(specifier) || isUrlLikeSpecifier(specifier)) {
    throw new Error(`workflow import "${specifier}" from ${importerPath} is not allowed`);
  }
  if (specifier !== "@kcosr/keel") {
    throw new Error(`workflow import "${specifier}" is not allowed; only @kcosr/keel is supported`);
  }
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
