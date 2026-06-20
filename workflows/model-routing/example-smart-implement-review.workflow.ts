import { type Ctx, jsonSchema } from "@kcosr/keel";
import {
  type RoutingRisk,
  type RoutingSurface,
  routeWithAgent,
  selectModelRoute,
} from "./model-routing";

type Finding = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  evidence: string;
  recommendation: string;
};

type ImplementationResult = {
  status: "implemented" | "partial" | "blocked";
  summary: string;
  filesChanged: string[];
  verification: string[];
};

type ReviewResult = {
  status: "clean" | "changes-requested";
  findings: Finding[];
  summary: string;
};

export interface SmartImplementReviewInput {
  task: string;
  specPath?: string;
  candidateSurfaces: RoutingSurface[];
  candidateRisks: RoutingRisk[];
  maxReasoning?: string;
  allowedReasoning?: string[];
}

type Round = {
  round: number;
  implementation: ImplementationResult;
  review: ReviewResult;
};

const ImplementationSchema = jsonSchema<ImplementationResult>({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "filesChanged", "verification"],
  properties: {
    status: { type: "string", enum: ["implemented", "partial", "blocked"] },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
  },
});

const FindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "title", "evidence", "recommendation"],
  properties: {
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    title: { type: "string" },
    evidence: { type: "string" },
    recommendation: { type: "string" },
  },
};

const ReviewSchema = jsonSchema<ReviewResult>({
  type: "object",
  additionalProperties: false,
  required: ["status", "findings", "summary"],
  properties: {
    status: { type: "string", enum: ["clean", "changes-requested"] },
    findings: { type: "array", items: FindingSchema },
    summary: { type: "string" },
  },
});

const DEFAULT_ALLOWED_REASONING = ["low", "medium", "high", "xhigh"];
const DEFAULT_ROUTER = { provider: "claude", model: "claude-opus-4-8" };
const DEFAULT_IMPLEMENTER = { provider: "codex", model: "gpt-5.5" };
const DEFAULT_REVIEWER = { provider: "claude", model: "claude-opus-4-8" };
const DEFAULT_MAX_ROUNDS = 3;
const HARD_MAX_ROUNDS = 10;

export default async function smartImplementReview(
  ctx: Ctx,
  input: SmartImplementReviewInput,
): Promise<{
  status: "clean" | "blocked" | "max-rounds-reached";
  route: Awaited<ReturnType<typeof routeWithAgent>>;
  rounds: Round[];
  remainingFindings: Finding[];
}> {
  const candidateSurfaces = requireCandidates(input.candidateSurfaces, "candidateSurfaces");
  const candidateRisks = requireCandidates(input.candidateRisks, "candidateRisks");
  const route = await routeWithAgent(ctx, {
    key: "model-router",
    request: input.task,
    specPath: input.specPath,
    target: ctx.run.target,
    candidateSurfaces,
    candidateRisks,
    constraints: {
      router: DEFAULT_ROUTER,
      allowedBackends: [DEFAULT_IMPLEMENTER, DEFAULT_REVIEWER],
      allowedReasoning: input.allowedReasoning ?? DEFAULT_ALLOWED_REASONING,
      maxReasoning: input.maxReasoning ?? "xhigh",
      defaultImplementer: DEFAULT_IMPLEMENTER,
      defaultReviewer: DEFAULT_REVIEWER,
    },
  });
  ctx.log("model.routing", {
    complexity: route.complexity,
    surfaces: route.surfaces,
    risks: route.risks,
    implementer: route.implementer
      ? {
          provider: route.implementer.provider,
          model: route.implementer.model,
          reasoning: route.implementer.reasoning ?? null,
        }
      : null,
    reviewer: route.reviewer
      ? {
          provider: route.reviewer.provider,
          model: route.reviewer.model,
          reasoning: route.reviewer.reasoning ?? null,
        }
      : null,
    rationale: route.rationale,
  });

  const implementerRoute =
    route.implementer ??
    selectModelRoute({
      role: "implementer",
      task: "implementation",
      complexity: route.complexity,
      surfaces: route.surfaces,
      risks: route.risks,
    });
  const reviewerRoute =
    route.reviewer ??
    selectModelRoute({
      role: "reviewer",
      task: "implementation-review",
      complexity: route.complexity,
      surfaces: route.surfaces,
      risks: route.risks,
    });

  const implementer = ctx.agentSession({
    key: "implementer",
    provider: implementerRoute.provider,
    model: implementerRoute.model,
    reasoning: implementerRoute.reasoning,
  });
  const reviewer = ctx.agentSession({
    key: "reviewer",
    provider: reviewerRoute.provider,
    model: reviewerRoute.model,
    reasoning: reviewerRoute.reasoning,
    toolPolicy: "read-only",
  });
  const maxRounds = clampRounds(
    route.maxRounds ?? implementerRoute.maxRounds ?? reviewerRoute.maxRounds ?? DEFAULT_MAX_ROUNDS,
  );
  const rounds: Round[] = [];
  let remainingFindings: Finding[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const implementation = await implementer.turn({
      key: round === 1 ? "implement-1" : `fix-${round}`,
      prompt:
        round === 1
          ? buildImplementationPrompt(input.task, route.verification)
          : buildFixPrompt(input.task, remainingFindings, route.verification),
      schema: ImplementationSchema,
      lenient: true,
      ...(implementerRoute.timeoutMs ? { timeoutMs: implementerRoute.timeoutMs } : {}),
    });

    if (implementation.status === "blocked") {
      return { status: "blocked", route, rounds, remainingFindings };
    }

    const review = await reviewer.turn({
      key: `review-${round}`,
      prompt: buildReviewPrompt(input.task, implementation, route.verification),
      schema: ReviewSchema,
      lenient: true,
      ...(reviewerRoute.timeoutMs ? { timeoutMs: reviewerRoute.timeoutMs } : {}),
    });
    rounds.push({ round, implementation, review });
    remainingFindings = review.findings;
    if (review.status === "clean" && review.findings.length === 0) {
      return { status: "clean", route, rounds, remainingFindings: [] };
    }
  }

  return { status: "max-rounds-reached", route, rounds, remainingFindings };
}

