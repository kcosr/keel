import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Json } from "../hash.ts";
import type { JournalStore } from "../journal/store.ts";
import type { AgentWorkspaceRow } from "../journal/types.ts";
import {
  type CommandResult,
  type NormalizedWorkflowCommandSpec,
  WORKFLOW_COMMAND_SHELL_EXECUTABLE,
  withCommandFailure,
} from "./command.ts";
import {
  COMPLETION_CHECK_COMMIT_LIMIT,
  COMPLETION_CHECK_PATH_LIMIT,
  COMPLETION_COMMAND_BASE_ENV_ALLOWLIST,
  type CompletionCheckFailureKind,
  type CompletionCheckResult,
  GIT_COMPLETION_OUTPUT_BYTES,
  GIT_COMPLETION_TIMEOUT_MS,
  type NormalizedBranchPushedCompletionCheck,
  type NormalizedCommandCompletionCheck,
  type NormalizedCompletionCheck,
  type NormalizedCompletionCheckEffectSpec,
  type NormalizedHasCommitsCompletionCheck,
  outputTextSummary,
} from "./completion-check.ts";
import { runBoundedProcess } from "./process-runner.ts";

export interface CompletionCheckRunOptions {
  store: JournalStore;
  runId: string;
  spec: NormalizedCompletionCheckEffectSpec;
  startedAtMs: number;
  clock: () => number;
  signal?: AbortSignal;
}

interface WorkspaceResolution {
  row: AgentWorkspaceRow;
  workspacePath: string;
}

interface GitResult {
  result: CommandResult;
  ok: boolean;
}

export async function runCompletionCheck(
  opts: CompletionCheckRunOptions,
): Promise<CompletionCheckResult> {
  const workspace = resolveCompletionWorkspace(opts);
  if ("failure" in workspace) return workspace.failure;
  try {
    if (opts.spec.check.type === "command") {
      return await runCommandCheck(opts, workspace, opts.spec.check);
    }
    const gitReady = await requireGitWorkTree(opts, workspace, opts.spec.check);
    if (gitReady) return gitReady;
    if (opts.spec.check.type === "git-clean") return await runGitCleanCheck(opts, workspace);
    if (opts.spec.check.type === "has-commits") {
      return await runHasCommitsCheck(opts, workspace, opts.spec.check);
    }
    return await runBranchPushedCheck(opts, workspace, opts.spec.check);
  } finally {
    releaseCompletionWorkspace(opts, workspace.row);
  }
}

function resolveCompletionWorkspace(
  opts: CompletionCheckRunOptions,
): WorkspaceResolution | { failure: CompletionCheckResult } {
  const { spec, store, runId, startedAtMs } = opts;
  const row = store.getAgentWorkspace(runId, spec.workspaceId);
  if (!row) {
    return {
      failure: failedRuntime(spec.check, opts, "workspace-unsupported", "workspace is missing", {
        workspaceId: spec.workspaceId,
      }),
    };
  }
  if (
    spec.workspaceIdentityHash !== null &&
    row.workspaceIdentityHash !== spec.workspaceIdentityHash
  ) {
    return {
      failure: failedRuntime(spec.check, opts, "invalid-check", "workspace identity changed", {
        workspaceId: row.workspaceId,
        expectedIdentityHash: spec.workspaceIdentityHash,
        actualIdentityHash: row.workspaceIdentityHash,
      }),
    };
  }
  if (row.activeHolderKind !== null) {
    return {
      failure: failedRuntime(
        spec.check,
        opts,
        "workspace-unsupported",
        "workspace is active elsewhere",
        {
          workspaceId: row.workspaceId,
          activeHolderKind: row.activeHolderKind,
          activeHolderKey: row.activeHolderKey,
          activeHolderAttempt: row.activeHolderAttempt,
        },
      ),
    };
  }
  if (row.status !== "idle" && row.status !== "diff_error") {
    return {
      failure: failedRuntime(
        spec.check,
        opts,
        "workspace-unsupported",
        `workspace is ${row.status}`,
        { workspaceId: row.workspaceId, status: row.status },
      ),
    };
  }
  if (!existsSync(row.workspacePath) || !statSync(row.workspacePath).isDirectory()) {
    if (row.owned) {
      store.updateAgentWorkspace(runId, row.workspaceId, {
        status: "abandoned",
        failureSeen: true,
        updatedAtMs: opts.clock(),
      });
    }
    return {
      failure: failedRuntime(
        spec.check,
        opts,
        "workspace-unsupported",
        "workspace path is missing",
        { workspaceId: row.workspaceId, workspacePath: row.workspacePath },
      ),
    };
  }
  const workspacePath = realpathSync(row.workspacePath);
  store.updateAgentWorkspace(runId, row.workspaceId, {
    status: "active",
    activeHolderKind: "command",
    activeHolderKey: spec.stableKey,
    activeHolderAttempt: spec.attempt,
    activeStartedAtMs: startedAtMs,
    updatedAtMs: startedAtMs,
  });
  return { row, workspacePath };
}

