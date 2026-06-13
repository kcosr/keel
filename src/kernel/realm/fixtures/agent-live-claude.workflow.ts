// Live fixture: two real Claude agents + a pure reducer, through the daemon/realm.
import type { Ctx } from "../../ctx.ts";
import { jsonSchema, passthrough } from "../../schema.ts";

const Num = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});
const num = passthrough<number>();

export default async function liveClaude(ctx: Ctx, _input: null): Promise<number> {
  ctx.phase("ask");
  const [a, b] = await Promise.all([
    ctx.agent({
      key: "a",
      prompt: 'Return ONLY this JSON, nothing else: {"value": 7}',
      provider: "claude",
      schema: Num,
      toolPolicy: "none",
    }),
    ctx.agent({
      key: "b",
      prompt: 'Return ONLY this JSON, nothing else: {"value": 5}',
      provider: "claude",
      schema: Num,
      toolPolicy: "none",
    }),
  ]);
  return ctx.step("sum", num, { a: a.value, b: b.value }, ({ a, b }) => a + b);
}