function buildImplementationPrompt(task: string, verification: readonly string[]): string {
  return [
    "Implement the requested change in the current workspace.",
    "",
    "Task:",
    task,
    "",
    "Expected verification:",
    verification.length > 0
      ? verification.map((item) => `- ${item}`).join("\n")
      : "- Use judgment.",
    "",
    "Return structured JSON describing status, summary, files changed, and verification run.",
  ].join("\n");
}

function buildFixPrompt(
  task: string,
  findings: readonly Finding[],
  verification: readonly string[],
): string {
  return [
    "Address the review findings from the previous round in the current workspace.",
    "",
    "Task:",
    task,
    "",
    "Findings:",
    findings.length > 0
      ? findings
          .map(
            (finding, index) =>
              `${index + 1}. [${finding.severity}] ${finding.title}\nEvidence: ${finding.evidence}\nRecommendation: ${finding.recommendation}`,
          )
          .join("\n\n")
      : "No structured findings were provided; use the prior review summary.",
    "",
    "Expected verification:",
    verification.length > 0
      ? verification.map((item) => `- ${item}`).join("\n")
      : "- Use judgment.",
    "",
    "Return structured JSON describing status, summary, files changed, and verification run.",
  ].join("\n");
}

function buildReviewPrompt(
  task: string,
  implementation: ImplementationResult,
  verification: readonly string[],
): string {
  return [
    "Review the implementation for correctness, regressions, and missing tests.",
    "",
    "Task:",
    task,
    "",
    "Implementation summary:",
    implementation.summary,
    "",
    "Files changed:",
    implementation.filesChanged.map((file) => `- ${file}`).join("\n") || "- none reported",
    "",
    "Expected verification:",
    verification.length > 0
      ? verification.map((item) => `- ${item}`).join("\n")
      : "- Use judgment.",
    "",
    "Return structured JSON with status, findings, and summary.",
  ].join("\n");
}

function requireCandidates<T>(values: readonly T[] | undefined, label: string): T[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must include at least one trusted candidate value`);
  }
  return [...values];
}

function clampRounds(value: number): number {
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_MAX_ROUNDS;
  return Math.min(value, HARD_MAX_ROUNDS);
}
