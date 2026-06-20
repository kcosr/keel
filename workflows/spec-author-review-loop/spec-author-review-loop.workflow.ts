import { type Ctx, jsonSchema } from "@kcosr/keel";

type Finding = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  file: string;
  line: number;
  problem: string;
  recommendation: string;
};

type AuthorResult = {
  status: "updated" | "blocked";
  summary: string;
  correspondenceHeader: string;
  filesChanged: string[];
  notes: string;
};

type SpecReview = {
  status: "clean" | "changes-requested";
  summary: string;
  correspondenceHeader: string;
  findings: Finding[];
};

type SpecAuthorReviewInput = {
  specPath: string;
  request: string;
  creatorIdentity?: string;
  reviewerIdentity?: string;
  creatorProfile?: string;
  reviewerProfile?: string;
  creatorReasoning?: string;
  reviewerReasoning?: string;
  maxRounds?: number;
};

type SpecRound = {
  creatorTimestamp: string;
  reviewerTimestamp: string;
  author: AuthorResult;
  review: SpecReview;
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

const AuthorResultSchema = jsonSchema<AuthorResult>({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "correspondenceHeader", "filesChanged", "notes"],
  properties: {
    status: { type: "string", enum: ["updated", "blocked"] },
    summary: { type: "string" },
    correspondenceHeader: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
});

const SpecReviewSchema = jsonSchema<SpecReview>({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "correspondenceHeader", "findings"],
  properties: {
    status: { type: "string", enum: ["clean", "changes-requested"] },
    summary: { type: "string" },
    correspondenceHeader: { type: "string" },
    findings: { type: "array", items: FindingSchema },
  },
});

const DEFAULT_MAX_ROUNDS = 3;
const HARD_MAX_ROUNDS = 10;
const CREATOR_PROFILE = "codex-default";
const REVIEWER_PROFILE = "claude-default";

export default async function specAuthorReviewLoop(
  ctx: Ctx,
  input: SpecAuthorReviewInput,
): Promise<{
  status: "clean" | "blocked" | "max-rounds-reached";
  rounds: SpecRound[];
  remainingFindings: Finding[];
  blockedAuthor?: AuthorResult;
}> {
  const maxRounds = clampCount(input.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const creatorProfile = input.creatorProfile ?? CREATOR_PROFILE;
  const reviewerProfile = input.reviewerProfile ?? REVIEWER_PROFILE;
  const creatorIdentity = input.creatorIdentity ?? `Creator: ${creatorProfile}`;
  const reviewerIdentity = input.reviewerIdentity ?? `Reviewer: ${reviewerProfile}`;
  const creator = ctx.agentSession({
    key: "spec_creator",
    profile: creatorProfile,
    ...(input.creatorReasoning ? { reasoning: input.creatorReasoning } : {}),
  });
  const reviewer = ctx.agentSession({
    key: "spec_reviewer",
    profile: reviewerProfile,
    ...(input.reviewerReasoning ? { reasoning: input.reviewerReasoning } : {}),
    toolPolicy: "workspace-write",
  });

  const rounds: SpecRound[] = [];
  let findings: Finding[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const creatorTimestamp = timestampFrom(ctx.now());
    ctx.phase(`Spec author ${creatorTimestamp}`);
    const author = await creator.turn({
      key: round === 1 ? "draft" : `revise-${round}`,
      prompt:
        round === 1
          ? draftPrompt(input, creatorIdentity, creatorTimestamp)
          : revisePrompt(input, creatorIdentity, creatorTimestamp, findings),
      schema: AuthorResultSchema,
      lenient: true,
    });
    ctx.log(`spec.author.${creatorTimestamp}`, author);

    if (author.status === "blocked") {
      return { status: "blocked", rounds, remainingFindings: findings, blockedAuthor: author };
    }

    const reviewerTimestamp = timestampFrom(ctx.now());
    ctx.phase(`Spec review ${reviewerTimestamp}`);
    const review = await reviewer.turn({
      key: `review-${round}`,
      prompt: reviewPrompt(input, reviewerIdentity, reviewerTimestamp, author, findings),
      schema: SpecReviewSchema,
      lenient: true,
    });
    ctx.log(`spec.review.${reviewerTimestamp}`, review);

    rounds.push({ creatorTimestamp, reviewerTimestamp, author, review });
    findings = review.findings;
    if (review.status === "clean" && findings.length === 0) {
      return { status: "clean", rounds, remainingFindings: [] };
    }
  }

  return { status: "max-rounds-reached", rounds, remainingFindings: findings };
}

function draftPrompt(input: SpecAuthorReviewInput, identity: string, timestamp: string): string {
  const header = `### ${timestamp} - ${identity}`;
  return `Create or update the spec document for this request.

Spec path: ${input.specPath}
Request: ${input.request}
Correspondence header to add exactly: ${header}

Write the main spec content so it is implementation-ready. Include clear goals,
non-goals, API/behavior details, persistence or migration notes if relevant,
testing expectations, and open questions. Preserve existing correspondence
history if the file already exists.

Append a creator correspondence entry under "## Correspondence", creating that
section if needed. Use the exact header above.`;
}

function revisePrompt(
  input: SpecAuthorReviewInput,
  identity: string,
  timestamp: string,
  findings: Finding[],
): string {
  const header = `### ${timestamp} - ${identity}`;
  return `Revise the spec document to address reviewer findings.

Spec path: ${input.specPath}
Request: ${input.request}
Correspondence header to add exactly: ${header}
Reviewer findings:
${JSON.stringify(findings, null, 2)}

Update the main spec content so it matches the resolved design. Preserve
correspondence history. Append a creator response under "## Correspondence" using
the exact header above, explaining what changed and any finding not accepted.`;
}

function reviewPrompt(
  input: SpecAuthorReviewInput,
  identity: string,
  timestamp: string,
  author: AuthorResult,
  priorFindings: Finding[],
): string {
  const header = `### ${timestamp} - ${identity}`;
  return `Review the spec document and append your correspondence entry.

Spec path: ${input.specPath}
Request: ${input.request}
Correspondence header to add exactly: ${header}
Creator update:
${JSON.stringify(author, null, 2)}
${priorFindings.length > 0 ? `\nPrior findings expected to be addressed:\n${JSON.stringify(priorFindings, null, 2)}\n` : ""}
Read the full spec and correspondence history. Review for correctness,
completeness, unresolved disagreements, missing acceptance criteria, and
implementation risks.

Append your reviewer entry under "## Correspondence" using the exact header above.
Return actionable findings the creator should address. If the spec is ready,
return status "clean" and an empty findings array.`;
}

function timestampFrom(ms: number): string {
  return new Date(ms).toISOString();
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  if (whole > HARD_MAX_ROUNDS) return HARD_MAX_ROUNDS;
  return whole;
}
