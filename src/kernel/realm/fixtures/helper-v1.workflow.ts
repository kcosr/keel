// Review-fix fixture: a step whose fn calls a module helper. Editing the helper
// (helper-v2) must change the step's version even though the fn body is identical.
import type { Ctx } from "../../ctx.ts";
import { passthrough } from "../../schema.ts";

const num = passthrough<number>();

function transform(n: number): number {
  return n * 2;
}

export default async function wf(ctx: Ctx, input: { n: number }): Promise<number> {
  return ctx.step("compute", num, { n: input.n }, ({ n }) => transform(n));
}
