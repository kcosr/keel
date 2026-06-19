import {
  type CommandResult,
  type CompletionCheck,
  type CompletionCheckAttempt,
  type CompletionCheckResult,
  type Ctx,
  completionCheckStableKey,
  normalizeCompletionChecks,
} from "@kcosr/keel";

export type CommandCompletionFixtureInput = {
  workspace: string;
  completionChecks?: CompletionCheck[];
};

export type CommandCompletionFixtureOutput = {
  command: Pick<CommandResult, "key" | "status" | "exitCode" | "attempt"> & {
    stdout: string;
    stderr: string;
  };
  completion: CompletionCheckAttempt;
};

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_OUTPUT_BYTES = 16 * 1024;

const DEFAULT_COMPLETION_CHECKS: CompletionCheck[] = [
  {
    key: "workspace-readable",
    type: "command",
    command: "/bin/sh",
    args: ["-c", "test -d . && test -r . && printf readable"],
  },
];

export default async function commandCompletionFixture(
  ctx: Ctx,
  input: CommandCompletionFixtureInput,
): Promise<CommandCompletionFixtureOutput> {
  const workspace = await ctx.workspace({
    key: "fixture-workspace",
    mode: "direct",
    path: input.workspace,
  });

  const command = await ctx.command({
    key: "list-workspace",
    workspace,
    cwd: ".",
    mode: "argv",
    argv: ["/bin/sh", "-c", 'printf "workspace=%s\\n" "$PWD"; ls -1 . | head -20'],
    capabilities: { fs: "workspace-write", shell: true, network: "none" },
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxStdoutBytes: COMMAND_OUTPUT_BYTES,
    maxStderrBytes: COMMAND_OUTPUT_BYTES,
    failureMode: "return",
  });

  const checks = normalizeCompletionChecks(input.completionChecks ?? DEFAULT_COMPLETION_CHECKS, {
    workspaceMode: "direct",
  });
  const startedAtMs = ctx.now();
  const results: CompletionCheckResult[] = [];
  let failed = false;
  for (const check of checks) {
    const result = await ctx.completionCheck({
      key: completionCheckStableKey(1, check.key),
      workspace,
      attempt: 1,
      trigger: "auto",
      check,
      markFailureSeenOnFailure: true,
    });
    results.push(result);
    failed ||= result.status !== "passed";
  }
  const finishedAtMs = ctx.now();

  return {
    command: {
      key: command.key,
      status: command.status,
      exitCode: command.exitCode,
      attempt: command.attempt,
      stdout: command.stdout.text,
      stderr: command.stderr.text,
    },
    completion: {
      attempt: 1,
      trigger: "auto",
      status: failed ? "failed" : "passed",
      workspaceId: workspace.id,
      ...(workspace.identityHash ? { workspaceIdentityHash: workspace.identityHash } : {}),
      startedAtMs,
      finishedAtMs,
      checks: results,
    },
  };
}
