import { type Ctx, jsonSchema } from "@kcosr/keel";

type Finding = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  file: string;
  line: number;
  problem: string;
  recommendation: string;
};

type Milestone = {
  id: string;
  title: string;
  task: string;
  acceptance: string[];
  verification: string[];
};

type ImplementationResult = {
  status: "implemented" | "partial" | "blocked";
  milestoneId: string;
  summary: string;
  filesChanged: string[];
  commits: string[];
  verification: string[];
  screenshotPaths: string[];
  adversarialReview: string;
  notes: string;
};

type ReviewResult = {
  status: "clean" | "changes-requested";
  milestoneId: string;
  summary: string;
  findings: Finding[];
  advisoryFindings: Finding[];
  visualNotes: string;
  verificationNotes: string;
};

type MilestoneRound = {
  milestoneId: string;
  round: number;
  implementation: ImplementationResult;
  review: ReviewResult;
};

type ControlSignal = {
  action: "next" | "rework" | "complete";
  instructions?: string;
  reviewFocus?: string;
};

type WebUiProductLoopInput = {
  repository?: string;
  ref?: string;
  spec?: string;
  prototypeDir?: string;
  mockupsDir?: string;
  milestones?: Milestone[];
  maxRoundsPerMilestone?: number;
  implementerReasoning?: string;
  reviewerReasoning?: string;
  controlSignalName?: string;
  verificationCommand?: string;
};

type ResolvedInput = WebUiProductLoopInput & {
  repository: string;
  ref: string;
  spec: string;
  prototypeDir: string;
  mockupsDir: string;
  milestones: Milestone[];
  maxRoundsPerMilestone: number;
  controlSignalName: string;
  workspaceId: string;
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

const ImplementationSchema = jsonSchema<ImplementationResult>({
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "milestoneId",
    "summary",
    "filesChanged",
    "commits",
    "verification",
    "screenshotPaths",
    "adversarialReview",
    "notes",
  ],
  properties: {
    status: { type: "string", enum: ["implemented", "partial", "blocked"] },
    milestoneId: { type: "string" },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    commits: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    screenshotPaths: { type: "array", items: { type: "string" } },
    adversarialReview: { type: "string" },
    notes: { type: "string" },
  },
});

const ReviewSchema = jsonSchema<ReviewResult>({
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "milestoneId",
    "summary",
    "findings",
    "advisoryFindings",
    "visualNotes",
    "verificationNotes",
  ],
  properties: {
    status: { type: "string", enum: ["clean", "changes-requested"] },
    milestoneId: { type: "string" },
    summary: { type: "string" },
    findings: { type: "array", items: FindingSchema },
    advisoryFindings: { type: "array", items: FindingSchema },
    visualNotes: { type: "string" },
    verificationNotes: { type: "string" },
  },
});

const DEFAULT_MAX_ROUNDS_PER_MILESTONE = 4;
const HARD_MAX_ROUNDS_PER_MILESTONE = 10;
const IMPLEMENTER_PROFILE = "codex-default";
const REVIEWER_PROFILE = "claude-default";
const WORKSPACE_KEY = "web-ui-product";
const DEFAULT_SPEC = ".specs/web-ui-end-state-implementation.md";
const DEFAULT_PROTOTYPE_DIR = ".specs/web-ui-mockups/prototype";
const DEFAULT_MOCKUPS_DIR = ".specs/web-ui-mockups";

