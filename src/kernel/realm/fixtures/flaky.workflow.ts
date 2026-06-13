// Phase 18 fixture: a pre step, a flaky agent (fails the first run, succeeds on
// retry), and a post step — to show retry re-runs only from the failure.
import { type Ctx, jsonSchema, passthrough } from "@kcosr/keel";

const num = passthrough<number>();
const Out = jsonSchema<{ ok: boolean }>({
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
});

export default async function flaky(ctx: Ctx, _input: null): Promise<string> {
  await ctx.step("pre", num, { v: 1 }, ({ v }) => v);
  const r = await ctx.agent({ key: "flaky", prompt: "p", provider: "mock", schema: Out });
  return ctx.step("post", passthrough<string>(), { ok: r.ok }, ({ ok }) => `done:${ok}`);
}
