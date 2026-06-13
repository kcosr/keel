// Phase 5 fixture (v1): two steps. Sibling files differ from this only by a
// comment (same version) or by step b's logic (changed version).
import { type Ctx, passthrough } from "@kcosr/keel";

const num = passthrough<number>();

export default async function versioned(ctx: Ctx, input: { n: number }): Promise<number> {
  const a = await ctx.step("a", num, { n: input.n }, ({ n }) => {
    return n + 1;
  });
  const b = await ctx.step("b", num, { a }, ({ a }) => a * 10);
  return b;
}
