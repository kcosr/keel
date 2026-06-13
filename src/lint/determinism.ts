// Determinism lint (DESIGN.md §6 layer 1) — the static gate.
//
// Rejects, in workflow source: forbidden ambient globals (Date.now, Math.random,
// crypto.randomUUID, Bun.*, argless new Date(), eval, new Function), forbidden
// module imports (fs/child_process/http/...), and illegal data capture by a
// ctx.step fn (§5.3 — data must flow through the explicit `inputs` argument, not
// be captured from an enclosing function scope; module-scope helpers are
// allowed).
//
// AST-based (acorn) so it is precise rather than regex-fragile. acorn's exported
// `Node` is not a discriminated union, so the analysis uses a loose `AnyNode`
// view and checks `.type` explicitly. The realm runner runs this before spawning
// the worker; a violation fails the run with guidance.

import { builtinModules } from "node:module";
import { parse } from "acorn";

/** Loose AST node view (acorn nodes have all fields at runtime). */
type AnyNode = { type: string } & Record<string, unknown>;

export interface Violation {
  rule: string;
  message: string;
  line: number;
  column: number;
}

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const FORBIDDEN_MODULES = new Set([
  ...NODE_BUILTINS,
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "http",
  "node:http",
  "https",
  "node:https",
  "net",
  "node:net",
  "dgram",
  "node:dgram",
  "dns",
  "node:dns",
  "os",
  "node:os",
  "worker_threads",
  "node:worker_threads",
  "bun",
  "@kcosr/keel/execute",
]);

const FORBIDDEN_GLOBALS = new Set(["process", "module", "require", "Buffer", "URLPattern"]);

// Globals every workflow may rely on (pure/deterministic or provided by ctx).
const ALLOWED_GLOBALS = new Set([
  "ctx",
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "Infinity",
  "NaN",
  "undefined",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "encodeURIComponent",
  "decodeURIComponent",
  "structuredClone",
  "BigInt",
  "globalThis",
]);

const tsTranspiler = new Bun.Transpiler({ loader: "tsx" });

