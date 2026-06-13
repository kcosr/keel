import type { Ctx } from "@kcosr/keel";
import { passthrough } from "@kcosr/keel";

export default async function hello(ctx: Ctx, _input: Record<string, never>) {
  const result = await ctx.agent({
    key: "say-hello",
    prompt: "Print the string Hello world.",
    schema: passthrough<string>(),
    reasoning: "low",
  });
  return result;
}
