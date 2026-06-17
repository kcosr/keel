import { describe, expect, test } from "bun:test";
import { normalizeAgentEnvironment, normalizeRunSecrets } from "./environment.ts";

describe("agent environment normalization", () => {
  test("normalizes literal vars and secret names deterministically", () => {
    expect(
      normalizeAgentEnvironment({
        vars: { ZED: "z", ALPHA: "a" },
        secrets: ["TOKEN_B", "TOKEN_A"],
      }),
    ).toEqual({
      vars: { ALPHA: "a", ZED: "z" },
      secrets: ["TOKEN_A", "TOKEN_B"],
    });
  });

  test("rejects unsupported environment shapes and keys", () => {
    expect(() => normalizeAgentEnvironment(null)).toThrow(/must be a plain object/);
    expect(() => normalizeAgentEnvironment({ vars: {}, extra: true })).toThrow(
      /environment\.extra is not supported/,
    );
    expect(() =>
      normalizeAgentEnvironment({ vars: { TOKEN: "literal" }, secrets: ["TOKEN"] }),
    ).toThrow(/cannot define TOKEN in both vars and secrets/);
    expect(() => normalizeAgentEnvironment({ vars: { MODE: 1 } })).toThrow(
      /environment\.vars\.MODE must be a string/,
    );
  });

  test("rejects invalid, reserved, duplicate, sparse, and hidden names", () => {
    expect(() => normalizeAgentEnvironment({ vars: { "1BAD": "x" } })).toThrow(/must match/);
    expect(() => normalizeAgentEnvironment({ vars: { KEEL_TOKEN: "x" } })).toThrow(
      /must not start with KEEL_/,
    );
    expect(() => normalizeAgentEnvironment({ secrets: ["__proto__"] })).toThrow(/reserved/);
    expect(() => normalizeAgentEnvironment({ secrets: ["TOKEN", "TOKEN"] })).toThrow(
      /duplicate TOKEN/,
    );

    const sparse = ["TOKEN"] as string[];
    sparse.length = 2;
    expect(() => normalizeAgentEnvironment({ secrets: sparse })).toThrow(/sparse array hole/);

    const keyed = ["TOKEN"] as string[] & { extra?: string };
    keyed.extra = "not allowed";
    expect(() => normalizeAgentEnvironment({ secrets: keyed })).toThrow(/non-index key extra/);

    const varsWithSymbol = { TOKEN: "x" } as Record<PropertyKey, unknown>;
    varsWithSymbol[Symbol("secret")] = "x";
    expect(() => normalizeAgentEnvironment({ vars: varsWithSymbol })).toThrow(/symbol keys/);

    const varsWithHidden = { TOKEN: "x" };
    Object.defineProperty(varsWithHidden, "HIDDEN", { value: "x", enumerable: false });
    expect(() => normalizeAgentEnvironment({ vars: varsWithHidden })).toThrow(
      /environment\.vars\.HIDDEN must be enumerable/,
    );
  });

  test("normalizes and validates launch-time run secrets", () => {
    expect(normalizeRunSecrets({ ZED: "z", ALPHA: "a" })).toEqual({ ALPHA: "a", ZED: "z" });
    expect(() => normalizeRunSecrets({ TOKEN: 1 })).toThrow(/runSecrets\.TOKEN must be a string/);
    expect(() => normalizeRunSecrets({ KEEL_TOKEN: "x" })).toThrow(/must not start with KEEL_/);
  });
});
