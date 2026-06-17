import type { Ctx } from "@kcosr/keel";
import { jsonSchema } from "@kcosr/keel";

type Finding = {
  title: string;
  file: string;
  severity: "high" | "medium" | "low";
  detail: string;
};

// Schema for the agent output: a list of findings.
const FindingsSchema = jsonSchema<{ findings: Finding[] }>({
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "file", "severity", "detail"],
        properties: {
          title: { type: "string" },
          file: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          detail: { type: "string" },
        },
      },
    },
  },
});

export default async function (ctx: Ctx, _input: Record<string, never>) {
  // Files we want reviewed
  const files = ["src/kernel/realm/realm-host.ts", "src/agents/pi.ts", "src/daemon/server.ts"];

  // Fan out: run an agent for each file in parallel.
  const reviews = await Promise.all(
    files.map((file) =>
      ctx.agent({
        key: ctx.stepKey("review", file),
        prompt: `Review the source code in ${file} and report any issues (bugs, security concerns, performance problems, or style violations). Return a JSON object matching the schema below.`,
        schema: FindingsSchema,
        toolPolicy: "read-only",
        reasoning: "high",
        onFailure: "null",
        lenient: true,
      }),
    ),
  );

  // Combine all findings into one array. `onFailure:null` makes individual review
  // agents optional for this demo.
  const allFindings = reviews.flatMap((r) => r?.findings ?? []);

  // Return the consolidated report
  return { findings: allFindings };
}
