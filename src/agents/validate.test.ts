import { describe, expect, test } from "bun:test";
import { extractJson, validateJsonSchema } from "./validate.ts";

describe("extractJson — extraction ladder", () => {
  test("direct JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  test("fenced code block", () => {
    expect(extractJson('here:\n```json\n{"a":2}\n```\nthanks').value).toEqual({ a: 2 });
  });
  test("balanced braces inside prose", () => {
    expect(extractJson('The answer is {"a":3} ok').value).toEqual({ a: 3 });
  });
  test("nested braces and strings with braces", () => {
    expect(extractJson('x {"s":"a{b}c","n":[1,{"k":2}]} y').value).toEqual({
      s: "a{b}c",
      n: [1, { k: 2 }],
    });
  });
  test("no JSON", () => {
    expect(extractJson("just text").ok).toBe(false);
  });
});

describe("validateJsonSchema — subset", () => {
  const findings = {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "severity"],
          properties: {
            title: { type: "string" },
            severity: { type: "string", enum: ["low", "high"] },
          },
        },
      },
    },
  };

  test("valid", () => {
    expect(validateJsonSchema({ findings: [{ title: "x", severity: "high" }] }, findings).ok).toBe(
      true,
    );
  });
  test("missing required", () => {
    const r = validateJsonSchema({ findings: [{ title: "x" }] }, findings);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/severity.*required/);
  });
  test("enum violation", () => {
    expect(validateJsonSchema({ findings: [{ title: "x", severity: "mid" }] }, findings).ok).toBe(
      false,
    );
  });
  test("additional property rejected", () => {
    expect(validateJsonSchema({ findings: [], extra: 1 }, findings).ok).toBe(false);
  });
  test("wrong type", () => {
    expect(validateJsonSchema({ findings: "nope" }, findings).ok).toBe(false);
  });
});
