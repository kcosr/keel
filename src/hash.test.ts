import { describe, expect, test } from "bun:test";
import { HashError, canonicalJson, hashJson, sha256Hex } from "./hash.ts";

describe("canonicalJson", () => {
  test("object key order is irrelevant", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test("nested key order is irrelevant", () => {
    const x = { outer: { z: 1, a: 2 }, list: [{ q: 1, p: 2 }] };
    const y = { list: [{ p: 2, q: 1 }], outer: { a: 2, z: 1 } };
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  test("array order is significant", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  test("primitives", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson(-0)).toBe("0");
  });

  test("drops undefined object properties (JSON semantics)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  test("undefined array holes become null", () => {
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
  });

  test("rejects non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(HashError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(HashError);
  });

  test("rejects exotic objects with a path", () => {
    expect(() => canonicalJson({ a: { b: new Map() } })).toThrow(/\$\.a\.b/);
    expect(() => canonicalJson(new Date())).toThrow(HashError);
  });

  test("rejects bigint/function/symbol", () => {
    expect(() => canonicalJson(10n)).toThrow(HashError);
    expect(() => canonicalJson(() => 1)).toThrow(HashError);
    expect(() => canonicalJson(Symbol("x"))).toThrow(HashError);
  });
});

describe("hashing", () => {
  test("sha256Hex is a 64-char hex digest", () => {
    const h = sha256Hex("");
    expect(h).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("hashJson is stable across key order and differs on content", () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });
});
