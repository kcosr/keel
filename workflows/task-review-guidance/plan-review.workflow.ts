import { type Ctx, jsonSchema } from "@kcosr/keel";
import { validateReviewOutput } from "./guidance/finding";
import { buildPlanReviewPrompt } from "./guidance/prompt";
import type { GuidanceFinding } from "./guidance/types";

export interface PlanReviewInput {
  specPath: string;
  request: string;
  focus?: string[];
  appendCorrespondence?: boolean;
  correspondenceHeader?: string;
  reviewerReasoning?: string;
}

type PlanReviewOutput = {
  status: "clean" | "changes-requested";
  findings: GuidanceFinding[];
  summary: string;
  appended: boolean;
};

type ConfirmationOutput = {
  present: boolean;
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

const ConfirmationSchema = jsonSchema<ConfirmationOutput>({
  type: "object",
  additionalProperties: false,
  required: ["present", "summary"],
  properties: {
    present: { type: "boolean" },
    summary: { type: "string" },
  },
});

const CLAUDE_PROVIDER = "claude";
const CLAUDE_MODEL = "claude-opus-4-8";
const DEFAULT_REASONING = "xhigh";

export default async function planReview(
  ctx: Ctx,
  input: PlanReviewInput,
): Promise<PlanReviewOutput> {
  const appendCorrespondence = input.appendCorrespondence === true;
  validateSpecPath(input.specPath);
  if (appendCorrespondence && !input.correspondenceHeader?.trim()) {
    throw new Error("plan review appendCorrespondence requires correspondenceHeader");
  }
  const workspacePath = workspacePathForSpec(input.specPath, ctx.run.target);
  return await ctx.withWorkspace(
    { key: "spec", mode: "direct", path: workspacePath },
    async () => {
      const raw = await ctx.agent({
        key: "review",
        provider: CLAUDE_PROVIDER,
        model: CLAUDE_MODEL,
        reasoning: input.reviewerReasoning ?? DEFAULT_REASONING,
        toolPolicy: appendCorrespondence ? "workspace-write" : "read-only",
        prompt: buildPlanReviewPrompt({
          specPath: input.specPath,
          request: input.request,
          focus: input.focus,
          appendCorrespondence,
          correspondenceHeader: input.correspondenceHeader,
        }),
        schema: ReviewOutputSchema,
        lenient: true,
      });
      const review = validateReviewOutput(raw);
      if (appendCorrespondence) {
        const confirmation = await ctx.agent({
          key: "confirm-correspondence",
          provider: CLAUDE_PROVIDER,
          model: CLAUDE_MODEL,
          reasoning: input.reviewerReasoning ?? DEFAULT_REASONING,
          toolPolicy: "read-only",
          prompt: confirmationPrompt(input.specPath, input.correspondenceHeader as string),
          schema: ConfirmationSchema,
          lenient: true,
        });
        if (!confirmation.present) {
          throw new Error(
            `plan review correspondence confirmation failed: ${confirmation.summary}`,
          );
        }
      }
      const output = { ...review, appended: appendCorrespondence };
      return output;
    },
  );
}

function workspacePathForSpec(specPath: string, runTarget: string): string {
  if (specPath.startsWith("/")) return dirname(specPath);
  assertRelativePathInsideRunTarget(specPath, "specPath");
  return runTarget;
}

function dirname(path: string): string {
  const trimmed = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
}

function validateSpecPath(specPath: string): void {
  if (specPath.trim().length === 0) throw new Error("plan review specPath must be non-empty");
}

function assertRelativePathInsideRunTarget(relativePath: string, label: string): void {
  const parts = relativePath.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (depth === 0) throw new Error(`${label} must stay inside the run target`);
      depth -= 1;
    } else {
      depth += 1;
    }
  }
}

function confirmationPrompt(specPath: string, correspondenceHeader: string): string {
  return `Read ${specPath} and confirm whether the exact header appears under a ## Correspondence section.

Header: ${correspondenceHeader}

Return JSON with present true only if the exact header is present under ## Correspondence.`;
}
