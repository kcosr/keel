// Realm test fixture: an N-step accumulator chain. Runs inside the worker realm.
import { type Ctx, passthrough } from "@kcosr/keel";

const num = passthrough<number>();

export default async function chain(ctx: Ctx, input: { n: number }): Promise<number> {
  let acc = 0;
  for (let i = 0; i < input.n; i++) {
    acc = await ctx.step(`s${i}`, num, { acc, i }, ({ acc }) => acc + 1);
  }
  return acc;
}
