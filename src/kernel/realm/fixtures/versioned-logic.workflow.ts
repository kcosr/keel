// Phase 5 fixture: step a is byte-identical to versioned-v1; step b's logic
// changed (×10 → ×100), so only b's version changes.
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const num = passthrough<number>();

export default async function versioned(ctx: Ctx, input: { n: number }): Promise<number> {
  const a = await ctx.step("a", num, { n: input.n }, ({ n }) => {
    return n + 1;
  });
  const b = await ctx.step("b", num, { a }, ({ a }) => a * 100);
  return b;
}
