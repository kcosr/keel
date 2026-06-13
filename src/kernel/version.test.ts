import { describe, expect, test } from "bun:test";
import { jsonSchema, passthrough } from "./schema.ts";
import { computeVersion, normalizeFnSource } from "./version.ts";

describe("normalizeFnSource — incidental edits don't change the hash", () => {
  test("comment and whitespace differences normalize identically", () => {
    const a = (i: { raw: number }) => {
      // dedupe the findings
      const result = i.raw + 1;
      return result;
    };
    const b = (i: { raw: number }) => {
      const result = i.raw + 1;

      return result;
    };
    expect(normalizeFnSource(a)).toBe(normalizeFnSource(b));
  });

  test("a logic change does change the normalized source", () => {
    const a = (i: { raw: number }) => i.raw + 1;
    const b = (i: { raw: number }) => i.raw + 2;
    expect(normalizeFnSource(a)).not.toBe(normalizeFnSource(b));
  });
});

describe("computeVersion", () => {
  const schemaA = jsonSchema({ type: "object", properties: { a: { type: "number" } } });
  const schemaB = jsonSchema({ type: "object", properties: { b: { type: "string" } } });

  test("a comment edit in the fn does not change version", () => {
    const a = (i: { n: number }) => {
      return i.n + 1;
    };
    const withComment = (i: { n: number }) => {
      // a comment
      return i.n + 1;
    };
    expect(computeVersion({ fn: a, schema: schemaA })).toBe(
      computeVersion({ fn: withComment, schema: schemaA }),
    );
  });

  test("a logic edit changes version", () => {
    const a = (i: { n: number }) => i.n + 1;
    const b = (i: { n: number }) => i.n * 2;
    expect(computeVersion({ fn: a, schema: schemaA })).not.toBe(
      computeVersion({ fn: b, schema: schemaA }),
    );
  });

  test("a schema change changes version even with the same fn", () => {
    const fn = (i: { n: number }) => i.n + 1;
    expect(computeVersion({ fn, schema: schemaA })).not.toBe(
      computeVersion({ fn, schema: schemaB }),
    );
  });

  test("an author bump changes version", () => {
    const fn = (i: { n: number }) => i.n + 1;
    expect(computeVersion({ fn, schema: schemaA })).not.toBe(
      computeVersion({ fn, schema: schemaA, bump: "v2" }),
    );
  });

  test("agent-style spec: prompt change changes version", () => {
    const s = passthrough();
    expect(computeVersion({ spec: "review the auth module", schema: s })).not.toBe(
      computeVersion({ spec: "review the network module", schema: s }),
    );
  });
});
