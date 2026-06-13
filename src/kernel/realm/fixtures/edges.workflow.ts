// Realm test fixture: step b consumes step a's object result, so the dependency
// edge must be detected across the JSON boundary (§5.4 tagged envelopes).
import { type Ctx, passthrough } from "@kcosr/keel";

const obj = passthrough<{ items: number[] }>();
const num = passthrough<number>();

export default async function edges(ctx: Ctx): Promise<number> {
  const a = await ctx.step("a", obj, { seed: 1 }, () => ({ items: [1, 2, 3] }));
  const b = await ctx.step("b", num, { a }, ({ a }) => a.items.length);
  return b;
}
