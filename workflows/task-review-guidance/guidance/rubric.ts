// Keep this runtime edge so type-only guidance/types.ts is captured into saved
// workflow bundles and visible through `workflow source --all`.
import "./types";
import type { ReviewChecklistItem, ReviewRubric } from "./types";

export const CODE_REVIEW_RUBRIC: ReviewRubric = {
  id: "code-review",
  title: "Code Review Rubric",
  audience: "code",
  checklist: [
    {
      id: "code.correctness",
      label: "Correctness",
      prompt: "Verify the implementation satisfies the requested behavior and handles edge cases explicitly.",
      required: true,
    },
    {
      id: "code.regressions",
      label: "Regressions",
      prompt: "Look for behavior changes outside the requested scope, including CLI/API output shape changes.",
      required: true,
    },
    {
      id: "code.tests",
      label: "Tests",
      prompt: "Check that deterministic tests cover the changed behavior and important failure paths.",
      required: true,
    },
    {
      id: "code.capabilities",
      label: "Capabilities and security",
      prompt:
        "Review tool-policy, capability, workspace, secret, and provider changes for fail-closed behavior.",
      required: true,
    },
    {
      id: "code.persistence",
      label: "Persistence and migrations",
      prompt:
        "Check durable schema, persisted record, registry, and migration implications at the migration boundary.",
      required: true,
    },
    {
      id: "code.replay",
      label: "Replay-visible behavior",
      prompt:
        "Identify changes to workflow SDK behavior, durable waits, agent identity, or replay-visible prompt contracts.",
      required: true,
    },
    {
      id: "code.workspace",
      label: "Workspace isolation",
      prompt:
        "Verify workspace selection, direct/worktree modes, cwd handling, and write paths are intentional and tested.",
      required: true,
    },
    {
      id: "code.docs",
      label: "Documentation",
      prompt:
        "Check user-facing docs, agent guidance, and changelog entries for changed commands, APIs, defaults, or workflows.",
      required: true,
    },
  ],
  cleanCriteria: [
    "The requested behavior is implemented without unrelated refactors.",
    "No correctness, durability, security, capability, or prompt-contract findings remain.",
    "Tests and documentation match the final behavior.",
    "Any residual risk is called out in the summary rather than hidden as clean.",
  ],
  severityRules: {
    critical:
      "A defect that can corrupt durable state, expose secrets, bypass capability boundaries, or make normal runs unrecoverable.",
    high:
      "A likely user-visible failure, broken workflow contract, missing migration, or write-capability broadening.",
    medium:
      "A scoped correctness, test, documentation, or edge-case gap that should be fixed before release.",
    low:
      "A maintainability, clarity, or narrow polish issue that is worth addressing but does not block basic use.",
  },
};

export const PLAN_REVIEW_RUBRIC: ReviewRubric = {
  id: "plan-review",
  title: "Plan Review Rubric",
  audience: "plan",
  checklist: [
    {
      id: "plan.goals",
      label: "Goals and non-goals",
      prompt: "Verify the plan states the intended outcome, explicit non-goals, and acceptance criteria.",
      required: true,
    },
    {
      id: "plan.api",
      label: "API and behavior",
      prompt: "Check CLI, RPC, SDK, workflow, and output-contract changes for precise behavior.",
      required: true,
    },
    {
      id: "plan.migrations",
      label: "Persistence and migrations",
      prompt: "Identify journal, registry, durable record, and migration requirements or confirm none are needed.",
      required: true,
    },
    {
      id: "plan.tests",
      label: "Test strategy",
      prompt: "Require deterministic coverage at the boundary the change affects, plus focused verification commands.",
      required: true,
    },
    {
      id: "plan.rollout",
      label: "Sequencing and rollout",
      prompt: "Check implementation order, compatibility boundaries, versioning, and release or setup steps.",
      required: true,
    },
    {
      id: "plan.docs",
      label: "Documentation",
      prompt: "Verify the docs that need updates are named and the expected user-facing changes are described.",
      required: true,
    },
    {
      id: "plan.questions",
      label: "Open questions",
      prompt: "Find unresolved decisions, hidden assumptions, and places where the plan should fail explicitly.",
      required: true,
    },
    {
      id: "plan.keel-native",
      label: "Keel-native scope",
      prompt:
        "Confirm the plan uses Keel-native workflow source, capture, registry, and capability models instead of external package state.",
      required: true,
    },
  ],
  cleanCriteria: [
    "The plan is specific enough for an implementer to make the change without guessing.",
    "Persistence, capability, replay, SDK/runtime, and prompt-contract implications are resolved.",
    "Tests, docs, and saved workflow versioning are covered where relevant.",
    "No unresolved blocker or contradiction remains in the design.",
  ],
  severityRules: {
    critical:
      "A design flaw that would corrupt durable state, violate capability boundaries, or make the proposed feature unsafe to ship.",
    high:
      "A missing compatibility, migration, SDK/runtime, workflow capture, or write-path detail likely to produce a wrong implementation.",
    medium:
      "An ambiguity or coverage gap that can be resolved during implementation but should be specified before handoff.",
    low:
      "A clarity, sequencing, documentation, or minor consistency issue that improves implementation quality.",
  },
};

export function selectRubric(kind: "code" | "plan"): ReviewRubric {
  return kind === "code" ? CODE_REVIEW_RUBRIC : PLAN_REVIEW_RUBRIC;
}

export function mergeChecklist(
  base: ReviewRubric,
  extras: ReviewChecklistItem[],
): ReviewRubric {
  return {
    ...base,
    checklist: [...base.checklist, ...extras],
  };
}
