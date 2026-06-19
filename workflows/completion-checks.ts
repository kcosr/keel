import {
  type CompletionCheck,
  type CompletionCheckAttempt,
  type CompletionCheckFailureAction,
  type CompletionCheckResult,
  type CompletionCheckTrigger,
  type Ctx,
  type NormalizedCompletionCheck,
  type WorkspaceHandle,
  completionCheckPromptSummary,
  completionCheckStableKey,
  normalizeCompletionCheckFailureAction,
  normalizeCompletionChecks,
} from "@kcosr/keel";

export type CompletionMode = "auto" | "park-before-complete";

export type CompletionInput = {
  completionMode?: CompletionMode;
  completionCheckFailureAction?: CompletionCheckFailureAction;
  completionChecks?: CompletionCheck[];
};

export type CompletionConfig = {
  checks: NormalizedCompletionCheck[];
  failureAction: CompletionCheckFailureAction;
};

export type CompletionSummary = {
  checksConfigured: number;
  attempts: CompletionCheckAttempt[];
  latestAttempt?: CompletionCheckAttempt;
};

const COMPLETION_FEEDBACK_DIAGNOSTICS_CHARS = 12_000;

export function resolveCompletionConfig(
  input: CompletionInput,
  workspaceMode: "direct" | "worktree",
): CompletionConfig {
  return {
    checks: normalizeCompletionChecks(input.completionChecks, {
      path: "completionChecks",
      workspaceMode,
    }),
    failureAction: normalizeCompletionCheckFailureAction(
      input.completionCheckFailureAction,
      input.completionMode,
    ),
  };
}

export function completionInstructions(checks: readonly NormalizedCompletionCheck[]): string {
  return completionCheckPromptSummary(checks);
}

export async function runCompletionAttempt(
  ctx: Ctx,
  workspace: WorkspaceHandle,
  checks: readonly NormalizedCompletionCheck[],
  attempt: number,
  trigger: CompletionCheckTrigger,
): Promise<CompletionCheckAttempt> {
  const startedAtMs = ctx.now();
  const results: CompletionCheckResult[] = [];
  let failed = false;
  for (let i = 0; i < checks.length; i += 1) {
    const check = checks[i] as NormalizedCompletionCheck;
    if (failed) {
      results.push({
        key: check.key,
        type: check.type,
        status: "not-run",
        summary: "not run because an earlier completion check failed",
      });
      continue;
    }
    const result = await ctx.completionCheck({
      key: completionCheckStableKey(attempt, check.key),
      workspace,
      attempt,
      trigger,
      check,
      markFailureSeenOnFailure: true,
    });
    results.push(result);
    failed = result.status !== "passed";
  }
  const finishedAtMs = ctx.now();
  return {
    attempt,
    trigger,
    status: failed ? "failed" : "passed",
    workspaceId: workspace.id,
    ...(workspace.identityHash ? { workspaceIdentityHash: workspace.identityHash } : {}),
    startedAtMs,
    finishedAtMs,
    checks: results,
  };
}

export function completionOutput(
  checks: readonly NormalizedCompletionCheck[],
  attempts: readonly CompletionCheckAttempt[],
): CompletionSummary {
  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
  return {
    checksConfigured: checks.length,
    attempts: [...attempts],
    ...(latestAttempt ? { latestAttempt } : {}),
  };
}

export function completionFailureFeedback(attempt: CompletionCheckAttempt): string {
  const lines = [
    `Completion checks failed on attempt ${attempt.attempt} (${attempt.trigger}).`,
    `Workspace: ${attempt.workspaceId}`,
  ];
  for (const check of attempt.checks) {
    const status = check.failureKind ? `${check.status} ${check.failureKind}` : check.status;
    lines.push(`- ${check.key} ${check.type}: ${status}. ${check.summary}`);
    if (check.diagnostics !== undefined && check.status === "failed") {
      lines.push(`  diagnostics: ${truncateDiagnostics(check.diagnostics)}`);
    }
  }
  return lines.join("\n");
}

function truncateDiagnostics(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= COMPLETION_FEEDBACK_DIAGNOSTICS_CHARS) return text;
  return `${text.slice(0, COMPLETION_FEEDBACK_DIAGNOSTICS_CHARS)}\n... diagnostics truncated`;
}
