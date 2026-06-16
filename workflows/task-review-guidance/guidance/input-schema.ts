export const CodeReviewInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository", "task"],
  properties: {
    repository: { type: "string" },
    task: { type: "string" },
    focus: { type: "array", items: { type: "string" } },
    reviewerProfile: { type: "string" },
    reviewerReasoning: { type: "string" },
    maxFindings: { type: "integer", minimum: 1 },
  },
} as const;

export const PlanReviewInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["specPath", "request"],
  properties: {
    specPath: { type: "string" },
    request: { type: "string" },
    focus: { type: "array", items: { type: "string" } },
    appendCorrespondence: { type: "boolean" },
    correspondenceHeader: { type: "string" },
    reviewerProfile: { type: "string" },
    reviewerReasoning: { type: "string" },
  },
} as const;

export const DocsReviewInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["repository"],
  properties: {
    repository: { type: "string" },
    task: { type: "string" },
    focus: { type: "array", items: { type: "string" } },
    reviewerProfile: { type: "string" },
    reviewerReasoning: { type: "string" },
    maxFindings: { type: "integer", minimum: 1 },
  },
} as const;