function releaseCompletionWorkspace(opts: CompletionCheckRunOptions, row: AgentWorkspaceRow): void {
  const current = opts.store.getAgentWorkspace(opts.runId, row.workspaceId);
  if (!current) return;
  if (
    current.activeHolderKind &&
    (current.activeHolderKind !== "command" ||
      current.activeHolderKey !== opts.spec.stableKey ||
      current.activeHolderAttempt !== opts.spec.attempt)
  ) {
    throw new Error(
      `workspace "${row.workspaceId}" active holder changed while completion check was running`,
    );
  }
  const workspaceExists =
    existsSync(current.workspacePath) && statSync(current.workspacePath).isDirectory();
  opts.store.updateAgentWorkspace(opts.runId, row.workspaceId, {
    status: workspaceExists || !current.owned ? "idle" : "abandoned",
    ...(workspaceExists || !current.owned ? {} : { failureSeen: true }),
    activeHolderKind: null,
    activeHolderKey: null,
    activeHolderAttempt: null,
    activeStartedAtMs: null,
    updatedAtMs: opts.clock(),
  });
}

async function runCommandCheck(
  opts: CompletionCheckRunOptions,
  workspace: WorkspaceResolution,
  check: NormalizedCommandCompletionCheck,
): Promise<CompletionCheckResult> {
  const cwd = resolveCheckCwd(workspace.workspacePath, check.cwd);
  if ("failureKind" in cwd) {
    return failedRuntime(check, opts, cwd.failureKind, cwd.summary, cwd.diagnostics);
  }
  const command = internalCommandSpec({
    key: check.key,
    workspaceId: opts.spec.workspaceId,
    workspaceIdentityHash: opts.spec.workspaceIdentityHash,
    cwd: check.cwd,
    invocation: check.shell
      ? { mode: "shell", shell: check.command, shellExecutable: WORKFLOW_COMMAND_SHELL_EXECUTABLE }
      : { mode: "argv", argv: [check.command, ...check.args] },
    timeoutMs: check.timeoutMs,
    maxStdoutBytes: check.maxStdoutBytes,
    maxStderrBytes: check.maxStderrBytes,
  });
  const result = await runBoundedProcess({
    command,
    attempt: opts.spec.attempt,
    cwd: cwd.resolvedCwd,
    env: buildCompletionEnvironment(check.env),
    signal: opts.signal,
  });
  const failureKind = commandFailureKind(result);
  const invocation: Json =
    command.invocation.mode === "argv"
      ? { mode: "argv", argv: command.invocation.argv }
      : { mode: "shell", shell: command.invocation.shell };
  const diagnostics: Json = {
    workspaceId: opts.spec.workspaceId,
    cwd: check.cwd,
    invocation,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: outputTextSummary(result.stdout),
    stderr: outputTextSummary(result.stderr),
    ...(result.error ? { error: result.error.message } : {}),
  };
  if (!failureKind) {
    return {
      key: check.key,
      type: check.type,
      status: "passed",
      durationMs: result.durationMs,
      summary: "command exited with code 0",
      diagnostics,
    };
  }
  if (opts.spec.markFailureSeenOnFailure) markFailureSeen(opts);
  return {
    key: check.key,
    type: check.type,
    status: "failed",
    durationMs: result.durationMs,
    summary: result.error?.message ?? "command failed",
    failureKind,
    diagnostics,
  };
}

