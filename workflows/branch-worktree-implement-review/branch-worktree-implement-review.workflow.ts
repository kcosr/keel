import {
  type CompletionCheck,
  type CompletionCheckAttempt,
  type CompletionCheckFailureAction,
  type Ctx,
  type NormalizedCompletionCheck,
  jsonSchema,
} from "@kcosr/keel";
import {
  type CompletionSummary,
  completionFailureFeedback,
  completionInstructions,
  completionOutput,
  resolveCompletionConfig,
  runCompletionAttempt,
} from "../completion-checks";

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
  completionCheckFailureAction?: CompletionCheckFailureAction;
  completionChecks?: CompletionCheck[];
  implementerProfile?: string;
  reviewerProfile?: string;
  implementerReasoning?: string;
  reviewerReasoning?: string;
  reviewFocus?: string;
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

type ResolvedInput = Omit<BranchWorktreeImplementReviewInput, "completionChecks"> & {
  repository: string;
  ref: string;
  retention: WorkspaceRetention;
  workspaceId: string;
  completionChecks: NormalizedCompletionCheck[];
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

const DEFAULT_MAX_ROUNDS = 10;
const HARD_MAX_ROUNDS = 10;
const DEFAULT_COMPLETION_MODE: NonNullable<BranchWorktreeImplementReviewInput["completionMode"]> =
  "park-before-complete";
const IMPLEMENTER_PROFILE = "codex-default";
const REVIEWER_PROFILE = "claude-default";
const DEFAULT_RETENTION: WorkspaceRetention = "retain";
const WORKSPACE_KEY = "implementation";

export default async function branchWorktreeImplementReview(
  ctx: Ctx,
  input: BranchWorktreeImplementReviewInput,
): Promise<{
  status: "clean" | "blocked" | "max-rounds-reached";
  blockedReason?: "implementer-blocked" | "completion-check-failed";
  workspace: {
    id: string;
    identityHash?: string;
    repository: string;
    ref: string;
    retention: WorkspaceRetention;
  };
  rounds: Round[];
  remainingFindings: Finding[];
  blockedImplementation?: ImplementationResult;
  lastCompletionFailureFeedback?: string;
  completion: CompletionSummary;
}> {
  const repository = resolveRepository(input.repository, ctx.run.target);
  const completionConfig = resolveCompletionConfig(input, "worktree");
  const completionMode = input.completionMode ?? DEFAULT_COMPLETION_MODE;
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
    completionMode,
    workspaceId: workspace.id,
    completionChecks: completionConfig.checks,
  };
  const maxRounds = clampRounds(input.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const completionSignalName = input.completionSignalName ?? "implementation-completion";

  const result = await ctx.withWorkspace(workspace, async () => {
    const implementer = ctx.agentSession({
      key: "implementer",
      profile: input.implementerProfile ?? IMPLEMENTER_PROFILE,
      ...(input.implementerReasoning ? { reasoning: input.implementerReasoning } : {}),
    });
    const reviewer = ctx.agentSession({
      key: "reviewer",
      profile: input.reviewerProfile ?? REVIEWER_PROFILE,
      ...(input.reviewerReasoning ? { reasoning: input.reviewerReasoning } : {}),
      toolPolicy: "read-only",
    });

    const rounds: Round[] = [];
    const completionAttempts: CompletionCheckAttempt[] = [];
    let findings: Finding[] = [];
    let followUp: CompletionSignal | undefined;
    let completionAttempt = 0;
    let completionRepairFeedback: string | undefined;
    let lastCompletionFailureFeedback: string | undefined;
    let manualExtraRounds = 0;

    const finish = (result: {
      status: "clean" | "blocked" | "max-rounds-reached";
      blockedReason?: "implementer-blocked" | "completion-check-failed";
      remainingFindings: Finding[];
      blockedImplementation?: ImplementationResult;
    }) => ({
      ...result,
      rounds,
      ...(lastCompletionFailureFeedback ? { lastCompletionFailureFeedback } : {}),
      completion: completionOutput(completionConfig.checks, completionAttempts),
    });

    for (let round = 1; round <= maxRounds + manualExtraRounds; round++) {
      ctx.phase(`Implement ${round}`);
      const followUpForRound = followUp;
      const completionRepairForRound = completionRepairFeedback;
      const implementation = await implementer.turn({
        key: round === 1 ? "implement-1" : `fix-${round}`,
        prompt:
          round === 1
            ? initialImplementationPrompt(resolvedInput)
            : followUpForRound
              ? followUpImplementationPrompt(
                  resolvedInput,
                  round,
                  followUpForRound,
                  completionRepairForRound,
                )
              : completionRepairForRound
                ? completionCheckRepairPrompt(resolvedInput, round, completionRepairForRound)
                : fixImplementationPrompt(resolvedInput, round, findings),
        schema: ImplementationSchema,
        lenient: true,
      });
      followUp = undefined;
      completionRepairFeedback = undefined;

      ctx.log(`implementation.${round}`, implementation);
      if (implementation.status === "blocked") {
        return finish({
          status: "blocked" as const,
          blockedReason: "implementer-blocked",
          remainingFindings: findings,
          blockedImplementation: implementation,
        });
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
        if (completionConfig.checks.length > 0) {
          const trigger = completionMode === "park-before-complete" ? "pre-park" : "auto";
          const attempt = await runCompletionAttempt(
            ctx,
            workspace,
            completionConfig.checks,
            ++completionAttempt,
            trigger,
          );
          completionAttempts.push(attempt);
          if (attempt.status === "failed") {
            lastCompletionFailureFeedback = completionFailureFeedback(attempt);
            if (completionConfig.failureAction === "block") {
              return finish({
                status: "blocked",
                blockedReason: "completion-check-failed",
                remainingFindings: [],
              });
            }
            if (
              completionConfig.failureAction === "continue-loop" &&
              round < maxRounds + manualExtraRounds
            ) {
              completionRepairFeedback = lastCompletionFailureFeedback;
              findings = [];
              continue;
            }
            if (completionMode !== "park-before-complete") {
              return finish({
                status: "blocked",
                blockedReason: "completion-check-failed",
                remainingFindings: [],
              });
            }
          } else if (completionMode !== "park-before-complete") {
            return finish({ status: "clean", remainingFindings: [] });
          }
        } else if (completionMode !== "park-before-complete") {
          return finish({ status: "clean", remainingFindings: [] });
        }

        if (completionMode === "park-before-complete") {
          let parkedFailureFeedback =
            completionAttempts[completionAttempts.length - 1]?.status === "failed"
              ? lastCompletionFailureFeedback
              : undefined;
          while (true) {
            ctx.phase(
              parkedFailureFeedback
                ? "Completion checks failed"
                : "Awaiting implementation completion",
            );
            const completion = await ctx.signal<CompletionSignal>(completionSignalName);
            if (completion.action === "continue") {
              followUp = completion;
              completionRepairFeedback = parkedFailureFeedback;
              if (round >= maxRounds + manualExtraRounds) manualExtraRounds += 1;
              findings = [];
              break;
            }
            if (completionConfig.checks.length === 0) {
              return finish({ status: "clean", remainingFindings: [] });
            }
            const finalAttempt = await runCompletionAttempt(
              ctx,
              workspace,
              completionConfig.checks,
              ++completionAttempt,
              "final",
            );
            completionAttempts.push(finalAttempt);
            if (finalAttempt.status === "passed") {
              return finish({ status: "clean", remainingFindings: [] });
            }
            lastCompletionFailureFeedback = completionFailureFeedback(finalAttempt);
            parkedFailureFeedback = lastCompletionFailureFeedback;
          }
        }
      }
    }

    return finish({ status: "max-rounds-reached" as const, remainingFindings: findings });
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
  completionFailure: string | undefined,
): string {
  return `${workspaceInstructions(input)}

Perform a human-requested follow-up implementation round ${round}.

Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${completionInstructions(input.completionChecks)}${completionFailure ? `Completion-check diagnostics to address:\n${completionFailure}\n\n` : ""}
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
${input.task ? `Task: ${input.task}\n` : ""}${completionInstructions(input.completionChecks)}
Modify files only inside the current branch-backed worktree. Keep the change
scoped to the spec. Run focused verification when practical. Return a concise
implementation summary, changed files, verification performed, and any notes.`;
}

function completionCheckRepairPrompt(
  input: ResolvedInput,
  round: number,
  feedback: string,
): string {
  return `${workspaceInstructions(input)}

Fix completion-check failures for implementation round ${round}.

Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${completionInstructions(input.completionChecks)}
Completion-check diagnostics to address:
${feedback}

Modify files only inside the current branch-backed worktree. Repair the failing
completion gate, then run focused verification when practical. Return a concise
implementation summary, changed files, verification performed, and any notes.`;
}

function fixImplementationPrompt(input: ResolvedInput, round: number, findings: Finding[]): string {
  return `${workspaceInstructions(input)}

Fix reviewer findings for implementation round ${round}.

Spec: ${input.spec}
${input.task ? `Task: ${input.task}\n` : ""}${completionInstructions(input.completionChecks)}
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
