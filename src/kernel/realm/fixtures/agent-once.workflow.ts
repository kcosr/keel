// Phase 10 fixture: a single pi-provider agent step. Used to exercise the
// session-resume four-branch table through the realm.
import type { Ctx } from "../../ctx.ts";
import { jsonSchema } from "../../schema.ts";

const Out = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});

export default async function once(ctx: Ctx, _input: null): Promise<{ value: number }> {
  return ctx.agent({ key: "ask", prompt: "produce a number", provider: "pi", schema: Out });
}