const DEFAULT_MILESTONES: Milestone[] = [
  {
    id: "frontend-foundation",
    title: "Frontend foundation",
    task:
      "Create the tracked React/Vite/TypeScript frontend, shared app shell, design primitives, typed web API client, SSE parser, and base tests.",
    acceptance: [
      "web/ contains production frontend source, config, styles, and tests.",
      "Root scripts can build and test the frontend.",
      "The built bundle is emitted to web/dist and can be served by keel web.",
      "The UI shell materially follows the prototype density and navigation model.",
    ],
    verification: ["bun run web:build", "bun run web:test", "bun run typecheck"],
  },
  {
    id: "runs-live-detail",
    title: "Runs inbox and live detail",
    task:
      "Implement runs inbox, run detail tabs, live SSE watching, coalesced transcript display, raw events, and a graph/timeline view grounded in RunProjection.",
    acceptance: [
      "Runs inbox loads from GET /api/runs and defaults newest first.",
      "Run detail loads from GET /api/runs/:runId.",
      "Live watching uses fetch-based SSE with Authorization headers and reconnect cursors.",
      "Graph/timeline uses RunProjection nodes and does not invent unsupported backend states.",
    ],
    verification: ["bun run web:build", "bun run web:test", "browser smoke for runs/detail/watch"],
  },
  {
    id: "approvals-workspaces",
    title: "Approvals and workspaces",
    task:
      "Implement workflow-gate approvals, approval decisions, workspace list/detail/diff, and authorized workspace mutation controls with confirmations.",
    acceptance: [
      "Approvals page is grounded in current ctx.human/waiting-human gates only.",
      "Approve/deny controls call daemon RPC only when authorized.",
      "Workspace diff view displays retained workspace diffs from existing APIs.",
      "Merge/discard/gc controls require admin authority and confirmation.",
    ],
    verification: ["bun run web:build", "bun run web:test", "browser smoke for approvals/workspaces"],
  },
  {
    id: "workflow-system-surfaces",
    title: "Workflow, schedule, profile, settings, and system surfaces",
    task:
      "Implement saved workflow source/detail, read-only schedules, profile/settings inspection, and system status against current APIs.",
    acceptance: [
      "Saved workflow list/detail/source views call real daemon RPC methods.",
      "Schedules are read-only and use listSchedules/getSchedule or dedicated web projections.",
      "Profiles/settings views make current catalog state inspectable.",
      "System view uses /health and /api/system without inferring unavailable daemon internals.",
    ],
    verification: ["bun run web:build", "bun run web:test", "browser smoke for remaining screens"],
  },
  {
    id: "polish-production-readiness",
    title: "Polish and production readiness",
    task:
      "Tighten visual fidelity, responsive behavior, keyboard/copy affordances, docs, changelog, and final end-to-end verification.",
    acceptance: [
      "Primary screens materially match the mockup/prototype composition.",
      "Unauthorized controls are disabled with explanations and CLI equivalents.",
      "Screenshots or browser captures cover primary desktop and mobile routes.",
      "Docs and changelog describe the shipped web UI accurately.",
    ],
    verification: [
      "bun run web:build",
      "bun run web:test",
      "bun run typecheck",
      "bun run lint",
      "focused backend tests if backend changed",
    ],
  },
];

