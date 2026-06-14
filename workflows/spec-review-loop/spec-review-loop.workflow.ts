import { type Ctx, type ToolPolicy, jsonSchema } from "@kcosr/keel";

type Finding = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  file: string;
  line: number;
  problem: string;
  recommendation: string;
};

type SpecReview = {
  status: "clean" | "changes-requested";
  summary: string;
  correspondenceHeader: string;
  findings: Finding[];
};

type SpecReviewInput = {
  specPath: string;
  task: string;
  reviewerIdentity?: string;
  reviewerProvider?: string;
  reviewerModel?: string;
  reviewerReasoning?: string;
  reviewerToolPolicy?: ToolPolicy;
  maxReviews?: number;
  signalName?: string;
  stopWhenClean?: boolean;
};

type CreatorSignal = {
  summary: string;
  done?: boolean;
};

type ReviewEntry = {
  timestamp: string;
  creatorSignal?: CreatorSignal;
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

const DEFAULT_MAX_REVIEWS = 3;
const HARD_MAX_REVIEWS = 20;

export default async function specReviewLoop(
  ctx: Ctx,
  input: SpecReviewInput,
): Promise<{
  status: "clean" | "stopped" | "max-reviews-reached";
  reviews: ReviewEntry[];
  remainingFindings: Finding[];
}> {
  const maxReviews = clampCount(input.maxReviews ?? DEFAULT_MAX_REVIEWS);
  const signalName = input.signalName ?? "spec-review-cycle";
  const stopWhenClean = input.stopWhenClean ?? true;
  const identity = input.reviewerIdentity ?? reviewerIdentity(input);
  const reviewer = ctx.agentSession({
    key: "spec_reviewer",
    provider: input.reviewerProvider ?? "pi",
    ...(input.reviewerModel ? { model: input.reviewerModel } : {}),
    reasoning: input.reviewerReasoning ?? "xhigh",
    toolPolicy: input.reviewerToolPolicy ?? "workspace-write",
  });

  const reviews: ReviewEntry[] = [];
  let findings: Finding[] = [];

  for (let reviewNumber = 1; reviewNumber <= maxReviews; reviewNumber++) {
    let creatorSignal: CreatorSignal | undefined;
    if (reviewNumber > 1) {
      ctx.phase(`Awaiting spec update ${reviewNumber}`);
      creatorSignal = await ctx.signal<CreatorSignal>(signalName);
      if (creatorSignal.done === true) {
        return { status: "stopped", reviews, remainingFindings: findings };
      }
    }

    const timestamp = timestampFrom(ctx.now());
    ctx.phase(`Spec review ${timestamp}`);
    const review = await reviewer.turn({
      key: `review-${reviewNumber}`,
      prompt: reviewPrompt(input, identity, timestamp, creatorSignal),
      schema: SpecReviewSchema,
      lenient: true,
    });
    ctx.log(`spec.review.${timestamp}`, review);

    reviews.push({
      timestamp,
      ...(creatorSignal ? { creatorSignal } : {}),
      review,
    });
    findings = review.findings;
    if (stopWhenClean && review.status === "clean" && findings.length === 0) {
      return { status: "clean", reviews, remainingFindings: [] };
    }
  }

  return { status: "max-reviews-reached", reviews, remainingFindings: findings };
}

function reviewPrompt(
  input: SpecReviewInput,
  identity: string,
  timestamp: string,
  creatorSignal: CreatorSignal | undefined,
): string {
  const header = `### ${timestamp} - ${identity}`;
  return `Review this spec document and append your correspondence entry.

Spec path: ${input.specPath}
Task: ${input.task}
Correspondence header to add exactly: ${header}
${creatorSignal ? `Creator update since your prior review:\n${creatorSignal.summary}\n` : ""}
Read the full spec and current correspondence history. Review the main design
content for correctness, completeness, unresolved disagreements, missing
acceptance criteria, and implementation risks.

Modify the spec file only to append your new entry under a "## Correspondence"
section, creating that section if needed. Do not rewrite the main design content.
Your entry must use the exact correspondence header above and preserve previous
history. Return structured findings that the creator should address. If the spec
is ready, return status "clean" and an empty findings array.`;
}

function reviewerIdentity(input: SpecReviewInput): string {
  const provider = input.reviewerProvider ?? "pi";
  const model = input.reviewerModel ?? "default";
  return `Reviewer: ${provider}/${model}`;
}

function timestampFrom(ms: number): string {
  return new Date(ms).toISOString();
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_REVIEWS;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  if (whole > HARD_MAX_REVIEWS) return HARD_MAX_REVIEWS;
  return whole;
}
