import type { Ctx } from "@kcosr/keel";
import { jsonSchema } from "@kcosr/keel";

type Finding = {
  title: string;
  file: string;
  line: string;
  severity: "high" | "medium" | "low";
  detail: string;
  evidence: string;
};

const FindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "file", "line", "severity", "detail", "evidence"],
  properties: {
    title: { type: "string" },
    file: { type: "string" },
    line: { type: "string" },
    severity: { type: "string", enum: ["high", "medium", "low"] },
    detail: { type: "string" },
    evidence: { type: "string" },
  },
};

const Review = jsonSchema<{ summary: string; findings: Finding[] }>({
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: FindingSchema,
    },
  },
});

const Verification = jsonSchema<{
  verdict: "accepted" | "rejected" | "mixed";
  reason: string;
  confirmedFindings: Finding[];
  rejectedFindings: { title: string; reason: string }[];
}>({
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason", "confirmedFindings", "rejectedFindings"],
  properties: {
    verdict: { type: "string", enum: ["accepted", "rejected", "mixed"] },
    reason: { type: "string" },
    confirmedFindings: {
      type: "array",
      items: FindingSchema,
    },
    rejectedFindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "reason"],
        properties: {
          title: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
});

export default async function reviewCommitThenVerify(
  ctx: Ctx,
  input: { root: string; commit: string },
) {
  ctx.phase("Review");
  const review = await ctx.agent({
    key: "review-commit",
    capabilities: { fs: "read", shell: true },
    reasoning: "high",
    schema: Review,
    lenient: true,
    prompt: `Review commit ${input.commit} in the git repository at ${input.root}.

Use inspection commands only, such as git -C "${input.root}" show --stat --patch ${input.commit}
and file reads. Do not modify files. Look for bugs, regressions, security issues, and
missing tests. Report only concrete findings with file and line evidence.
If there are no issues, return an empty findings array and explain that in summary.`,
  });

  ctx.phase("Verify");
  const verification = await ctx.agent({
    key: "verify-review",
    capabilities: { fs: "read", shell: true },
    reasoning: "high",
    schema: Verification,
    lenient: true,
    prompt: `Adversarially verify this review of commit ${input.commit} in ${input.root}.

Use inspection commands only, such as git -C "${input.root}" show --stat --patch ${input.commit}
and file reads. Do not modify files. Try to refute each finding by reading the actual diff
and current code. Keep only findings that are supported by the code. If the original review
has no findings, confirm whether that looks reasonable from the commit.

Original review:
${JSON.stringify(review, null, 2)}`,
  });

  return { review, verification };
}
