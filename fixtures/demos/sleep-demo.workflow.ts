import type { Ctx } from "@kcosr/keel";
import { jsonSchema } from "@kcosr/keel";

// Simple schema for returning the elapsed milliseconds
const ResultSchema = jsonSchema<{ elapsedMs: number }>({
  type: "object",
  additionalProperties: false,
  required: ["elapsedMs"],
  properties: { elapsedMs: { type: "number" } },
});

export default async function (ctx: Ctx, _input: Record<string, never>) {
  // Record start time (allowed via ctx.now())
  const start = ctx.now();

  // Fan out 5 sleeps of 10 seconds each (10,000 ms).
  await Promise.all(
    Array.from({ length: 5 }, (_, i) => ctx.sleep(ctx.stepKey("sleep", String(i)), 10_000)),
  );

  // Record end time and compute elapsed
  const end = ctx.now();
  const elapsed = end - start;

  // Return the measured elapsed time (should be just a little over 10s).
  return ResultSchema.parse({ elapsedMs: elapsed });
}
