// Phase 16 fixture: a step, a durable sleep, then a step. The run parks at the
// sleep and a supervisor wakes it to finish.
import { type Ctx, passthrough } from "@kcosr/keel";

const num = passthrough<number>();

export default async function nap(ctx: Ctx, _input: null): Promise<number> {
  const a = await ctx.step("before", num, { v: 1 }, ({ v }) => v);
  await ctx.sleep("nap", 1000);
  return ctx.step("after", num, { v: a + 1 }, ({ v }) => v);
}
