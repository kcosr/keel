// Realm test fixture: the ONLY allowed time/entropy — ctx.now()/ctx.random().
import type { Ctx } from "@kcosr/keel";

export default async function ambient(ctx: Ctx): Promise<{ t: number; r: number }> {
  const t = ctx.now();
  const r = ctx.random();
  return { t, r };
}
