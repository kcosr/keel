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
      id: "code.orientation",
      label: "Repository orientation",
      prompt:
        "Identify the actual touched files, surrounding ownership boundaries, and requested review scope before judging the change.",
      required: true,
    },
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
      id: "code.architecture",
      label: "Architecture and boundaries",
      prompt:
        "Check that the change fits existing module boundaries, central resolution paths, and repository conventions.",
      required: true,
    },
    {
      id: "code.async",
      label: "Async and concurrency safety",
      prompt:
        "Review awaits, cancellation, streaming, subscriptions, races, idempotence, and repeated invocation behavior.",
      required: true,
    },
    {
      id: "code.errors",
      label: "Error handling and edges",
      prompt:
        "Look for invalid input, missing files, malformed provider output, partial failure, and explicit error reporting.",
      required: true,
    },
    {
      id: "code.lifecycle",
      label: "State-machine and lifecycle",
      prompt:
        "Check state transitions, enable/disable/delete semantics, durable lifecycle rows, and retry/resume behavior.",
      required: true,
    },
    {
      id: "code.resources",
      label: "Resource cleanup",
      prompt:
        "Verify sockets, files, temp directories, workspaces, providers, and subscriptions are closed or retained intentionally.",
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
        "Review tool-policy, capability, workspace, secret, untrusted input, and provider changes for fail-closed behavior.",
      required: true,
    },
    {
      id: "code.types",
      label: "Type and schema rigor",
      prompt:
        "Check TypeScript unions, JSON schemas, structured output validation, and persisted JSON parsing for precision.",
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
      label: "Focused docs drift",
      prompt:
        "Check user-facing docs, agent guidance, and changelog entries for changed commands, APIs, defaults, or workflows.",
      required: true,
    },
    {
      id: "code.simplification",
      label: "Simplification and duplication",
      prompt:
        "Flag avoidable duplication, broad abstractions, or local complexity that obscures the product behavior.",
      required: false,
    },
    {
      id: "code.surface",
      label: "Surface completeness",
      prompt:
        "Verify every affected CLI, RPC, workflow, docs, and test surface is updated consistently.",
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
      id: "plan.document",
      label: "Design document resolution",
      prompt:
        "Confirm the plan identifies the authoritative document, latest correspondence, status, and exact requested outcome.",
      required: true,
    },
    {
      id: "plan.orientation",
      label: "Repository orientation",
      prompt:
        "Check the plan against the real code, docs, tests, and existing abstractions it proposes to touch.",
      required: true,
    },
    {
      id: "plan.goals",
      label: "Observable contract and scope",
      prompt:
        "Verify goals, non-goals, acceptance criteria, CLI/RPC/workflow behavior, and output contracts are explicit.",
      required: true,
    },
    {
      id: "plan.surface",
      label: "Surface inventory",
      prompt:
        "Require a complete inventory of commands, APIs, workflow files, docs, persisted records, and tests affected.",
      required: true,
    },
    {
      id: "plan.repository-fit",
      label: "Repository fit",
      prompt:
        "Check that the approach follows Keel architecture, capability resolution, registry, capture, and replay models.",
      required: true,
    },
    {
      id: "plan.api",
      label: "API and behavior",
      prompt: "Check CLI, RPC, SDK, workflow, and output-contract changes for precise behavior.",
      required: true,
    },
    {
      id: "plan.implementation",
      label: "Implementation approach",
      prompt:
        "Evaluate sequencing, ownership boundaries, failure handling, and whether the proposed code path is implementable.",
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
      label: "Risks and test strategy",
      prompt:
        "Require deterministic coverage for risks, edge cases, provider boundaries, and focused verification commands.",
      required: true,
    },
    {
      id: "plan.rollout",
      label: "Migration, rollout, and compatibility",
      prompt:
        "Check implementation order, compatibility boundaries, ABI/schema versioning, and release or setup steps.",
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

export const DOCS_REVIEW_RUBRIC: ReviewRubric = {
  id: "docs-review",
  title: "Docs Review Rubric",
  audience: "docs",
  checklist: [
    {
      id: "docs.inventory",
      label: "Documentation and public surface inventory",
      prompt:
        "Inventory README, usage docs, workflow docs, command help, public APIs, config, and examples relevant to the task.",
      required: true,
    },
    {
      id: "docs.readme",
      label: "README framing",
      prompt:
        "Check that the main framing tells the right user what the project or feature does and where to start.",
      required: true,
    },
    {
      id: "docs.quickstart",
      label: "Quickstart runnability",
      prompt:
        "Verify setup and quickstart commands are ordered, copyable, current, and runnable from a fresh checkout.",
      required: true,
    },
    {
      id: "docs.concepts",
      label: "Conceptual clarity and terminology",
      prompt:
        "Look for undefined terms, overloaded names, missing mental models, and contradictions across docs.",
      required: true,
    },
    {
      id: "docs.accuracy",
      label: "Command, API, and config accuracy",
      prompt:
        "Compare documented commands, flags, env vars, RPC shapes, defaults, and errors against the actual code.",
      required: true,
    },
    {
      id: "docs.examples",
      label: "Example correctness",
      prompt:
        "Check code blocks, JSON payloads, paths, imports, workflow names, and outputs for syntactic and behavioral correctness.",
      required: true,
    },
    {
      id: "docs.completeness",
      label: "Completeness and undocumented features",
      prompt:
        "Identify user-visible behavior, limitations, permissions, scheduling, or failure modes that are missing from docs.",
      required: true,
    },
    {
      id: "docs.navigation",
      label: "Structure and navigation",
      prompt:
        "Review section order, headings, cross-links, discoverability, and whether scripts can find the reference material.",
      required: true,
    },
    {
      id: "docs.diagrams",
      label: "Useful diagram opportunities",
      prompt:
        "Suggest diagrams only when they would clarify durable architecture, flow, lifecycle, or relationships better than prose.",
      required: false,
    },
    {
      id: "docs.voice",
      label: "Voice and format consistency",
      prompt:
        "Check tone, imperative style, table/code formatting, changelog wording, and consistency with nearby docs.",
      required: false,
    },
    {
      id: "docs.accessibility",
      label: "Accessibility and assumed knowledge",
      prompt:
        "Flag inaccessible wording, hidden prerequisites, unexplained acronyms, or assumptions about local setup.",
      required: true,
    },
    {
      id: "docs.synthesis",
      label: "Top findings synthesis",
      prompt:
        "Prioritize the smallest set of documentation issues that would most improve correctness and user success.",
      required: true,
    },
  ],
  cleanCriteria: [
    "The documented public surface matches actual commands, APIs, defaults, and workflow behavior.",
    "Quickstart and examples are runnable without hidden prerequisites beyond stated setup.",
    "Navigation, terminology, and scope make the right next action clear for the intended user.",
    "No material undocumented user-visible behavior or misleading obsolete guidance remains.",
  ],
  severityRules: {
    critical:
      "Documentation that can cause destructive action, secret exposure, data loss, or a severe security/capability misunderstanding.",
    high:
      "A likely failed setup, broken command/API example, or misleading contract that blocks normal use.",
    medium:
      "A missing or inaccurate explanation, option, example, or navigation path that should be fixed before release.",
    low:
      "A wording, formatting, consistency, or minor discoverability issue that improves quality but does not block use.",
  },
};

export function selectRubric(kind: "code" | "plan" | "docs"): ReviewRubric {
  if (kind === "code") return CODE_REVIEW_RUBRIC;
  if (kind === "plan") return PLAN_REVIEW_RUBRIC;
  return DOCS_REVIEW_RUBRIC;
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
