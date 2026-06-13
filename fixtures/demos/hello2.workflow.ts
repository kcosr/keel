import type { Ctx } from "@kcosr/keel";
import { jsonSchema } from "@kcosr/keel";

const HelloSchema = jsonSchema<{ msg: string }>({
  type: "object",
  additionalProperties: false,
  required: ["msg"],
  properties: { msg: { type: "string" } },
});

export default async function helloJson(ctx: Ctx, _input: Record<string, never>) {
  const result = await ctx.agent({
    key: "say-hello-json",
    prompt:
      'Respond with a JSON object containing a single field "msg" whose value is the string "Hello world". No extra text.',
    schema: HelloSchema,
    reasoning: "low",
    lenient: true,
  });
  return result?.msg ?? "";
}
