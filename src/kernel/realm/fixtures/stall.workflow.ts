// Phase 13 fixture: one agent with a tight stall timeout. The mock is scripted
// to stall on the first attempt and respond fast on the retry.
import { type Ctx, jsonSchema } from "@kcosr/keel";

const Out = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});

export default async function stall(
  ctx: Ctx,
  input: { onFailure?: "throw" | "null" },
): Promise<{ value: number } | null> {
  return ctx.agent({
    key: "slow",
    prompt: "p",
    provider: "mock",
    schema: Out,
    timeoutMs: 150,
    stallRetries: 2,
    ...(input.onFailure ? { onFailure: input.onFailure } : {}),
  });
}
