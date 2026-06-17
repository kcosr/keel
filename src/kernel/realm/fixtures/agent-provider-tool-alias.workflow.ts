import { type Ctx, jsonSchema } from "@kcosr/keel";

const Out = jsonSchema<{ value: string }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "string" } },
});

export default async function providerToolAlias(ctx: Ctx): Promise<{ value: string }> {
  return await ctx.agent({
    key: "bad-tools",
    provider: "pi",
    prompt: "return ok",
    allowTools: ["run"],
    schema: Out,
  });
}
