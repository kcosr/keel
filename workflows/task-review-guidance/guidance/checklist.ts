import type { ReviewRubric } from "./types";

export function renderChecklist(rubric: ReviewRubric): string {
  return [
    `Checklist: ${rubric.title}`,
    ...rubric.checklist.map((item) => {
      const requirement = item.required ? "required" : "optional";
      return `- ${item.id} (${requirement}) ${item.label}: ${item.prompt}`;
    }),
  ].join("\n");
}

export function renderCleanCriteria(rubric: ReviewRubric): string {
  return ["Clean Review Criteria", ...rubric.cleanCriteria.map((criterion) => `- ${criterion}`)].join(
    "\n",
  );
}

export function renderSeverityRules(rubric: ReviewRubric): string {
  const ordered = ["critical", "high", "medium", "low"] as const;
  return [
    "Severity Rules",
    ...ordered.map((severity) => `- ${severity}: ${rubric.severityRules[severity]}`),
  ].join("\n");
}
