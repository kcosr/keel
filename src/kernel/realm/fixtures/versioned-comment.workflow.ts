// Phase 5 fixture: identical to versioned-v1 except a comment inside step a's
// body. The normalized fn source — and thus the version — must be unchanged.
import { type Ctx, passthrough } from "@kcosr/keel";

const num = passthrough<number>();

export default async function versioned(ctx: Ctx, input: { n: number }): Promise<number> {
  const a = await ctx.step("a", num, { n: input.n }, ({ n }) => {
    // incidental comment — must not invalidate
    return n + 1;
  });
  const b = await ctx.step("b", num, { a }, ({ a }) => a * 10);
  return b;
}
