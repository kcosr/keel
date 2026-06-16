import {
  CodeReviewInputSchema,
  DocsReviewInputSchema,
  PlanReviewInputSchema,
} from "./guidance/input-schema";

export const TASK_REVIEW_GUIDANCE_PACKAGE = "task-review-guidance";

export const TASK_REVIEW_WORKFLOWS = [
  {
    name: "task-code-review",
    file: "workflows/task-review-guidance/code-review.workflow.ts",
    workflowName: "codeReview",
    title: "Task Code Review",
    description: "Read-only code review using Keel's captured review guidance.",
    tags: ["review", "code"],
    inputSchema: CodeReviewInputSchema,
  },
  {
    name: "task-plan-review",
    file: "workflows/task-review-guidance/plan-review.workflow.ts",
    workflowName: "planReview",
    title: "Task Plan Review",
    description: "Spec and implementation-plan review with optional correspondence append.",
    tags: ["review", "plan", "design"],
    inputSchema: PlanReviewInputSchema,
  },
  {
    name: "task-docs-review",
    file: "workflows/task-review-guidance/docs-review.workflow.ts",
    workflowName: "docsReview",
    title: "Task Docs Review",
    description: "Documentation review against the repository's actual public surface.",
    tags: ["review", "docs"],
    inputSchema: DocsReviewInputSchema,
  },
] as const;
