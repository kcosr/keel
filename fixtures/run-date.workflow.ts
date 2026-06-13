import type { Ctx } from "@kcosr/keel";
import { jsonSchema } from "@kcosr/keel";

type DateResult = {
  command: string;
  stdout: string;
  exitCode: number;
  note: string;
};

const DateResult = jsonSchema<DateResult>({
  type: "object",
  additionalProperties: false,
  required: ["command", "stdout", "exitCode", "note"],
  properties: {
    command: { type: "string" },
    stdout: { type: "string" },
    exitCode: { type: "number" },
    note: { type: "string" },
  },
});

export default async function runDate(ctx: Ctx, input: { provider?: string } = {}) {
  ctx.phase("Run date");

  return ctx.agent({
    key: "run-date",
    provider: input.provider ?? "pi",
    prompt:
      "Use the bash tool to run exactly this command: date. Return the command, stdout, numeric exit code, and a short note.",
    schema: DateResult,
    capabilities: { shell: true },
    reasoning: "low",
    lenient: true,
  });
}
