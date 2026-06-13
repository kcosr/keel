// Daemon test fixture: one pi-provider agent (driven by the daemon's mock).
import type { Ctx } from "../../kernel/ctx.ts";
import { jsonSchema } from "../../kernel/schema.ts";

const Out = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});

export default async function once(ctx: Ctx, _input: null): Promise<{ value: number }> {
  return ctx.agent({ key: "ask", prompt: "p", provider: "mock", schema: Out });
}
