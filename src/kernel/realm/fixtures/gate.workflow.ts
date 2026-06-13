// Phase 17 fixture: a human-in-the-loop gate. The run parks at ctx.human until a
// decision is delivered, then continues with it.
import { type Ctx, passthrough } from "@kcosr/keel";

const str = passthrough<string>();

export default async function gate(ctx: Ctx, _input: null): Promise<string> {
  await ctx.step("prepare", str, { v: "ready" }, ({ v }) => v);
  const decision = await ctx.human({ key: "approve-deploy", prompt: "Deploy to prod?" });
  return ctx.step("act", str, { d: decision.status }, ({ d }) => `deploy:${d}`);
}
