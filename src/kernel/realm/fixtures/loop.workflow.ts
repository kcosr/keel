// Phase 19 fixture: continueAsNew chains a fresh run until count reaches 2.
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const num = passthrough<number>();

export default async function loop(ctx: Ctx, input: { count: number }): Promise<number> {
  await ctx.step("work", num, { c: input.count }, ({ c }) => c);
  if (input.count < 2) {
    await ctx.continueAsNew({ count: input.count + 1 });
  }
  return input.count;
}