async function requireGitWorkTree(
  opts: CompletionCheckRunOptions,
  workspace: WorkspaceResolution,
  check: NormalizedCompletionCheck,
): Promise<CompletionCheckResult | null> {
  const git = await runGit(opts, workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (git.ok && git.result.stdout.text.trim() === "true") return null;
  return failedRuntime(check, opts, "workspace-unsupported", "workspace is not a git work tree", {
    workspaceId: workspace.row.workspaceId,
    git: gitDiagnostics(git.result),
  });
}

async function runGitCleanCheck(
  opts: CompletionCheckRunOptions,
  workspace: WorkspaceResolution,
): Promise<CompletionCheckResult> {
  const check = opts.spec.check;
  const git = await runGit(opts, workspace, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (!git.ok) {
    return failedRuntime(check, opts, "git-error", "git status failed", {
      git: gitDiagnostics(git.result),
    });
  }
  const entries = parsePorcelainStatus(git.result.stdout.text);
  if (entries.length === 0) {
    return passedRuntime(check, opts, "worktree is clean", {
      command: "git status --porcelain=v1 -z --untracked-files=all",
    });
  }
  const capped = entries.slice(0, COMPLETION_CHECK_PATH_LIMIT);
  return failedRuntime(check, opts, "dirty-worktree", `${entries.length} git status entries`, {
    entries: capped,
    omitted: Math.max(0, entries.length - capped.length),
  });
}

async function runHasCommitsCheck(
  opts: CompletionCheckRunOptions,
  workspace: WorkspaceResolution,
  check: NormalizedHasCommitsCompletionCheck,
): Promise<CompletionCheckResult> {
  const head = await gitSingleLine(opts, workspace, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return failedRuntime(check, opts, "git-error", "failed to resolve HEAD", {
      git: gitDiagnostics(head.result),
    });
  }

  let base: string;
  let mergeBase: string | null = null;
  if (workspace.row.mode === "direct") {
    if (!check.baseRef) {
      return failedRuntime(check, opts, "invalid-check", "direct has-commits requires baseRef", {
        workspaceId: workspace.row.workspaceId,
      });
    }
    const baseRef = await gitSingleLine(opts, workspace, [
      "rev-parse",
      "--verify",
      `${check.baseRef}^{commit}`,
    ]);
    if (!baseRef.ok) {
      return failedRuntime(check, opts, "git-error", "failed to resolve baseRef", {
        baseRef: check.baseRef,
        git: gitDiagnostics(baseRef.result),
      });
    }
    const mb = await gitSingleLine(opts, workspace, ["merge-base", baseRef.value, "HEAD"]);
    if (!mb.ok) {
      return failedRuntime(
        check,
        opts,
        "base-not-ancestor",
        "baseRef has no merge base with HEAD",
        {
          baseRef: check.baseRef,
          baseCommit: baseRef.value,
          headCommit: head.value,
          git: gitDiagnostics(mb.result),
        },
      );
    }
    base = mb.value;
    mergeBase = mb.value;
  } else {
    if (check.baseRef) {
      return failedRuntime(
        check,
        opts,
        "invalid-check",
        "baseRef is only supported for direct workspaces",
        { workspaceId: workspace.row.workspaceId, mode: workspace.row.mode },
      );
    }
    if (!workspace.row.baseCommit) {
      return failedRuntime(check, opts, "invalid-check", "workspace is missing baseCommit", {
        workspaceId: workspace.row.workspaceId,
        mode: workspace.row.mode,
      });
    }
    base = workspace.row.baseCommit;
    const ancestor = await runGit(opts, workspace, ["merge-base", "--is-ancestor", base, "HEAD"]);
    if (!ancestor.ok) {
      return failedRuntime(
        check,
        opts,
        "base-not-ancestor",
        "base commit is not an ancestor of HEAD",
        {
          baseCommit: base,
          headCommit: head.value,
          git: gitDiagnostics(ancestor.result),
        },
      );
    }
  }

  const count = await gitSingleLine(opts, workspace, ["rev-list", "--count", `${base}..HEAD`]);
  if (!count.ok) {
    return failedRuntime(check, opts, "git-error", "failed to count commits", {
      baseCommit: base,
      headCommit: head.value,
      git: gitDiagnostics(count.result),
    });
  }
  const commitCount = Number.parseInt(count.value, 10);
  const commits = await gitLines(opts, workspace, [
    "rev-list",
    `--max-count=${COMPLETION_CHECK_COMMIT_LIMIT}`,
    "--abbrev-commit",
    `${base}..HEAD`,
  ]);
  const diagnostics = {
    ...(check.baseRef ? { baseRef: check.baseRef } : {}),
    baseCommit: base,
    ...(mergeBase ? { mergeBase } : {}),
    headCommit: head.value,
    commitCount,
    commits: commits.ok ? commits.value : [],
  } satisfies Json;
  if (commitCount >= check.minCount) {
    return passedRuntime(check, opts, `${commitCount} commits after base`, diagnostics);
  }
  return failedRuntime(
    check,
    opts,
    "no-commits",
    `requires ${check.minCount} commits after base; found ${commitCount}`,
    diagnostics,
  );
}

async function runBranchPushedCheck(
  opts: CompletionCheckRunOptions,
  workspace: WorkspaceResolution,
  check: NormalizedBranchPushedCompletionCheck,
): Promise<CompletionCheckResult> {
  const branch = await resolveLocalBranch(opts, workspace, check);
  if ("failure" in branch) return branch.failure;
  const head = await gitSingleLine(opts, workspace, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return failedRuntime(check, opts, "git-error", "failed to resolve HEAD", {
      localBranch: branch.localBranch,
      git: gitDiagnostics(head.result),
    });
  }
  const remoteRef = check.remoteRef ?? `refs/heads/${branch.localBranch}`;
  const remote = await runGit(opts, workspace, ["ls-remote", check.remote, remoteRef], {
    network: true,
  });
  if (!remote.ok) {
    return failedRuntime(check, opts, "git-error", "failed to query remote ref", {
      localBranch: branch.localBranch,
      localHead: head.value,
      remote: check.remote,
      remoteRef,
      git: gitDiagnostics(remote.result),
    });
  }
  const remoteHead = parseLsRemoteHead(remote.result.stdout.text, remoteRef);
  const diagnostics = {
    localBranch: branch.localBranch,
    localHead: head.value,
    remote: check.remote,
    remoteRef,
    remoteHead,
  } satisfies Json;
  if (remoteHead && remoteHead === head.value) {
    return passedRuntime(check, opts, "remote ref equals local HEAD", diagnostics);
  }
  return failedRuntime(
    check,
    opts,
    "branch-not-pushed",
    "remote ref does not equal local HEAD",
    diagnostics,
  );
}

async function resolveLocalBranch(
  opts: CompletionCheckRunOptions,
  workspace: WorkspaceResolution,
  check: NormalizedBranchPushedCompletionCheck,
): Promise<{ localBranch: string } | { failure: CompletionCheckResult }> {
  const symbolic = await gitSingleLine(opts, workspace, ["symbolic-ref", "--short", "HEAD"]);
  const currentBranch = symbolic.ok ? symbolic.value : null;
  if (workspace.row.mode === "worktree" && workspace.row.owned) {
    if (workspace.row.worktreeCheckoutKind !== "branch") {
      return {
        failure: failedRuntime(check, opts, "workspace-unsupported", "worktree is detached", {
          workspaceId: workspace.row.workspaceId,
          checkoutKind: workspace.row.worktreeCheckoutKind,
        }),
      };
    }
    if (!workspace.row.checkoutBranch) {
      return {
        failure: failedRuntime(
          check,
          opts,
          "invalid-check",
          "workspace is missing checkoutBranch",
          {
            workspaceId: workspace.row.workspaceId,
          },
        ),
      };
    }
    if (currentBranch !== workspace.row.checkoutBranch) {
      return {
        failure: failedRuntime(
          check,
          opts,
          "branch-mismatch",
          "current branch differs from persisted branch",
          {
            expectedBranch: workspace.row.checkoutBranch,
            currentBranch: currentBranch ?? null,
            ...(symbolic.ok ? {} : { git: gitDiagnostics(symbolic.result) }),
          },
        ),
      };
    }
    return { localBranch: workspace.row.checkoutBranch };
  }
  if (!currentBranch) {
    return {
      failure: failedRuntime(check, opts, "branch-mismatch", "workspace HEAD is detached", {
        git: gitDiagnostics(symbolic.result),
      }),
    };
  }
  return { localBranch: currentBranch };
}

function resolveCheckCwd(
  workspacePath: string,
  cwd: string,
):
  | { resolvedCwd: string }
  | { failureKind: CompletionCheckFailureKind; summary: string; diagnostics: Json } {
  try {
    const candidate = cwd === "." ? workspacePath : resolve(workspacePath, cwd);
    const resolvedCwd = realpathSync(candidate);
    if (!statSync(resolvedCwd).isDirectory()) {
      return {
        failureKind: "invalid-check",
        summary: "command cwd is not a directory",
        diagnostics: { cwd },
      };
    }
    const rel = relative(workspacePath, resolvedCwd);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return {
        failureKind: "invalid-check",
        summary: "command cwd escapes workspace",
        diagnostics: { cwd },
      };
    }
    return { resolvedCwd };
  } catch (err) {
    return {
      failureKind: "invalid-check",
      summary: "command cwd could not be resolved",
      diagnostics: { cwd, error: errorMessage(err) },
    };
  }
}

async function runGit(
  opts: CompletionCheckRunOptions,
  workspace: WorkspaceResolution,
  args: string[],
  extra: { network?: boolean } = {},
): Promise<GitResult> {
  const command = internalCommandSpec({
    key: `${opts.spec.check.key}-git`,
    workspaceId: opts.spec.workspaceId,
    workspaceIdentityHash: opts.spec.workspaceIdentityHash,
    cwd: ".",
    invocation: { mode: "argv", argv: ["git", ...args] },
    timeoutMs: GIT_COMPLETION_TIMEOUT_MS,
    maxStdoutBytes: GIT_COMPLETION_OUTPUT_BYTES,
    maxStderrBytes: GIT_COMPLETION_OUTPUT_BYTES,
    network: extra.network === true,
  });
  const result = await runBoundedProcess({
    command,
    attempt: opts.spec.attempt,
    cwd: workspace.workspacePath,
    env: buildCompletionEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
    signal: opts.signal,
  });
  return { result, ok: result.error === undefined };
}

async function gitSingleLine(
  opts: CompletionCheckRunOptions,
  workspace: WorkspaceResolution,
  args: string[],
): Promise<
  { ok: true; value: string; result: CommandResult } | { ok: false; result: CommandResult }
> {
  const git = await runGit(opts, workspace, args);
  if (!git.ok) return { ok: false, result: git.result };
  return { ok: true, value: git.result.stdout.text.trim(), result: git.result };
}

async function gitLines(
  opts: CompletionCheckRunOptions,
  workspace: WorkspaceResolution,
  args: string[],
): Promise<
  { ok: true; value: string[]; result: CommandResult } | { ok: false; result: CommandResult }
> {
  const git = await runGit(opts, workspace, args);
  if (!git.ok) return { ok: false, result: git.result };
  return {
    ok: true,
    value: git.result.stdout.text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    result: git.result,
  };
}

function internalCommandSpec(opts: {
  key: string;
  workspaceId: string;
  workspaceIdentityHash: string | null;
  cwd: string;
  invocation: NormalizedWorkflowCommandSpec["invocation"];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  network?: boolean;
}): NormalizedWorkflowCommandSpec {
  const command: NormalizedWorkflowCommandSpec = {
    key: opts.key,
    stableKey: `completion-check-internal.${opts.key}`,
    workspaceId: opts.workspaceId,
    workspaceIdentityHash: opts.workspaceIdentityHash,
    setupIdentityHash: null,
    cwd: opts.cwd,
    invocation: opts.invocation,
    capabilities: {
      fs: "workspace-write",
      shell: true,
      network: opts.network ? ["*"] : "none",
      secrets: [],
    },
    environment: {
      vars: {},
      secrets: [],
    },
    timeoutMs: opts.timeoutMs,
    stallTimeoutMs: null,
    maxStdoutBytes: opts.maxStdoutBytes,
    maxStderrBytes: opts.maxStderrBytes,
    successExitCodes: [0],
    failureMode: "return",
    identity: {},
    bump: null,
  };
  return command;
}

function buildCompletionEnvironment(vars: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of COMPLETION_COMMAND_BASE_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(vars)) env[name] = value;
  return env;
}

