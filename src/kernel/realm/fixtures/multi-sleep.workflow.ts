// Commit 5 fixture: two durable sleeps with distinct author keys, around a step.
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const num = passthrough<number>();

export default async function multiSleep(ctx: Ctx, _input: null): Promise<number> {
  await ctx.sleep("first-nap", 100);
  const a = await ctx.step("mid", num, { v: 1 }, ({ v }) => v);
  await ctx.sleep("second-nap", 200);
  return ctx.step("done", num, { v: a + 1 }, ({ v }) => v);
}
