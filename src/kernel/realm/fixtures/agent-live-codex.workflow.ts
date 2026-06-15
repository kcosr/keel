// Live fixture: two real Codex agents + a pure reducer, through the daemon/realm.
import { type Ctx, jsonSchema, passthrough } from "@kcosr/keel";

const Num = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});
const num = passthrough<number>();

export default async function liveCodex(ctx: Ctx, _input: null): Promise<number> {
  ctx.phase("ask");
  const [a, b] = await Promise.all([
    ctx.agent({
      key: "a",
      prompt: 'Return ONLY this JSON, nothing else: {"value": 7}',
      provider: "codex",
      schema: Num,
      toolPolicy: "unrestricted",
      maxRetries: 0,
    }),
    ctx.agent({
      key: "b",
      prompt: 'Return ONLY this JSON, nothing else: {"value": 5}',
      provider: "codex",
      schema: Num,
      toolPolicy: "unrestricted",
      maxRetries: 0,
    }),
  ]);
  return ctx.step("sum", num, { a: a.value, b: b.value }, ({ a, b }) => a + b);
}
