// Phase 6 fixture (fan-out key-set drift): `gen` produces a list; the workflow
// fans out content-keyed verify steps and aggregates. drift-v2 changes `gen` to
// add an item, so a rerun drifts the fan-out key set.
import { type Ctx, passthrough } from "@kcosr/keel";

const num = passthrough<number>();
const arr = passthrough<string[]>();

export default async function drift(ctx: Ctx, _input: null): Promise<number> {
  const ids = await ctx.step("gen", arr, { v: 1 }, () => ["a", "bb"]);
  const verds = await Promise.all(
    ids.map((id) => ctx.step(ctx.stepKey("verify", id), num, { id }, ({ id }) => id.length)),
  );
  const total = await ctx.step("total", num, { verds }, ({ verds }) =>
    verds.reduce((a, b) => a + b, 0),
  );
  return total;
}
