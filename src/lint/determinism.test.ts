import { describe, expect, test } from "bun:test";
import { lintWorkflowSource } from "./determinism.ts";

function rules(src: string): string[] {
  return lintWorkflowSource(src).map((v) => v.rule);
}

describe("determinism lint — forbidden ambient globals", () => {
  test("Date.now / Math.random / crypto.randomUUID / argless new Date()", () => {
    expect(rules("export default async () => Date.now();")).toContain("no-ambient-time-entropy");
    expect(rules("export default async () => Math.random();")).toContain("no-ambient-time-entropy");
    expect(rules("export default async () => crypto.randomUUID();")).toContain(
      "no-ambient-time-entropy",
    );
    expect(rules("export default async () => new Date();")).toContain("no-ambient-time-entropy");
  });

  test("Bun ambient APIs are rejected", () => {
    expect(rules("export default async () => Bun.env.PATH;")).toContain("no-bun-global");
    expect(rules('export default async () => Bun["env"].PATH;')).toContain("no-bun-global");
    expect(rules("export default async () => Bun.write('/tmp/x', 'x');")).toContain(
      "no-bun-global",
    );
    expect(rules("export default async () => Bun.spawn(['true']);")).toContain("no-bun-global");
  });

  test("new Date(ms) with an explicit arg is allowed", () => {
    expect(rules("export default async () => new Date(0).getTime();")).toEqual([]);
  });

  test("ctx.now()/ctx.random() are clean", () => {
    expect(rules("export default async (ctx) => ({ t: ctx.now(), r: ctx.random() });")).toEqual([]);
  });
});

describe("determinism lint — dynamic code & network", () => {
  test("eval / new Function / require / fetch", () => {
    expect(rules('export default async () => eval("1");')).toContain("no-dynamic-code");
    expect(rules("export default async () => new Function('return 1');")).toContain(
      "no-dynamic-code",
    );
    expect(rules('export default async () => require("fs");')).toContain("no-require");
    expect(rules('export default async () => fetch("http://x");')).toContain("no-network");
  });
});

describe("determinism lint — forbidden imports", () => {
  test("fs / child_process / http / bun", () => {
    expect(
      rules('import { readFileSync } from "node:fs";\nexport default async () => 1;'),
    ).toContain("no-forbidden-import");
    expect(rules('import cp from "child_process";\nexport default async () => 1;')).toContain(
      "no-forbidden-import",
    );
    expect(rules('export default async () => { await import("node:http"); };')).toContain(
      "no-forbidden-import",
    );
    expect(rules('import "bun";\nexport default async () => 1;')).toContain("no-forbidden-import");
  });

  test("allowed imports (zod, local modules) are clean", () => {
    expect(
      rules(
        'import { z } from "zod";\nimport { helper } from "./helper.ts";\nexport default async () => helper(z);',
      ),
    ).toEqual([]);
  });
});

describe("determinism lint — ctx.step capture (§5.3)", () => {
  test("capturing an enclosing local is rejected", () => {
    const src = `
      export default async function (ctx, input) {
        const raw = input.x + 1;
        return await ctx.step("k", {}, { y: 1 }, () => dedupe(raw));
      }
      function dedupe(v) { return v; }
    `;
    const rs = rules(src);
    expect(rs).toContain("no-step-capture");
  });

  test("passing data through inputs is clean", () => {
    const src = `
      export default async function (ctx, input) {
        const raw = input.x + 1;
        return await ctx.step("k", {}, { raw }, ({ raw }) => dedupe(raw));
      }
      function dedupe(v) { return v; }
    `;
    expect(rules(src)).toEqual([]);
  });

  test("module-scope helpers are allowed inside a step fn", () => {
    const src = `
      const TABLE = { a: 1 };
      export default async function (ctx) {
        return await ctx.step("k", {}, { n: 1 }, ({ n }) => lookup(n, TABLE));
      }
      function lookup(n, t) { return t[n] ?? n; }
    `;
    expect(rules(src)).toEqual([]);
  });

  test("a step fn at module top level cannot capture (no enclosing scope)", () => {
    const src = `
      const step = (ctx) => ctx.step("k", {}, { n: 1 }, ({ n }) => n + 1);
      export default async function (ctx) { return step(ctx); }
    `;
    expect(rules(src).filter((r) => r === "no-step-capture")).toEqual([]);
  });
});
