import { type Ctx, jsonSchema } from "@kcosr/keel";

type Finding = {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  file: string;
  line: number;
  problem: string;
  recommendation: string;
};

type ImplementationResult = {
  summary: string;
  status: "implemented" | "partial" | "blocked";
  filesChanged: string[];
  verification: string[];
  notes: string;
};

type Review = {
  summary: string;
  findings: Finding[];
};

type WorkspaceRetention = "remove" | "retain-on-failure" | "retain";

type BranchWorktreeImplementReviewInput = {
  repository?: string;
  ref?: string;
  retention?: WorkspaceRetention;
  spec: string;
  task?: string;
  maxRounds?: number;
  completionMode?: "auto" | "park-before-complete";
  completionSignalName?: string;
  implementerReasoning?: string;
  reviewerReasoning?: string;
  reviewFocus?: string;
  verificationCommand?: string;
};

type Round = {
  round: number;
  implementation: ImplementationResult;
  review: Review;
};

type CompletionSignal = {
  action: "complete" | "continue";
  instructions?: string;
  reviewFocus?: string;
};

type ResolvedInput = BranchWorktreeImplementReviewInput & {
  repository: string;
  ref: string;
  retention: WorkspaceRetention;
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
  required: ["summary", "status", "filesChanged", "verification", "notes"],
  properties: {
    summary: { type: "string" },
    status: { type: "string", enum: ["implemented", "partial", "blocked"] },
    filesChanged: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
});

const ReviewSchema = jsonSchema<Review>({
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: FindingSchema,
    },
  },
});

const DEFAULT_MAX_ROUNDS = 3;
const HARD_MAX_ROUNDS = 10;
const IMPLEMENTER_PROFILE = "codex-default";
const REVIEWER_PROFILE = "claude-default";
const DEFAULT_RETENTION: WorkspaceRetention = "retain";
const WORKSPACE_KEY = "implementation";

