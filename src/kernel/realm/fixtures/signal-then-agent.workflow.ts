import { type Ctx, jsonSchema } from "@kcosr/keel";

const Out = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});

export default async function signalThenAgent(ctx: Ctx, _input: null): Promise<number> {
  await ctx.signal("proceed");
  const out = await ctx.agent({
    key: "after-signal",
    prompt: "continue after signal",
    provider: "mock",
    schema: Out,
  });
  return out.value;
}