export default async function webUiProductLoop(
  ctx: Ctx,
  input: WebUiProductLoopInput,
): Promise<{
  status: "complete" | "blocked" | "max-rounds-reached";
  workspace: { id: string; repository: string; ref: string; identityHash?: string };
  completedMilestones: string[];
  rounds: MilestoneRound[];
  blockedImplementation?: ImplementationResult;
  remainingFindings?: Finding[];
}> {
  const repository = resolveRepository(input.repository, ctx.run.target);
  const ref = input.ref && input.ref.trim().length > 0 ? input.ref : "HEAD";
  const workspace = await ctx.workspace({
    key: WORKSPACE_KEY,
    mode: "worktree",
    path: repository,
    ref,
    branch: true,
    retention: "retain",
  });
  const resolved: ResolvedInput = {
    ...input,
    repository,
    ref,
    spec: resolvePath(input.spec ?? DEFAULT_SPEC, repository),
    prototypeDir: resolvePath(input.prototypeDir ?? DEFAULT_PROTOTYPE_DIR, repository),
    mockupsDir: resolvePath(input.mockupsDir ?? DEFAULT_MOCKUPS_DIR, repository),
    milestones: input.milestones ?? DEFAULT_MILESTONES,
    maxRoundsPerMilestone: clampRounds(
      input.maxRoundsPerMilestone ?? DEFAULT_MAX_ROUNDS_PER_MILESTONE,
    ),
    controlSignalName: input.controlSignalName ?? "web-ui-control",
    workspaceId: workspace.id,
  };

  const result = await ctx.withWorkspace(workspace, async () => {
    const rounds: MilestoneRound[] = [];
    const completedMilestones: string[] = [];
    let carryInstructions: string | undefined;
    let carryReviewFocus: string | undefined;

    for (const milestone of resolved.milestones) {
      const implementer = ctx.agentSession({
        key: `implementer-${milestone.id}`,
        profile: IMPLEMENTER_PROFILE,
        reasoning: input.implementerReasoning ?? "xhigh",
      });
      const reviewer = ctx.agentSession({
        key: `reviewer-${milestone.id}`,
        profile: REVIEWER_PROFILE,
        reasoning: input.reviewerReasoning ?? "xhigh",
        toolPolicy: "read-only",
      });
      let findings: Finding[] = [];
      let round = 1;
      let turnSeq = 1;
      while (true) {
        const seq = turnSeq++;
        ctx.phase(`${milestone.title} implementation ${round} (turn ${seq})`);
        const implementation = await implementer.turn({
          key: `${milestone.id}-implement-${seq}`,
          prompt: implementationPrompt(resolved, milestone, round, findings, carryInstructions),
          schema: ImplementationSchema,
          lenient: true,
        });
        ctx.log(`${milestone.id}.implementation.${seq}`, implementation);
        carryInstructions = undefined;

        if (implementation.status === "blocked") {
          return {
            status: "blocked" as const,
            completedMilestones,
            rounds,
            blockedImplementation: implementation,
            remainingFindings: findings,
          };
        }

        ctx.phase(`${milestone.title} Claude review ${round} (turn ${seq})`);
        const review = await reviewer.turn({
          key: `${milestone.id}-review-${seq}`,
          prompt: reviewPrompt(resolved, milestone, round, implementation, findings, carryReviewFocus),
          schema: ReviewSchema,
          lenient: true,
        });
        ctx.log(`${milestone.id}.review.${seq}`, review);
        carryReviewFocus = undefined;
        rounds.push({ milestoneId: milestone.id, round: seq, implementation, review });

        findings = review.findings;
        const blockingFindings = findings.filter((finding) => finding.severity !== "low");
        if (review.status === "clean" && blockingFindings.length === 0) {
          completedMilestones.push(milestone.id);
          ctx.phase(
            review.advisoryFindings.length > 0
              ? `${milestone.title} accepted with advisory findings`
              : `${milestone.title} accepted`,
          );
          const control = await ctx.signal<ControlSignal>(resolved.controlSignalName);
          ctx.log(`${milestone.id}.control`, control);
          if (control.action === "complete") {
            return { status: "complete" as const, completedMilestones, rounds };
          }
          if (control.action === "rework") {
            carryInstructions = control.instructions ?? "Perform another implementation pass.";
            carryReviewFocus = control.reviewFocus;
            findings = [];
            completedMilestones.pop();
            round++;
            continue;
          }
          carryInstructions = control.instructions;
          carryReviewFocus = control.reviewFocus;
          break;
        }
        if (round >= resolved.maxRoundsPerMilestone) {
          ctx.phase(`${milestone.title} max review rounds reached`);
          const control = await ctx.signal<ControlSignal>(resolved.controlSignalName);
          ctx.log(`${milestone.id}.control.max_rounds`, control);
          if (control.action === "complete") {
            return {
              status: "complete" as const,
              completedMilestones,
              rounds,
              remainingFindings: blockingFindings,
            };
          }
          if (control.action === "next") {
            completedMilestones.push(milestone.id);
            carryInstructions = control.instructions;
            carryReviewFocus = control.reviewFocus;
            break;
          }
          carryInstructions = control.instructions ?? "Continue addressing reviewer findings.";
          carryReviewFocus = control.reviewFocus;
          findings = blockingFindings;
          round = 1;
          continue;
        }
        round++;
      }

      if (!completedMilestones.includes(milestone.id)) {
        return {
          status: "max-rounds-reached" as const,
          completedMilestones,
          rounds,
          remainingFindings: rounds.at(-1)?.review.findings ?? [],
        };
      }
    }

    return { status: "complete" as const, completedMilestones, rounds };
  });

  return {
    ...result,
    workspace: {
      id: workspace.id,
      repository,
      ref,
      ...(workspace.identityHash ? { identityHash: workspace.identityHash } : {}),
    },
  };
}

