// Schema boundary (DESIGN.md §9.3).
//
// Keel accepts Zod schemas and raw JSON Schema; both validate a value and expose
// a structural representation used to hash the step `version` (§5.2). Zod's
// `.parse` satisfies the parse contract; `structural()` is optional (a schema
// without it contributes a constant to the version hash).

export interface Schema<T> {
  parse(value: unknown): T;
  /** Canonical structure (validation logic) for the version hash. Optional. */
  structural?(): unknown;
}

/** A schema that accepts anything — handy for steps/agents without a contract. */
export function passthrough<T = unknown>(): Schema<T> {
  return { parse: (v) => v as T };
}

/**
 * Wrap a raw JSON Schema object. `structural()` returns the schema itself (so
 * the version tracks schema changes). Phase 7 adds validation; for now it is a
 * structural carrier with a permissive parse.
 */
export function jsonSchema<T = unknown>(schema: object): Schema<T> {
  return {
    parse: (v) => v as T,
    structural: () => schema,
  };
}
