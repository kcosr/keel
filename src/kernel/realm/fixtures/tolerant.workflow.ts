// Review-fix fixture: an onFailure:'null' agent followed by a step. A crash
// after the agent is accepted-as-null but before the run finishes must NOT
// re-call the agent on resume — it replays the journaled null.
import { type Ctx, jsonSchema, passthrough } from "@kcosr/keel";

const Out = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});
const num = passthrough<number>();

export default async function tolerant(ctx: Ctx, _input: null): Promise<number> {
  const a = await ctx.agent({
    key: "maybe",
    prompt: "p",
    provider: "mock",
    schema: Out,
    onFailure: "null",
  });
  // `a` is null when the agent failed (tolerated); count it as 0.
  return ctx.step("use", num, { v: a ? a.value : 0 }, ({ v }) => v + 1);
}
