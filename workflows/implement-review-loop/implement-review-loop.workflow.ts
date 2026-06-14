import { type Ctx, type ToolPolicy, jsonSchema } from "@kcosr/keel";

type Finding = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  file: string;
  line: number;
  problem: string;
  recommendation: string;
};

type ImplementationResult = {
  summary: string;
  status: "implemented" | "partial" | "blocked";
  filesChanged: string[];
  verification: string[];
  notes: string;
};

type Review = {
  summary: string;
  findings: Finding[];
};

type ImplementReviewInput = {
  repository: string;
  spec: string;
  task?: string;
  maxRounds?: number;
  implementerProvider?: string;
  implementerModel?: string;
  implementerReasoning?: string;
  implementerToolPolicy?: ToolPolicy;
  reviewerProvider?: string;
  reviewerModel?: string;
  reviewerReasoning?: string;
  reviewerToolPolicy?: ToolPolicy;
  reviewFocus?: string;
  verificationCommand?: string;
};

type Round = {
  round: number;
  implementation: ImplementationResult;
  review: Review;
};

const FindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "title", "file", "line", "problem", "recommendation"],
  properties: {
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    title: { type: "string" },
    file: { type: "string" },
    line: { type: "number" },
    problem: { type: "string" },
    recommendation: { type: "string" },
  },
};

const ImplementationSchema = jsonSchema<ImplementationResult>({
  type: "object",
  additionalProperties: false,
  required: ["summary", "status", "filesChanged", "verification", "notes"],
  properties: {
    summary: { type: "string" },
    status: { type: "string", enum: ["implemented", "partial", "blocked"] },
    filesChanged: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
});

const ReviewSchema = jsonSchema<Review>({
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

const DEFAULT_MAX_ROUNDS = 3;
const HARD_MAX_ROUNDS = 10;

export default async function implementReviewLoop(
  ctx: Ctx,
  input: ImplementReviewInput,
): Promise<{
  status: "clean" | "blocked" | "max-rounds-reached";
  rounds: Round[];
  remainingFindings: Finding[];
  blockedImplementation?: ImplementationResult;
}> {
  const maxRounds = clampRounds(input.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const implementer = ctx.agentSession({
    key: "implementer",
    provider: input.implementerProvider ?? "pi",
    ...(input.implementerModel ? { model: input.implementerModel } : {}),
    reasoning: input.implementerReasoning ?? "xhigh",
    ...(input.verificationCommand
      ? { capabilities: { fs: "workspace-write", network: "none", shell: true, secrets: [] } }
      : { toolPolicy: input.implementerToolPolicy ?? "workspace-write" }),
  });
  const reviewer = ctx.agentSession({
    key: "reviewer",
    provider: input.reviewerProvider ?? "claude",
    ...(input.reviewerModel ? { model: input.reviewerModel } : {}),
    reasoning: input.reviewerReasoning ?? "xhigh",
    toolPolicy: input.reviewerToolPolicy ?? "read-only",
  });

  const rounds: Round[] = [];
  let findings: Finding[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    ctx.phase(`Implement ${round}`);
    const implementation = await implementer.turn({
      key: round === 1 ? "implement-1" : `fix-${round}`,
      prompt:
        round === 1
          ? initialImplementationPrompt(input)
          : fixImplementationPrompt(input, round, findings),
      schema: ImplementationSchema,
      lenient: true,
    });

    ctx.log(`implementation.${round}`, implementation);
    if (implementation.status === "blocked") {
      return {
        status: "blocked",
        rounds,
        remainingFindings: findings,
        blockedImplementation: implementation,
      };
    }

    ctx.phase(`Review ${round}`);
    const review = await reviewer.turn({
      key: `review-${round}`,
      prompt: reviewPrompt(input, round, implementation, findings),
      schema: ReviewSchema,
      lenient: true,
    });

    ctx.log(`review.${round}`, review);
    rounds.push({ round, implementation, review });
    findings = review.findings;
    if (findings.length === 0) {
      return { status: "clean", rounds, remainingFindings: [] };
    }
  }

  return { status: "max-rounds-reached", rounds, remainingFindings: findings };
}

function initialImplementationPrompt(input: ImplementReviewInput): string {
  return `Implement the requested change.

Repository: ${input.repository}
Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${input.verificationCommand ? `Verification command: ${input.verificationCommand}\n` : ""}
Modify files only inside the repository. Keep the change scoped to the spec.
Run focused verification when practical. Return a concise implementation summary,
changed files, verification performed, and any notes.`;
}

function fixImplementationPrompt(
  input: ImplementReviewInput,
  round: number,
  findings: Finding[],
): string {
  return `Fix reviewer findings for implementation round ${round}.

Repository: ${input.repository}
Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${input.verificationCommand ? `Verification command: ${input.verificationCommand}\n` : ""}
Reviewer findings to address:
${JSON.stringify(findings, null, 2)}

Modify files only inside the repository. Address findings you agree with, and
explain any finding you do not address in notes. Run focused verification when
practical. Return a concise implementation summary, changed files, verification
performed, and any notes.`;
}

function reviewPrompt(
  input: ImplementReviewInput,
  round: number,
  implementation: ImplementationResult,
  priorFindings: Finding[],
): string {
  return `Review implementation round ${round}.

Repository: ${input.repository}
Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${input.reviewFocus ? `Focus: ${input.reviewFocus}\n` : ""}
Implementation summary:
${JSON.stringify(implementation, null, 2)}
${priorFindings.length > 0 ? `\nPrior findings that should have been fixed:\n${JSON.stringify(priorFindings, null, 2)}\n` : ""}
Read the relevant files and current diff yourself. The reviewer is read-only and
must not edit files. Report only concrete, actionable remaining or new findings
with file and line numbers. If there are no findings, return an empty findings
array.`;
}

function clampRounds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  if (whole > HARD_MAX_ROUNDS) return HARD_MAX_ROUNDS;
  return whole;
}
