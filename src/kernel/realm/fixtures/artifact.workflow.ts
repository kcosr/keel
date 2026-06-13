// Phase 8 fixture: `big` produces a >1KB output (content-addressed); `small`
// stays inline; `echo` re-derives the SAME big value (refcount dedup).
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const obj = passthrough<{ blob: string; len: number }>();

export default async function artifact(ctx: Ctx, input: { size: number }): Promise<number> {
  const big = await ctx.step("big", obj, { size: input.size }, ({ size }) => ({
    blob: "x".repeat(size),
    len: size,
  }));
  const echo = await ctx.step("echo", obj, { size: input.size }, ({ size }) => ({
    blob: "x".repeat(size),
    len: size,
  }));
  const small = await ctx.step("small", obj, { v: 1 }, () => ({ blob: "tiny", len: 4 }));
  return big.len + echo.len + small.len;
}
