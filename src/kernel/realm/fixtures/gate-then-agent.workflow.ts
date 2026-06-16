import { type Ctx, jsonSchema } from "@kcosr/keel";

const Out = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});

export default async function gateThenAgent(ctx: Ctx, _input: null): Promise<number> {
  await ctx.human({ key: "approve-deploy", prompt: "Deploy to prod?" });
  const out = await ctx.agent({
    key: "after-approval",
    prompt: "continue after approval",
    provider: "mock",
    schema: Out,
  });
  return out.value;
}