export function lintWorkflowSource(source: string, filename = "workflow"): Violation[] {
  const violations: Violation[] = [];
  // Workflows are authored in TS; strip type syntax (and type-only imports) to
  // plain JS so acorn can parse them. Real imports/expressions are preserved.
  let js: string;
  try {
    js = tsTranspiler.transformSync(source);
  } catch (err) {
    return [parseError(filename, `could not transpile: ${(err as Error).message}`)];
  }
  let ast: AnyNode;
  try {
    ast = parse(js, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    }) as unknown as AnyNode;
  } catch (err) {
    return [parseError(filename, `could not parse: ${(err as Error).message}`)];
  }

  const moduleScope = collectModuleBindings(ast);
  const at = (n: AnyNode) => locOf(n);

  walk(ast, (node, ancestors) => {
    // Date.now / crypto.randomUUID / performance.now / Math.random
    if (node.type === "MemberExpression") {
      const obj = node.object as AnyNode;
      const prop = node.property as AnyNode;
      if (obj?.type === "Identifier" && obj.name === "Bun" && !moduleScope.has("Bun")) {
        violations.push({
          rule: "no-bun-global",
          message:
            "Bun.* is not allowed in workflow code; use ctx.* or a host-mediated capability.",
          ...at(node),
        });
      }
      if (isForbiddenGlobalMember(obj, moduleScope)) {
        violations.push({
          rule: "no-ambient-host-global",
          message: `${memberRootName(obj)}.* is not allowed in workflow code; use ctx.* or explicit inputs.`,
          ...at(node),
        });
      }
      if (obj?.type === "Identifier" && prop?.type === "Identifier") {
        const o = obj.name as string;
        const p = prop.name as string;
        const banned: Record<string, string[]> = {
          Date: ["now"],
          crypto: ["randomUUID", "getRandomValues"],
          performance: ["now"],
        };
        if (banned[o]?.includes(p) && !moduleScope.has(o)) {
          violations.push({
            rule: "no-ambient-time-entropy",
            message: `${o}.${p}() is non-deterministic and breaks resume; use ctx.now()/ctx.random().`,
            ...at(node),
          });
        }
        if (o === "Math" && p === "random") {
          violations.push({
            rule: "no-ambient-time-entropy",
            message: "Math.random() is non-deterministic and breaks resume; use ctx.random().",
            ...at(node),
          });
        }
      }
    }

    if (
      node.type === "Identifier" &&
      FORBIDDEN_GLOBALS.has(node.name as string) &&
      !moduleScope.has(node.name as string) &&
      isReferenceIdentifier(node, ancestors)
    ) {
      violations.push({
        rule: "no-ambient-host-global",
        message: `${node.name as string} is not allowed in workflow code.`,
        ...at(node),
      });
    }

    // argless new Date() / new Function(...)
    if (node.type === "NewExpression") {
      const callee = node.callee as AnyNode;
      const args = node.arguments as AnyNode[];
      if (callee?.type === "Identifier") {
        if (callee.name === "Date" && args.length === 0 && !moduleScope.has("Date")) {
          violations.push({
            rule: "no-ambient-time-entropy",
            message: "new Date() with no arguments is non-deterministic; use ctx.now().",
            ...at(node),
          });
        }
        if (callee.name === "Function") {
          violations.push({
            rule: "no-dynamic-code",
            message: "new Function(...) is not allowed in workflow code.",
            ...at(node),
          });
        }
      }
    }

    // eval / Function / require / fetch as calls, including globalThis.eval(...)
    if (node.type === "CallExpression") {
      const callee = node.callee as AnyNode;
      if (callee?.type === "Identifier") {
        const name = callee.name as string;
        if (name === "eval") {
          violations.push({
            rule: "no-dynamic-code",
            message: "eval(...) is not allowed in workflow code.",
            ...at(node),
          });
        } else if (name === "require") {
          violations.push({
            rule: "no-require",
            message: "require(...) is not allowed; use top-level imports (and not fs/net/etc).",
            ...at(node),
          });
        } else if (name === "fetch") {
          violations.push({
            rule: "no-network",
            message:
              "fetch(...) is not allowed in workflow code; use ctx.agent() or journaled inputs.",
            ...at(node),
          });
        } else if (name === "Function") {
          violations.push({
            rule: "no-dynamic-code",
            message: "Function(...) is not allowed in workflow code.",
            ...at(node),
          });
        }
      } else if (callee?.type === "MemberExpression" && isGlobalThisMember(callee, "eval")) {
        violations.push({
          rule: "no-dynamic-code",
          message: "globalThis.eval(...) is not allowed in workflow code.",
          ...at(node),
        });
      } else if (callee?.type === "MemberExpression" && isGlobalThisMember(callee, "Function")) {
        violations.push({
          rule: "no-dynamic-code",
          message: "globalThis.Function(...) is not allowed in workflow code.",
          ...at(node),
        });
      }
    }

    // forbidden static/dynamic imports
    if (node.type === "ImportDeclaration") {
      const src = (node.source as AnyNode)?.value;
      if (typeof src === "string" && FORBIDDEN_MODULES.has(src)) {
        violations.push({
          rule: "no-forbidden-import",
          message: `importing "${src}" is not allowed in workflow code (capability/non-determinism).`,
          ...at(node),
        });
      }
    }
    if (node.type === "ImportExpression") {
      const src = node.source as AnyNode;
      if (src?.type === "Literal" && typeof src.value === "string") {
        if (!FORBIDDEN_MODULES.has(src.value)) return;
        violations.push({
          rule: "no-forbidden-import",
          message: `dynamic import("${src.value}") is not allowed in workflow code.`,
          ...at(node),
        });
      } else {
        violations.push({
          rule: "no-dynamic-import",
          message: "dynamic import(...) is not allowed in workflow code.",
          ...at(node),
        });
      }
    }

    // ctx.step(key, schema, inputs, fn) — fn must not capture enclosing data
    if (isCtxStepCall(node)) {
      const args = node.arguments as AnyNode[];
      const fnArg = args[3];
      if (
        fnArg &&
        (fnArg.type === "ArrowFunctionExpression" || fnArg.type === "FunctionExpression")
      ) {
        checkNoCapture(fnArg, moduleScope, ancestors, violations, at);
      }
    }
  });

  return violations;
}

