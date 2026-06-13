// Phase 17 fixture: block on an external signal and return its payload.
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const obj = passthrough<{ go: boolean; by: string }>();

export default async function awaitSignal(
  ctx: Ctx,
  _input: null,
): Promise<{ go: boolean; by: string }> {
  const payload = await ctx.signal<{ go: boolean; by: string }>("proceed");
  return ctx.step("use", obj, payload, (p) => p);
}