function commandFailureKind(result: CommandResult): CompletionCheckFailureKind | null {
  if (!result.error) return null;
  if (result.error.kind === "nonzero-exit") return "nonzero-exit";
  if (result.error.kind === "timeout" || result.error.kind === "stall") return "timeout";
  return "spawn-error";
}

function passedRuntime(
  check: NormalizedCompletionCheck,
  opts: CompletionCheckRunOptions,
  summary: string,
  diagnostics?: Json,
): CompletionCheckResult {
  return {
    key: check.key,
    type: check.type,
    status: "passed",
    durationMs: Math.max(0, opts.clock() - opts.startedAtMs),
    summary,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
}

function failedRuntime(
  check: NormalizedCompletionCheck,
  opts: CompletionCheckRunOptions,
  failureKind: CompletionCheckFailureKind,
  summary: string,
  diagnostics: Json,
): CompletionCheckResult {
  if (opts.spec.markFailureSeenOnFailure) markFailureSeen(opts);
  return {
    key: check.key,
    type: check.type,
    status: "failed",
    durationMs: Math.max(0, opts.clock() - opts.startedAtMs),
    summary,
    failureKind,
    diagnostics,
  };
}

function markFailureSeen(opts: CompletionCheckRunOptions): void {
  const row = opts.store.getAgentWorkspace(opts.runId, opts.spec.workspaceId);
  if (!row?.owned) return;
  opts.store.updateAgentWorkspace(opts.runId, opts.spec.workspaceId, {
    failureSeen: true,
    updatedAtMs: opts.clock(),
  });
}

function parsePorcelainStatus(
  output: string,
): Array<{ status: string; path: string; oldPath?: string }> {
  const parts = output.split("\0").filter((part) => part.length > 0);
  const entries: Array<{ status: string; path: string; oldPath?: string }> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const item = parts[i] ?? "";
    const status = item.slice(0, 2);
    const path = item.slice(3);
    if (status[0] === "R" || status[0] === "C") {
      const oldPath = parts[i + 1];
      if (oldPath !== undefined) i += 1;
      entries.push({ status, path, ...(oldPath ? { oldPath } : {}) });
    } else {
      entries.push({ status, path });
    }
  }
  return entries;
}

function parseLsRemoteHead(output: string, remoteRef: string): string | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/, 2);
    if (ref === remoteRef && sha) return sha;
  }
  return null;
}

function gitDiagnostics(result: CommandResult): Json {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: outputTextSummary(result.stdout),
    stderr: outputTextSummary(result.stderr),
    ...(result.error ? { error: result.error.message } : {}),
  } satisfies Json;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