export default async function branchWorktreeImplementReview(
  ctx: Ctx,
  input: BranchWorktreeImplementReviewInput,
): Promise<{
  status: "clean" | "blocked" | "max-rounds-reached";
  workspace: { id: string; identityHash?: string; repository: string; ref: string; retention: WorkspaceRetention };
  rounds: Round[];
  remainingFindings: Finding[];
  blockedImplementation?: ImplementationResult;
}> {
  const repository = resolveRepository(input.repository, ctx.run.target);
  const ref = input.ref && input.ref.trim().length > 0 ? input.ref : "HEAD";
  const retention = input.retention ?? DEFAULT_RETENTION;
  const workspace = await ctx.workspace({
    key: WORKSPACE_KEY,
    mode: "worktree",
    path: repository,
    ref,
    branch: true,
    retention,
  });
  const resolvedInput: ResolvedInput = {
    ...input,
    repository,
    ref,
    retention,
    workspaceId: workspace.id,
  };
  const maxRounds = clampRounds(input.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const completionSignalName = input.completionSignalName ?? "implementation-completion";

  const result = await ctx.withWorkspace(workspace, async () => {
    const implementer = ctx.agentSession({
      key: "implementer",
      profile: IMPLEMENTER_PROFILE,
      ...(input.implementerReasoning ? { reasoning: input.implementerReasoning } : {}),
    });
    const reviewer = ctx.agentSession({
      key: "reviewer",
      profile: REVIEWER_PROFILE,
      ...(input.reviewerReasoning ? { reasoning: input.reviewerReasoning } : {}),
      toolPolicy: "read-only",
    });

    const rounds: Round[] = [];
    let findings: Finding[] = [];
    let followUp: CompletionSignal | undefined;

    for (let round = 1; round <= maxRounds; round++) {
      ctx.phase(`Implement ${round}`);
      const followUpForRound = followUp;
      const implementation = await implementer.turn({
        key: round === 1 ? "implement-1" : `fix-${round}`,
        prompt:
          round === 1
            ? initialImplementationPrompt(resolvedInput)
            : followUpForRound
              ? followUpImplementationPrompt(resolvedInput, round, followUpForRound)
              : fixImplementationPrompt(resolvedInput, round, findings),
        schema: ImplementationSchema,
        lenient: true,
      });
      followUp = undefined;

      ctx.log(`implementation.${round}`, implementation);
      if (implementation.status === "blocked") {
        return {
          status: "blocked" as const,
          rounds,
          remainingFindings: findings,
          blockedImplementation: implementation,
        };
      }

      ctx.phase(`Review ${round}`);
      const review = await reviewer.turn({
        key: `review-${round}`,
        prompt: reviewPrompt(
          resolvedInput,
          round,
          implementation,
          findings,
          followUpForRound?.reviewFocus,
        ),
        schema: ReviewSchema,
        lenient: true,
      });

      ctx.log(`review.${round}`, review);
      rounds.push({ round, implementation, review });
      findings = review.findings;
      if (findings.length === 0) {
        if (input.completionMode === "park-before-complete") {
          ctx.phase("Awaiting implementation completion");
          const completion = await ctx.signal<CompletionSignal>(completionSignalName);
          if (completion.action === "continue") {
            followUp = completion;
            findings = [];
            continue;
          }
        }
        return { status: "clean" as const, rounds, remainingFindings: [] };
      }
    }

    return { status: "max-rounds-reached" as const, rounds, remainingFindings: findings };
  });

  return {
    ...result,
    workspace: {
      id: workspace.id,
      ...(workspace.identityHash ? { identityHash: workspace.identityHash } : {}),
      repository,
      ref,
      retention,
    },
  };
}

function followUpImplementationPrompt(
  input: ResolvedInput,
  round: number,
  followUp: CompletionSignal,
): string {
  return `${workspaceInstructions(input)}

Perform a human-requested follow-up implementation round ${round}.

Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${input.verificationCommand ? `Verification command: ${input.verificationCommand}\n` : ""}
Follow-up instructions:
${followUp.instructions ?? "Continue implementation review with another focused pass."}

Modify files only inside the current branch-backed worktree. Keep the change
scoped to the spec and the follow-up instructions. Run focused verification when
practical. Return a concise implementation summary, changed files, verification
performed, and any notes.`;
}

function initialImplementationPrompt(input: ResolvedInput): string {
  return `${workspaceInstructions(input)}

Implement the requested change.

Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${input.verificationCommand ? `Verification command: ${input.verificationCommand}\n` : ""}
Modify files only inside the current branch-backed worktree. Keep the change
scoped to the spec. Run focused verification when practical. Return a concise
implementation summary, changed files, verification performed, and any notes.`;
}

function fixImplementationPrompt(
  input: ResolvedInput,
  round: number,
  findings: Finding[],
): string {
  return `${workspaceInstructions(input)}

Fix reviewer findings for implementation round ${round}.

Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${input.verificationCommand ? `Verification command: ${input.verificationCommand}\n` : ""}
Reviewer findings to address:
${JSON.stringify(findings, null, 2)}

Modify files only inside the current branch-backed worktree. Address findings
you agree with, and explain any finding you do not address in notes. Run focused
verification when practical. Return a concise implementation summary, changed
files, verification performed, and any notes.`;
}

function reviewPrompt(
  input: ResolvedInput,
  round: number,
  implementation: ImplementationResult,
  priorFindings: Finding[],
  followUpReviewFocus: string | undefined,
): string {
  const focus = followUpReviewFocus ?? input.reviewFocus;
  return `${workspaceInstructions(input)}

Review implementation round ${round}.

Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${focus ? `Focus: ${focus}\n` : ""}
${input.completionMode === "park-before-complete" ? "The run may park after a clean review for a human completion or follow-up signal.\n" : ""}
Implementation summary:
${JSON.stringify(implementation, null, 2)}
${priorFindings.length > 0 ? `\nPrior findings that should have been fixed:\n${JSON.stringify(priorFindings, null, 2)}\n` : ""}
Read the relevant files and current diff yourself from the current
branch-backed worktree. The reviewer is read-only and must not edit files.
Report only concrete, actionable remaining or new findings with file and line
numbers. If there are no findings, return an empty findings array.`;
}

function workspaceInstructions(input: ResolvedInput): string {
  return `Keel has created and bound a generated-branch git worktree for this run.
Current working directory: the branch-backed worktree to edit/review.
Source repository: ${input.repository}
Source ref: ${input.ref}
Workspace handle: ${input.workspaceId}
Retention policy: ${input.retention}

Use the current working directory, not the source repository path, for edits,
diffs, git status, commits, and verification. The generated branch name and
worktree path can be discovered with normal git commands from the current
working directory.`;
}

function clampRounds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  if (whole > HARD_MAX_ROUNDS) return HARD_MAX_ROUNDS;
  return whole;
}

function resolveRepository(repository: string | undefined, runTarget: string): string {
  return repository && repository.trim().length > 0 ? repository : runTarget;
}