function implementationPrompt(
  input: ResolvedInput,
  milestone: Milestone,
  round: number,
  findings: Finding[],
  instructions: string | undefined,
): string {
  const priorFindings =
    findings.length > 0
      ? `\nPrior reviewer findings to address:\n${JSON.stringify(findings, null, 2)}\n`
      : "";
  return `${workspaceInstructions(input)}

Implement web UI milestone ${milestone.id}: ${milestone.title}

Spec: ${input.spec}
Prototype directory: ${input.prototypeDir}
Mockups directory: ${input.mockupsDir}
${input.verificationCommand ? `Additional verification command: ${input.verificationCommand}\n` : ""}
Milestone task:
${milestone.task}

Acceptance criteria:
${milestone.acceptance.map((item) => `- ${item}`).join("\n")}

Expected verification:
${milestone.verification.map((item) => `- ${item}`).join("\n")}
${instructions ? `\nAdditional orchestrator instructions:\n${instructions}\n` : ""}${priorFindings}
Round: ${round}

Work only in the bound branch-backed worktree. Use the current working directory
for edits, diffs, commits, browser smoke, and screenshots. Prefer scoped,
end-state implementation over compatibility shims. Use the prototype as a visual
target but do not ship fixture-backed code as production data plumbing.

Before editing, verify that you can read the Spec, Prototype directory, and
Mockups directory paths above. If any reference path is unavailable, return
status "blocked" with the failure in notes instead of proceeding from memory.

Before reporting, ask an internal adversarial subagent to review your changes
when available, incorporate agreed findings, commit coherent changes, and run
focused verification where practical. Return commit hashes, verification, any
screenshot paths, and a summary of the adversarial review.`;
}

function reviewPrompt(
  input: ResolvedInput,
  milestone: Milestone,
  round: number,
  implementation: ImplementationResult,
  priorFindings: Finding[],
  reviewFocus: string | undefined,
): string {
  return `${workspaceInstructions(input)}

Review web UI milestone ${milestone.id}: ${milestone.title}

Spec: ${input.spec}
Prototype directory: ${input.prototypeDir}
Mockups directory: ${input.mockupsDir}
${reviewFocus ? `Review focus: ${reviewFocus}\n` : ""}
Milestone task:
${milestone.task}

Acceptance criteria:
${milestone.acceptance.map((item) => `- ${item}`).join("\n")}

Implementation report:
${JSON.stringify(implementation, null, 2)}
${priorFindings.length > 0 ? `\nPrior findings expected to be fixed:\n${JSON.stringify(priorFindings, null, 2)}\n` : ""}
Round: ${round}

Review the current branch-backed worktree directly. Use read-only tools. Check
correctness, API contract fit, authorization behavior, visual fidelity against
the prototype/mockups, docs, and regressions. You may inspect committed
screenshots and test output reported by the implementer, but runtime build/test
execution and browser navigation are the orchestrator's responsibility unless
this workflow is later changed to give the reviewer execution tools.

First verify that the Spec, Prototype directory, and Mockups directory paths
above are readable. If they are not, report a blocking finding instead of
reviewing from memory.

Use findings only for issues that should block milestone acceptance. Low-severity
nits should usually go in advisoryFindings unless they materially affect the
milestone. If there are no blocking findings, return status "clean" and an empty
findings array. If status is "changes-requested", the workflow treats the
milestone as not accepted even when findings are low-severity.`;
}

function workspaceInstructions(input: ResolvedInput): string {
  return `Keel has created and bound a retained generated-branch git worktree.
Current working directory: the branch-backed worktree to edit/review.
Source repository: ${input.repository}
Source ref: ${input.ref}
Workspace handle: ${input.workspaceId}

Use the current working directory, not the source repository path, for git
status, commits, diffs, tests, screenshots, and browser smoke. The spec,
prototype, and mockup paths may point back to the source repository because
those reference files are intentionally read-only planning assets. Do not edit
the source repository copy of those reference files from inside this workflow.`;
}

function resolveRepository(repository: string | undefined, runTarget: string): string {
  return repository && repository.trim().length > 0 ? repository : runTarget;
}

function resolvePath(path: string, repository: string): string {
  if (path.startsWith("/")) return path;
  return `${repository.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function clampRounds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROUNDS_PER_MILESTONE;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  if (whole > HARD_MAX_ROUNDS_PER_MILESTONE) return HARD_MAX_ROUNDS_PER_MILESTONE;
  return whole;
}
