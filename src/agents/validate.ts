// Minimal JSON Schema validator + extraction (DESIGN.md §10.3).
//
// Covers the subset the review workload and typical agent contracts use: type,
// properties, required, items, enum, additionalProperties:false, plus the JSON
// extraction ladder (direct → fenced code block → balanced braces). This is the
// host-side structured-output gate; a failing output triggers a bounded retry.

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value?: unknown;
}

/** Pull a JSON value out of an agent's free-text message. */
export function extractJson(text: string): { ok: boolean; value?: unknown; error?: string } {
  const trimmed = text.trim();
  // 1) direct parse
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // continue
  }
  // 2) fenced code block ```json ... ``` or ``` ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return { ok: true, value: JSON.parse(fence[1].trim()) };
    } catch {
      // continue
    }
  }
  // 3) first balanced { ... } or [ ... ]
  const balanced = firstBalanced(trimmed);
  if (balanced) {
    try {
      return { ok: true, value: JSON.parse(balanced) };
    } catch {
      // continue
    }
  }
  return { ok: false, error: "no parseable JSON found in agent output" };
}

function firstBalanced(s: string): string | null {
  const open = s.search(/[[{]/);
  if (open < 0) return null;
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 0) return s.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Tolerantly coerce a value toward a schema before validation (real LLM output
 * drifts): lowercase a string that should match a lowercase enum, stringify a
 * number for a string field, and drop additionalProperties:false extras. This
 * keeps the contract while absorbing minor model deviations.
 */
export function coerceToSchema(value: unknown, schema: unknown): unknown {
  const s = schema as JsonSchema | undefined;
  if (!s || typeof s !== "object") return value;

  if (s.enum && typeof value === "string") {
    const lc = value.toLowerCase();
    const hit = s.enum.find((e) => typeof e === "string" && e.toLowerCase() === lc);
    return hit ?? value;
  }
  const wantsString = s.type === "string" || (Array.isArray(s.type) && s.type.includes("string"));
  if (wantsString && typeof value === "number") return String(value);

  if (Array.isArray(value) && s.items) return value.map((v) => coerceToSchema(v, s.items));

  if (value && typeof value === "object" && !Array.isArray(value) && s.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (s.properties[k]) out[k] = coerceToSchema(v, s.properties[k]);
      else if (s.additionalProperties === false) {
        // drop unknown property
      } else out[k] = v;
    }
    return out;
  }
  return value;
}

/** Validate a value against a (subset) JSON Schema. */
export function validateJsonSchema(value: unknown, schema: unknown, path = "$"): ValidationResult {
  const errors: string[] = [];
  check(value, schema as JsonSchema, path, errors);
  return errors.length === 0 ? { ok: true, errors: [], value } : { ok: false, errors };
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
}

function check(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return;

  if (schema.enum) {
    if (!schema.enum.some((e) => deepEqual(e, value))) {
      errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
    }
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join("|")}, got ${jsonType(value)}`);
      return;
    }
  }

  if (jsonType(value) === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in obj) check(obj[key], sub, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties))
          errors.push(`${path}.${key}: additional property not allowed`);
      }
    }
  }

  if (jsonType(value) === "array" && schema.items) {
    const arr = value as unknown[];
    arr.forEach((el, i) => check(el, schema.items as JsonSchema, `${path}[${i}]`, errors));
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return jsonType(value) === "object";
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
