import { type Ctx, jsonSchema } from "@kcosr/keel";

const Out = jsonSchema<{ value: number }>({
  type: "object",
  additionalProperties: false,
  required: ["value"],
  properties: { value: { type: "number" } },
});

type Variant =
  | "default"
  | "explicit-defaults"
  | "timeout-default"
  | "stall-retries-default"
  | "max-retries"
  | "lenient"
  | "on-failure"
  | "timeout"
  | "stall-retries";

export default async function controlIdentity(
  ctx: Ctx,
  input: { variant: Variant },
): Promise<number> {
  const base = {
    key: "ask",
    prompt: "produce a number",
    provider: "mock",
    schema: Out,
  };
  const variant = input.variant;
  const result = await ctx.agent(
    variant === "explicit-defaults"
      ? { ...base, maxRetries: 2, lenient: false, onFailure: "throw" as const }
      : variant === "timeout-default"
        ? { ...base, timeoutMs: 60 * 60_000 }
        : variant === "stall-retries-default"
          ? { ...base, stallRetries: 1 }
          : variant === "max-retries"
            ? { ...base, maxRetries: 0 }
            : variant === "lenient"
              ? { ...base, lenient: true }
              : variant === "on-failure"
                ? { ...base, onFailure: "null" as const }
                : variant === "timeout"
                  ? { ...base, timeoutMs: 1234 }
                  : variant === "stall-retries"
                    ? { ...base, stallRetries: 3 }
                    : base,
  );
  return result.value;
}
