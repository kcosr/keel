// Realm test fixtures: each reaches for a forbidden ambient global and must
// throw the realm guidance error (§6 acceptance b/c). Selected by input.what.
import type { Ctx } from "../../ctx.ts";

export default async function forbidden(_ctx: Ctx, input: { what: string }): Promise<unknown> {
  switch (input.what) {
    case "math-random":
      return Math.random();
    case "date-now":
      return Date.now();
    case "new-date":
      return new Date().getTime();
    case "fetch":
      return (await fetch("http://example.com")).status;
    case "eval":
      // biome-ignore lint/security/noGlobalEval: fixture intentionally reaches the runtime shim.
      return globalThis.eval("1 + 1");
    case "function":
      return globalThis.Function("return 1")();
    case "process":
      return globalThis.process.env.PATH;
    case "bun-env":
      return Bun.env.PATH;
    case "bun-write":
      return Bun.write("/tmp/keel-forbidden-write", "nope");
    case "bun-spawn":
      return Bun.spawn(["true"]);
    default:
      throw new Error(`unknown case ${input.what}`);
  }
}
