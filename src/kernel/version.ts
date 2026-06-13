// Structural step version (DESIGN.md §5.2).
//
// version = hash(structuralSchemaHash + specHash + declaredCapabilities + bump).
// It changes only when *what a step does* changes — not on comment/whitespace
// edits. For pure steps the spec is the fn's normalized source; for agent steps
// (Phase 7) it is the resolved prompt.

import { hashJson, sha256Hex } from "../hash.ts";
import type { Schema } from "./schema.ts";

const transpiler = new Bun.Transpiler({ loader: "ts", minifyWhitespace: true });

/**
 * Normalize a step fn's source so comment and whitespace edits do not change it.
 * (Identifier-rename canonicalization needs a full bundling minifier; an
 * incidental rename conservatively re-runs the one pure step, which is safe
 * under early cutoff — §5.4.)
 */
export function normalizeFnSource(fn: (...args: never[]) => unknown): string {
  const src = fn.toString();
  try {
    return transpiler.transformSync(`const __keel_fn = ${src};`).trim();
  } catch {
    // Not a standalone expression (e.g. a method); fall back to raw source.
    return src;
  }
}

/** Canonical hash of a schema's structure (validation logic), order-independent. */
export function structuralSchemaHash(schema: Schema<unknown> | undefined): string {
  if (!schema) return sha256Hex("no-schema");
  const structure = schema.structural?.() ?? null;
  return hashJson(structure);
}

export interface VersionParts {
  /** Pure step: the fn; agent step: omit and pass `spec`. */
  fn?: (...args: never[]) => unknown;
  /** Agent step: the resolved prompt (and anything else that defines intent). */
  spec?: unknown;
  schema?: Schema<unknown> | undefined;
  capabilities?: unknown;
  /** Author-controlled manual invalidation. */
  bump?: string | number;
  /** Normalized sources of module helpers the fn transitively references (§5.2). */
  helpers?: string[];
}

export function computeVersion(parts: VersionParts): string {
  return hashJson({
    spec: parts.fn ? normalizeFnSource(parts.fn) : (parts.spec ?? null),
    schema: structuralSchemaHash(parts.schema),
    capabilities: parts.capabilities ?? null,
    bump: parts.bump ?? null,
    helpers: parts.helpers ?? null,
  });
}

/**
 * Closure of module helpers a fn references, as sorted normalized sources. An
 * identifier scan over the `helpers` map over-approximates (a name in a string
 * causes a harmless extra dependency); it covers same-module helpers and those
 * reachable via relative imports (extractModuleHelpers traverses them). The one
 * residual gap is an aliased import binding (`import { h as x }`), where the fn
 * references `x` but the map is keyed by `h` — such an edit can under-invalidate
 * until a full bundler/import-binding resolver exists. Folding helper sources in
 * closes the gap of hashing fn.toString() alone.
 */
export function closureOfHelpers(fnSource: string, helpers: Record<string, string>): string[] {
  const idRe = /[A-Za-z_$][\w$]*/g;
  const included = new Set<string>();
  const queue: string[] = [];
  const scan = (src: string): void => {
    for (const m of src.matchAll(idRe)) {
      const name = m[0];
      if (helpers[name] !== undefined && !included.has(name)) {
        included.add(name);
        queue.push(name);
      }
    }
  };
  scan(fnSource);
  while (queue.length > 0) {
    const name = queue.shift() as string;
    scan(helpers[name] as string);
  }
  return [...included].sort().map((n) => helpers[n] as string);
}
