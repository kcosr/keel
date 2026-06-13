// Phase 6 fixture: `base` logic changed (×2 → ×3). On rerun: base re-executes
// (version changed), derived re-executes (base's output changed → its inputHash
// changed), indep replays (untouched).
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const num = passthrough<number>();

export default async function cascade(ctx: Ctx, input: { n: number }): Promise<number> {
  const indep = await ctx.step("indep", num, { n: input.n }, ({ n }) => n + 100);
  const base = await ctx.step("base", num, { n: input.n }, ({ n }) => n * 3);
  const derived = await ctx.step("derived", num, { base }, ({ base }) => base + 1);
  return indep + derived;
}