function isGlobalThisMember(node: AnyNode, propName: string): boolean {
  const obj = node.object as AnyNode | undefined;
  const prop = node.property as AnyNode | undefined;
  return (
    obj?.type === "Identifier" &&
    obj.name === "globalThis" &&
    prop?.type === "Identifier" &&
    prop.name === propName
  );
}

function isForbiddenGlobalMember(obj: AnyNode | undefined, moduleScope: Set<string>): boolean {
  const root = memberRootName(obj);
  return root !== null && FORBIDDEN_GLOBALS.has(root) && !moduleScope.has(root);
}

function memberRootName(node: AnyNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "MemberExpression") {
    const obj = node.object as AnyNode | undefined;
    const prop = node.property as AnyNode | undefined;
    if (obj?.type === "Identifier" && obj.name === "globalThis" && prop?.type === "Identifier") {
      return prop.name as string;
    }
    return memberRootName(obj);
  }
  return null;
}

function isReferenceIdentifier(node: AnyNode, ancestors: AnyNode[]): boolean {
  const parent = ancestors.at(-1);
  if (!parent) return true;
  if (
    (parent.type === "VariableDeclarator" && parent.id === node) ||
    ((parent.type === "FunctionDeclaration" ||
      parent.type === "FunctionExpression" ||
      parent.type === "ClassDeclaration") &&
      parent.id === node)
  ) {
    return false;
  }
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  if (parent.type === "Property" && parent.key === node && !parent.computed) return false;
  if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier") return false;
  return true;
}

function parseError(filename: string, message: string): Violation {
  return { rule: "parse-error", message: `${filename}: ${message}`, line: 0, column: 0 };
}

function locOf(n: AnyNode): { line: number; column: number } {
  const loc = n.loc as { start?: { line: number; column: number } } | undefined;
  return { line: loc?.start?.line ?? 0, column: loc?.start?.column ?? 0 };
}

function isCtxStepCall(node: AnyNode): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AnyNode | undefined;
  if (callee?.type !== "MemberExpression") return false;
  const obj = callee.object as AnyNode;
  const prop = callee.property as AnyNode;
  return (
    obj?.type === "Identifier" &&
    obj.name === "ctx" &&
    prop?.type === "Identifier" &&
    prop.name === "step"
  );
}

/**
 * Flag identifiers a step fn uses that are neither its own params, locally
 * declared, module-scope, nor allowed globals — i.e. captured from an enclosing
 * function scope (§5.3 forbids capturing run data; pass it via `inputs`).
 */
function checkNoCapture(
  fn: AnyNode,
  moduleScope: Set<string>,
  ancestors: AnyNode[],
  out: Violation[],
  at: (n: AnyNode) => { line: number; column: number },
): void {
  const bound = new Set<string>(moduleScope);
  for (const g of ALLOWED_GLOBALS) bound.add(g);
  for (const p of fn.params as AnyNode[]) collectPatternNames(p, bound);
  collectLocalBindings(fn.body as AnyNode, bound);

  const enclosingFns = ancestors.filter(
    (a) =>
      a !== fn &&
      (a.type === "FunctionDeclaration" ||
        a.type === "FunctionExpression" ||
        a.type === "ArrowFunctionExpression"),
  );
  if (enclosingFns.length === 0) return;

  const free = new Set<string>();
  collectFreeIdentifiers(fn.body as AnyNode, bound, free);
  for (const name of free) {
    out.push({
      rule: "no-step-capture",
      message: `ctx.step fn captures "${name}" from an enclosing scope; pass it through the inputs argument so it is hashed (§5.3).`,
      ...at(fn),
    });
  }
}

// ---- scope helpers --------------------------------------------------------

function collectModuleBindings(ast: AnyNode): Set<string> {
  const names = new Set<string>();
  for (const stmt of ast.body as AnyNode[]) {
    const id = stmt.id as AnyNode | undefined;
    if (stmt.type === "FunctionDeclaration" && id) names.add(id.name as string);
    else if (stmt.type === "ClassDeclaration" && id) names.add(id.name as string);
    else if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations as AnyNode[]) collectPatternNames(d.id as AnyNode, names);
    } else if (stmt.type === "ImportDeclaration") {
      for (const spec of stmt.specifiers as AnyNode[])
        names.add((spec.local as AnyNode).name as string);
    } else if (stmt.type === "ExportNamedDeclaration" && stmt.declaration) {
      const decl = stmt.declaration as AnyNode;
      if (decl.type === "FunctionDeclaration" && decl.id)
        names.add((decl.id as AnyNode).name as string);
      else if (decl.type === "VariableDeclaration")
        for (const d of decl.declarations as AnyNode[]) collectPatternNames(d.id as AnyNode, names);
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const decl = stmt.declaration as AnyNode;
      if (decl?.type === "FunctionDeclaration" && decl.id)
        names.add((decl.id as AnyNode).name as string);
    }
  }
  return names;
}

