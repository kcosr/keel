// Review-fix fixture: identical step fn body, but the module helper `transform`
// changed (×2 → ×3). The step must re-execute on rerun (helper-closure version).
import { type Ctx, passthrough } from "@kcosr/keel";

const num = passthrough<number>();

function transform(n: number): number {
  return n * 3;
}

export default async function wf(ctx: Ctx, input: { n: number }): Promise<number> {
  return ctx.step("compute", num, { n: input.n }, ({ n }) => transform(n));
}
