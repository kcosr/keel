import { type Ctx, jsonSchema } from "@kcosr/keel";
import { validateReviewOutput } from "./guidance/finding";
import { buildDocsReviewPrompt } from "./guidance/prompt";
import type { GuidanceFinding } from "./guidance/types";

export interface DocsReviewInput {
  repository: string;
  task?: string;
  focus?: string[];
  reviewerReasoning?: string;
  maxFindings?: number;
}

type ReviewOutput = {
  status: "clean" | "changes-requested";
  findings: GuidanceFinding[];
  summary: string;
};

const FindingSchema = {
  type: "object",
  // Optional file/line are validated in validateReviewOutput. The agent schema
  // hint currently says every listed field is required, so do not list optional
  // location fields here.
  additionalProperties: true,
  required: ["severity", "title", "evidence", "recommendation"],
  properties: {
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    title: { type: "string" },
    evidence: { type: "string" },
    recommendation: { type: "string" },
  },
};

const ReviewOutputSchema = jsonSchema<unknown>({
  type: "object",
  additionalProperties: false,
  required: ["status", "findings", "summary"],
  properties: {
    status: { type: "string", enum: ["clean", "changes-requested"] },
    findings: { type: "array", items: FindingSchema },
    summary: { type: "string" },
  },
});

const CLAUDE_PROVIDER = "claude";
const CLAUDE_MODEL = "claude-opus-4-8";
const DEFAULT_REASONING = "xhigh";

export default async function docsReview(
  ctx: Ctx,
  input: DocsReviewInput,
): Promise<ReviewOutput> {
  const repository = resolveRepository(input.repository, ctx.run.target);
  return await ctx.withWorkspace(
    { key: "repository", mode: "direct", path: repository },
    async () => {
      const raw = await ctx.agent({
        key: "review",
        provider: CLAUDE_PROVIDER,
        model: CLAUDE_MODEL,
        reasoning: input.reviewerReasoning ?? DEFAULT_REASONING,
        toolPolicy: "read-only",
        prompt: buildDocsReviewPrompt({
          repository,
          task: input.task,
          focus: input.focus,
          maxFindings: input.maxFindings,
        }),
        schema: ReviewOutputSchema,
        lenient: true,
      });
      const review = validateReviewOutput(raw);
      if (input.maxFindings !== undefined && review.findings.length > input.maxFindings) {
        review.summary = `${review.summary} Reviewer returned ${review.findings.length} findings, exceeding the advisory cap of ${input.maxFindings}.`;
      }
      return review;
    },
  );
}

function resolveRepository(repository: string, runTarget: string): string {
  const trimmed = repository.trim();
  if (trimmed.length === 0 || trimmed === ".") return runTarget;
  if (trimmed.startsWith("/")) return trimmed;
  return resolveInsideRunTarget(trimmed, runTarget, "repository");
}

function resolveInsideRunTarget(relativePath: string, runTarget: string, label: string): string {
  const parts = relativePath.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) throw new Error(`${label} must stay inside the run target`);
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.length === 0 ? runTarget : `${stripTrailingSlash(runTarget)}/${out.join("/")}`;
}

function stripTrailingSlash(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}
