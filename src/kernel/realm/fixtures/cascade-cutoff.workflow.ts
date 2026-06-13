// Phase 6 fixture (early cutoff): `base`'s fn is rewritten (n*2 → n+n) so its
// VERSION changes, but its OUTPUT is byte-identical. On rerun: base re-executes
// (version changed), but `derived`'s inputHash is unchanged → derived REPLAYS.
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const num = passthrough<number>();

export default async function cascade(ctx: Ctx, input: { n: number }): Promise<number> {
  const indep = await ctx.step("indep", num, { n: input.n }, ({ n }) => n + 100);
  const base = await ctx.step("base", num, { n: input.n }, ({ n }) => n + n);
  const derived = await ctx.step("derived", num, { base }, ({ base }) => base + 1);
  return indep + derived;
}
