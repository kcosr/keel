// Phase 7 fixture: a small fan-out/aggregate using ctx.agent with structured
// output — the shape of the review workload in miniature.
import { type Ctx, jsonSchema, passthrough } from "@kcosr/keel";

const Findings = jsonSchema<{ findings: { title: string }[] }>({
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: { title: { type: "string" } },
      },
    },
  },
});

const num = passthrough<number>();

export default async function review(ctx: Ctx, input: { domains: string[] }): Promise<number> {
  ctx.phase("Review");
  const results = await Promise.all(
    input.domains.map((d) =>
      ctx.agent({
        key: ctx.stepKey("review", d),
        prompt: `review the ${d} subsystem`,
        provider: "mock",
        schema: Findings,
        toolPolicy: "read-only",
      }),
    ),
  );
  const all = results.flatMap((r) => r.findings);
  return ctx.step("count", num, { n: all.length }, ({ n }) => n);
}
