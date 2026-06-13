// Phase 6 fixture: `gen` adds an item ("ccc"), drifting the fan-out key set.
// On rerun: gen re-executes; verify:a and verify:bb replay; verify:ccc executes;
// total re-executes (its input array changed). No mis-alignment.
import { type Ctx, passthrough } from "@kcosr/keel";

const num = passthrough<number>();
const arr = passthrough<string[]>();

export default async function drift(ctx: Ctx, _input: null): Promise<number> {
  const ids = await ctx.step("gen", arr, { v: 1 }, () => ["a", "bb", "ccc"]);
  const verds = await Promise.all(
    ids.map((id) => ctx.step(ctx.stepKey("verify", id), num, { id }, ({ id }) => id.length)),
  );
  const total = await ctx.step("total", num, { verds }, ({ verds }) =>
    verds.reduce((a, b) => a + b, 0),
  );
  return total;
}
