// Module-helper extraction for structural versioning (DESIGN.md §5.2).
//
// A pure step's version must change when ANY code it depends on changes — its
// own fn body and the helpers it calls (the design's "bundle the fn as its own
// entry point so transitively referenced helpers fold in"). The host parses the
// workflow module AND its relatively-imported modules, producing a map of
// name → normalized source; the worker folds the fn's referenced closure into
// the version hash.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "acorn";

const transpiler = new Bun.Transpiler({ loader: "tsx", minifyWhitespace: true });
const IMPORT_EXTENSIONS = ["", ".ts", ".tsx"];
const INDEX_EXTENSIONS = [".ts", ".tsx"];

type AnyNode = { type: string; start: number; end: number } & Record<string, unknown>;

/**
 * name → normalized source for every top-level declaration reachable from a
 * workflow module, following relative imports. `fromPath` (the module's file
 * path) enables that traversal; without it only same-module helpers are folded.
 */
export function extractModuleHelpers(
  source: string,
  fromPath?: string,
  visited: Set<string> = new Set(),
): Record<string, string> {
  let js: string;
  try {
    js = transpiler.transformSync(source);
  } catch {
    return {};
  }
  let ast: { body: AnyNode[] };
  try {
    ast = parse(js, { ecmaVersion: "latest", sourceType: "module" }) as unknown as {
      body: AnyNode[];
    };
  } catch {
    return {};
  }

  const out: Record<string, string> = {};
  for (const stmt of ast.body) {
    // 1) top-level declarations in THIS module
    const node =
      stmt.type === "ExportNamedDeclaration" && stmt.declaration
        ? (stmt.declaration as AnyNode)
        : stmt;
    if (node.type === "FunctionDeclaration" && node.id) {
      out[(node.id as AnyNode).name as string] = js.slice(node.start, node.end);
    } else if (node.type === "VariableDeclaration") {
      for (const d of node.declarations as AnyNode[]) {
        const id = d.id as AnyNode;
        const init = d.init as AnyNode | undefined;
        if (id?.type === "Identifier" && init)
          out[id.name as string] = js.slice(init.start, init.end);
      }
    }

    // 2) follow relative imports so edits to an imported helper invalidate too.
    if ((stmt.type === "ImportDeclaration" || stmt.type === "ExportNamedDeclaration") && fromPath) {
      const spec = (stmt.source as AnyNode | undefined)?.value;
      if (typeof spec === "string" && (spec.startsWith("./") || spec.startsWith("../"))) {
        const childPath = resolveRelativeImport(fromPath, spec);
        if (!visited.has(childPath)) {
          visited.add(childPath);
          try {
            const childSrc = readFileSync(childPath, "utf8");
            Object.assign(out, extractModuleHelpers(childSrc, childPath, visited));
          } catch {
            // unreadable import (e.g. kernel module) — skip; it is not author code
          }
        }
      }
    }
  }
  return out;
}

function resolveRelativeImport(fromPath: string, spec: string): string {
  const base = resolve(dirname(fromPath), spec);
  for (const ext of IMPORT_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  for (const ext of INDEX_EXTENSIONS) {
    const candidate = join(base, `index${ext}`);
    if (existsSync(candidate) && lstatSync(candidate).isFile()) return candidate;
  }
  return base;
}
