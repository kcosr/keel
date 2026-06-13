// Phase 6 fixture: three steps. `indep` is independent; `base` feeds `derived`.
// Sibling files edit exactly one step so a rerun re-executes only what changed.
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const num = passthrough<number>();

export default async function cascade(ctx: Ctx, input: { n: number }): Promise<number> {
  const indep = await ctx.step("indep", num, { n: input.n }, ({ n }) => n + 100);
  const base = await ctx.step("base", num, { n: input.n }, ({ n }) => n * 2);
  const derived = await ctx.step("derived", num, { base }, ({ base }) => base + 1);
  return indep + derived;
}
