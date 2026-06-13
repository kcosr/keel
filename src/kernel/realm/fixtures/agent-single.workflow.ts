// Phase 7 fixture: a single agent step then a pure step, for replay/retry/crash
// tests where the agent execution count matters.
import type { Ctx } from "../../ctx.ts";
import { jsonSchema, passthrough } from "../../schema.ts";

const Out = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});
const num = passthrough<number>();

export default async function single(ctx: Ctx, _input: null): Promise<number> {
  const a = await ctx.agent({
    key: "ask",
    prompt: "produce a number",
    provider: "mock",
    schema: Out,
  });
  return ctx.step("double", num, { v: a.value }, ({ v }) => v * 2);
}
