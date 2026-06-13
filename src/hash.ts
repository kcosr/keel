// Canonical JSON serialization + SHA-256 (DESIGN.md §5.2–5.3).
//
// Hashes are load-bearing for step identity: two inputs that are semantically
// equal MUST hash identically regardless of key insertion order, and two that
// differ MUST hash differently. Canonical JSON gives us the first; SHA-256 over
// it gives us a stable content address.

import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Deterministically serialize a JSON value: object keys sorted, no incidental
 * whitespace, non-JSON values rejected. The output is a stable byte string
 * suitable for hashing.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  encode(value, out, []);
  return out.join("");
}

function encode(value: unknown, out: string[], path: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new HashError(`non-finite number (${value}) is not JSON-serializable`, path);
      }
      // JSON.stringify produces a canonical shortest round-trippable form for a
      // given IEEE-754 double; -0 normalizes to 0 here, which is intended.
      out.push(JSON.stringify(value === 0 ? 0 : value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "object": {
      if (Array.isArray(value)) {
        out.push("[");
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(",");
          // JSON turns `undefined` array holes into null; mirror that.
          const el = value[i];
          encode(el === undefined ? null : el, out, [...path, String(i)]);
        }
        out.push("]");
        return;
      }
      // Plain object. Reject anything exotic (Map/Set/Date/class instances) so a
      // non-serializable value can never silently enter a hash.
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        throw new HashError(`value is not a plain JSON object (got ${describe(value)})`, path);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined) // mirror JSON.stringify: drop undefined props
        .sort();
      out.push("{");
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i] as string;
        if (i > 0) out.push(",");
        out.push(JSON.stringify(key), ":");
        encode(obj[key], out, [...path, key]);
      }
      out.push("}");
      return;
    }
    default:
      // undefined, function, symbol, bigint
      throw new HashError(`value of type ${typeof value} is not JSON-serializable`, path);
  }
}

function describe(value: object): string {
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? "object";
}

export class HashError extends Error {
  readonly path: string[];
  constructor(message: string, path: string[]) {
    const loc = path.length > 0 ? ` at $.${path.join(".")}` : "";
    super(`${message}${loc}`);
    this.name = "HashError";
    this.path = path;
  }
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 hex digest of the canonical JSON encoding of a value. */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
