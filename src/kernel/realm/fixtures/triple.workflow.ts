// Phase 18 fixture: a three-step chain for rewind/fork.
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const num = passthrough<number>();

export default async function triple(ctx: Ctx, _input: null): Promise<number> {
  const a = await ctx.step("a", num, { v: 1 }, ({ v }) => v);
  const b = await ctx.step("b", num, { v: a + 1 }, ({ v }) => v);
  return ctx.step("c", num, { v: b + 1 }, ({ v }) => v);
}
