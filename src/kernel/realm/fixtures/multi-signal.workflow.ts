// Commit 5 fixture: multiple signals — two of the same name + one other — to
// exercise per-name occurrence keying (event:0, event:1, other:0).
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const arr = passthrough<number[]>();

export default async function multiSignal(ctx: Ctx, _input: null): Promise<number[]> {
  const a = await ctx.signal<number>("event");
  const b = await ctx.signal<number>("event");
  const c = await ctx.signal<number>("other");
  return ctx.step("collect", arr, { v: [a, b, c] }, ({ v }) => v);
}