function collectPatternNames(pat: AnyNode, out: Set<string>): void {
  switch (pat.type) {
    case "Identifier":
      out.add(pat.name as string);
      break;
    case "ObjectPattern":
      for (const prop of pat.properties as AnyNode[]) {
        if (prop.type === "RestElement") collectPatternNames(prop.argument as AnyNode, out);
        else collectPatternNames(prop.value as AnyNode, out);
      }
      break;
    case "ArrayPattern":
      for (const el of pat.elements as (AnyNode | null)[]) if (el) collectPatternNames(el, out);
      break;
    case "AssignmentPattern":
      collectPatternNames(pat.left as AnyNode, out);
      break;
    case "RestElement":
      collectPatternNames(pat.argument as AnyNode, out);
      break;
  }
}

function collectLocalBindings(node: AnyNode, out: Set<string>): void {
  walkShallow(node, (n) => {
    if (n.type === "VariableDeclaration") {
      for (const d of n.declarations as AnyNode[]) collectPatternNames(d.id as AnyNode, out);
    } else if (n.type === "FunctionDeclaration" && n.id) {
      out.add((n.id as AnyNode).name as string);
    }
    // do not descend into nested functions for binding collection
    return (
      n.type !== "FunctionDeclaration" &&
      n.type !== "FunctionExpression" &&
      n.type !== "ArrowFunctionExpression"
    );
  });
}

function collectFreeIdentifiers(node: AnyNode, bound: Set<string>, out: Set<string>): void {
  const visit = (n: AnyNode, locallyBound: Set<string>): void => {
    if (n.type === "Identifier") {
      const name = n.name as string;
      if (!locallyBound.has(name)) out.add(name);
      return;
    }
    if (n.type === "MemberExpression") {
      visit(n.object as AnyNode, locallyBound);
      if (n.computed) visit(n.property as AnyNode, locallyBound);
      return;
    }
    if (n.type === "Property") {
      // an object-literal key is not a reference; only the value is
      if (!n.computed) {
        visit(n.value as AnyNode, locallyBound);
        return;
      }
    }
    if (
      n.type === "FunctionExpression" ||
      n.type === "ArrowFunctionExpression" ||
      n.type === "FunctionDeclaration"
    ) {
      const inner = new Set(locallyBound);
      for (const p of n.params as AnyNode[]) collectPatternNames(p, inner);
      collectLocalBindings(n.body as AnyNode, inner);
      visit(n.body as AnyNode, inner);
      return;
    }
    for (const child of childNodes(n)) visit(child, locallyBound);
  };
  visit(node, bound);
}

// ---- minimal walkers ------------------------------------------------------

function walk(root: AnyNode, fn: (node: AnyNode, ancestors: AnyNode[]) => void): void {
  const ancestors: AnyNode[] = [];
  const visit = (n: AnyNode): void => {
    fn(n, ancestors);
    ancestors.push(n);
    for (const child of childNodes(n)) visit(child);
    ancestors.pop();
  };
  visit(root);
}

function walkShallow(root: AnyNode, fn: (node: AnyNode) => boolean): void {
  const visit = (n: AnyNode): void => {
    if (fn(n)) for (const child of childNodes(n)) visit(child);
  };
  for (const child of childNodes(root)) visit(child);
}

function childNodes(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const v of value) if (isNode(v)) out.push(v);
    } else if (isNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function isNode(v: unknown): v is AnyNode {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

export function formatViolations(violations: Violation[], filename: string): string {
  return violations
    .map((v) => `  ${filename}:${v.line}:${v.column}  [${v.rule}] ${v.message}`)
    .join("\n");
}
