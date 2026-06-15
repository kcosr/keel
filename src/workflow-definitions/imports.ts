import { isAbsolute, posix } from "node:path";
import {
  WORKFLOW_INDEX_MODULES,
  WORKFLOW_MODULE_EXTENSIONS,
  type WorkflowSourceModule,
} from "./source.ts";

export function staticWorkflowImports(source: string, filename: string): string[] {
  const imports: string[] = [];
  let i = 0;
  while (i < source.length) {
    i = skipTrivia(source, i);
    const token = readIdentifier(source, i);
    if (!token) {
      i = skipNonCodeToken(source, i, filename);
      continue;
    }
    if (token.value === "import") {
      i = parseImportDeclaration(source, token.end, filename, imports);
      continue;
    }
    if (token.value === "export") {
      i = parseExportDeclaration(source, token.end, filename, imports);
      continue;
    }
    i = token.end;
  }
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

function parseImportDeclaration(
  source: string,
  pos: number,
  filename: string,
  imports: string[],
): number {
  const next = skipTrivia(source, pos);
  if (source[next] === "(") {
    throw new Error(`dynamic import(...) is not allowed in workflow code: ${filename}`);
  }
  const first = readIdentifier(source, next);
  if (first?.value === "type") {
    const afterType = readIdentifier(source, skipTrivia(source, first.end));
    if (afterType?.value !== "from") return skipStatement(source, first.end, filename);
  }

  const sideEffect = readStringLiteral(source, next);
  if (sideEffect) {
    imports.push(sideEffect.value);
    return sideEffect.end;
  }

  const spec = findFromSpecifier(source, next, filename);
  if (spec) {
    imports.push(spec.value);
    return spec.end;
  }
  return skipStatement(source, next, filename);
}

function parseExportDeclaration(
  source: string,
  pos: number,
  filename: string,
  imports: string[],
): number {
  const next = skipTrivia(source, pos);
  const first = readIdentifier(source, next);
  if (first?.value === "type") return skipStatement(source, first.end, filename);

  const spec = findFromSpecifier(source, next, filename);
  if (spec) {
    imports.push(spec.value);
    return spec.end;
  }
  return skipStatement(source, next, filename);
}

function findFromSpecifier(
  source: string,
  pos: number,
  filename: string,
): { value: string; end: number } | null {
  let i = pos;
  while (i < source.length) {
    i = skipTrivia(source, i);
    const ch = source[i];
    if (ch === ";") return null;
    const token = readIdentifier(source, i);
    if (token) {
      if (token.value === "from") {
        const literal = readStringLiteral(source, skipTrivia(source, token.end));
        return literal ? { value: literal.value, end: literal.end } : null;
      }
      i = token.end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringLiteral(source, i, filename);
      continue;
    }
    if (ch === "/") {
      i = skipRegexLiteral(source, i);
      continue;
    }
    i += 1;
  }
  return null;
}

function skipStatement(source: string, pos: number, filename: string): number {
  let i = pos;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ";" || ch === "\n" || ch === "\r") return i + 1;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipStringLiteral(source, i, filename);
      continue;
    }
    if (ch === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      i = skipTrivia(source, i);
      continue;
    }
    if (ch === "/") {
      i = skipRegexLiteral(source, i);
      continue;
    }
    i += 1;
  }
  return i;
}

function skipTrivia(source: string, pos: number): number {
  let i = pos;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch ?? "")) {
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, source.length);
      continue;
    }
    break;
  }
  return i;
}

function skipNonCodeToken(source: string, pos: number, filename: string): number {
  const ch = source[pos];
  if (ch === "'" || ch === '"' || ch === "`") return skipStringLiteral(source, pos, filename);
  if (ch === "/") return skipRegexLiteral(source, pos);
  return pos + 1;
}

function readIdentifier(source: string, pos: number): { value: string; end: number } | null {
  const first = source[pos];
  if (!first || !/[A-Za-z_$]/.test(first)) return null;
  let end = pos + 1;
  while (end < source.length && /[A-Za-z0-9_$]/.test(source[end] as string)) end += 1;
  return { value: source.slice(pos, end), end };
}

function readStringLiteral(source: string, pos: number): { value: string; end: number } | null {
  const quote = source[pos];
  if (quote !== "'" && quote !== '"') return null;
  let out = "";
  let i = pos + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === quote) return { value: out, end: i + 1 };
    if (ch === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return null;
}

function skipStringLiteral(source: string, pos: number, filename: string): number {
  const quote = source[pos];
  let i = pos + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  throw new Error(`could not parse workflow imports in ${filename}: unterminated string literal`);
}

function skipRegexLiteral(source: string, pos: number): number {
  let i = pos + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      i += 1;
      continue;
    }
    if (ch === "]") {
      inClass = false;
      i += 1;
      continue;
    }
    if (ch === "/" && !inClass) {
      i += 1;
      while (i < source.length && /[A-Za-z]/.test(source[i] as string)) i += 1;
      return i;
    }
    if (ch === "\n" || ch === "\r") return pos + 1;
    i += 1;
  }
  return pos + 1;
}
