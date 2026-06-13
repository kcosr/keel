// Phase 10 live fixture: two real pi agents + a pure reducer, through the realm.
import { type Ctx, jsonSchema, passthrough } from "@kcosr/keel";

const Num = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});
const num = passthrough<number>();

export default async function live(ctx: Ctx, _input: null): Promise<number> {
  ctx.phase("ask");
  const [a, b] = await Promise.all([
    ctx.agent({
      key: "a",
      prompt: 'Return ONLY this JSON, nothing else: {"value": 7}',
      provider: "pi",
      schema: Num,
      toolPolicy: "read-only",
    }),
    ctx.agent({
      key: "b",
      prompt: 'Return ONLY this JSON, nothing else: {"value": 5}',
      provider: "pi",
      schema: Num,
      toolPolicy: "read-only",
    }),
  ]);
  return ctx.step("sum", num, { a: a.value, b: b.value }, ({ a, b }) => a + b);
}
