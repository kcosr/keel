import { renderChecklist, renderCleanCriteria, renderSeverityRules } from "./checklist";
import { renderFindingContract } from "./finding";
import { selectRubric } from "./rubric";

export interface CodeReviewPromptInput {
  repository: string;
  task: string;
  diffSummary?: string;
  focus?: string[];
  maxFindings?: number;
}

export interface PlanReviewPromptInput {
  specPath: string;
  request: string;
  focus?: string[];
  correspondenceHeader?: string;
  appendCorrespondence?: boolean;
}

export interface DocsReviewPromptInput {
  repository: string;
  task?: string;
  focus?: string[];
  maxFindings?: number;
}

export function buildCodeReviewPrompt(input: CodeReviewPromptInput): string {
  const rubric = selectRubric("code");
  return compactLines([
    "Review the requested code change.",
    "",
    `Repository: ${input.repository}`,
    `Task: ${input.task}`,
    input.diffSummary ? `Diff summary:\n${input.diffSummary}` : "",
    renderFocus(input.focus),
    input.maxFindings !== undefined
      ? `Advisory finding cap: ${input.maxFindings}. Do not hide findings solely because the cap is exceeded; mention the excess in the summary.`
      : "",
    "Read the relevant files and current repository state yourself. Report only concrete, actionable findings grounded in evidence.",
    "",
    renderChecklist(rubric),
    "",
    renderSeverityRules(rubric),
    "",
    renderCleanCriteria(rubric),
    "",
    renderFindingContract("code"),
  ]);
}

export function buildPlanReviewPrompt(input: PlanReviewPromptInput): string {
  const rubric = selectRubric("plan");
  return compactLines([
    "Review the requested plan or design document.",
    "",
    `Spec path: ${input.specPath}`,
    `Request: ${input.request}`,
    renderFocus(input.focus),
    input.appendCorrespondence
      ? [
          "Append mode: append your review correspondence only under a ## Correspondence section in the spec file.",
          `Correspondence header to add exactly: ${input.correspondenceHeader ?? ""}`,
          "Create the correspondence section if needed. Do not rewrite the main design content.",
        ].join("\n")
      : "",
    "Read the full plan and current correspondence history when available. Report unresolved correctness, completeness, sequencing, or implementation risks.",
    "",
    renderChecklist(rubric),
    "",
    renderSeverityRules(rubric),
    "",
    renderCleanCriteria(rubric),
    "",
    renderFindingContract("plan"),
  ]);
}

export function buildDocsReviewPrompt(input: DocsReviewPromptInput): string {
  const rubric = selectRubric("docs");
  return compactLines([
    "Review the repository documentation against the actual public surface.",
    "",
    `Repository: ${input.repository}`,
    input.task ? `Task: ${input.task}` : "",
    renderFocus(input.focus),
    input.maxFindings !== undefined
      ? `Advisory finding cap: ${input.maxFindings}. Do not hide findings solely because the cap is exceeded; mention the excess in the summary.`
      : "",
    "Read the relevant docs, command help, source, tests, and examples yourself. Report only concrete documentation findings grounded in evidence.",
    "",
    renderChecklist(rubric),
    "",
    renderSeverityRules(rubric),
    "",
    renderCleanCriteria(rubric),
    "",
    renderFindingContract("docs"),
  ]);
}

function renderFocus(focus: string[] | undefined): string {
  if (!focus || focus.length === 0) return "";
  return ["Focus:", ...focus.map((item) => `- ${item}`)].join("\n");
}

function compactLines(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("\n");
}
