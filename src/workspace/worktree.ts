// Git-worktree isolation + retained workspace lifecycle (DESIGN.md §11.3).
//
// `target` is the user repository an agent is meant to operate in. Retained
// isolated session workspaces live outside that target in a Keel-owned
// workspace store; one-shot isolated agents still use a temporary worktree that
// is removed after the call.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface DiffBundle {
  modified: string[];
  added: string[];
  deleted: string[];
  /** Unified/binary-capable diff of tracked changes plus readable untracked text. */
  contentDiff: string;
}

export interface GitTarget {
  target: string;
  repoRoot: string;
  baseCommit: string;
}

export interface Worktree {
  path: string;
  baseCommit: string;
  /** Capture the agent's changes as a reviewable diff bundle. */
  diff(): DiffBundle;
  /** Apply this worktree's changes onto the target. */
  mergeInto(target: string): void;
  /** Remove the worktree. */
  remove(): void;
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
}

function gitErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Validate that `target` is exactly a git repository root and return its HEAD. */
export function resolveGitRootTarget(target: string): GitTarget {
  if (!isAbsolute(target)) {
    throw new Error(`agent target must be an absolute daemon-resolvable path, got ${target}`);
  }
  let repoRoot: string;
  try {
    repoRoot = git(target, ["rev-parse", "--show-toplevel"]).trim();
  } catch (err) {
    throw new Error(`target ${target} is not a git repository root: ${gitErrorMessage(err)}`);
  }
  const targetReal = canonicalPath(target);
  const repoReal = canonicalPath(repoRoot);
  if (targetReal !== repoReal) {
    throw new Error(
      `isolated agent target ${target} is inside git repository ${repoRoot}; pass the repository root as --target or set the agent target to ${repoRoot}`,
    );
  }
  const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  return { target, repoRoot, baseCommit };
}

export function assertUsableTargetDirectory(target: string): void {
  if (!isAbsolute(target)) {
    throw new Error(`agent target must be an absolute daemon-resolvable path, got ${target}`);
  }
  try {
    const real = realpathSync(target);
    if (!existsSync(real)) throw new Error("missing");
  } catch (err) {
    throw new Error(`agent target ${target} is not an existing directory: ${gitErrorMessage(err)}`);
  }
}

export function retainedWorkspacePath(
  workspaceStore: string,
  runId: string,
  agentKey: string,
): string {
  return join(workspaceStore, safeSegment(runId), safeSegment(agentKey));
}

export function createRetainedWorktree(
  repoRoot: string,
  workspacePath: string,
  baseCommit: string,
): void {
  mkdirSync(dirname(workspacePath), { recursive: true });
  git(repoRoot, ["worktree", "add", "--detach", workspacePath, baseCommit]);
}

/** Create a temporary isolated worktree of `repoRoot` at its current HEAD. */
export function createWorktree(repoRoot: string, label: string): Worktree {
  const { baseCommit } = resolveGitRootTarget(repoRoot);
  const dir = mkdtempSync(join(tmpdir(), `keel-wt-${safeSegment(label)}-`));
  git(repoRoot, ["worktree", "add", "--detach", dir, baseCommit]);
  return worktreeHandle(repoRoot, dir, baseCommit, true);
}

export function openRetainedWorktree(
  repoRoot: string,
  workspacePath: string,
  baseCommit: string,
): Worktree {
  return worktreeHandle(repoRoot, workspacePath, baseCommit, false);
}

export function removeRetainedWorkspace(
  repoRoot: string,
  workspacePath: string,
  baseCommit: string,
): void {
  try {
    openRetainedWorktree(repoRoot, workspacePath, baseCommit).remove();
  } catch {
    rmSync(workspacePath, { recursive: true, force: true });
  }
}

export function diffWorkspace(workspacePath: string): DiffBundle {
  // include untracked files so added files show up
  const status = git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]);
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code.includes("?") || code.includes("A")) added.push(file);
    else if (code.includes("D")) deleted.push(file);
    else modified.push(file);
  }
  // `git diff --binary HEAD` preserves tracked binary/mode/symlink deltas for
  // review and merge. Add readable untracked file bodies for convenient text
  // review; unreadable/binary untracked files remain represented by path and are
  // preserved by merge after staging.
  let contentDiff = git(workspacePath, ["diff", "--binary", "HEAD"]);
  for (const f of added) {
    try {
      const body = readFileSync(join(workspacePath, f), "utf8");
      const lines = body.split("\n");
      if (lines.at(-1) === "") lines.pop();
      contentDiff += `\ndiff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${lines
        .map((l) => `+${l}`)
        .join("\n")}\n`;
    } catch {
      // unreadable (binary/directory/etc.) — path remains in `added`; merge uses
      // `git diff --binary --cached` after staging, not this text append.
    }
  }
  return { modified, added, deleted, contentDiff };
}

export function mergeWorkspaceIntoTarget(workspacePath: string, target: string): void {
  assertUsableTargetDirectory(target);
  // Stage the retained workspace state so untracked files, binary files, modes,
  // and symlinks enter the binary patch. This mutates only the retained
  // workspace index, not the target.
  git(workspacePath, ["add", "-A"]);
  const patch = git(workspacePath, ["diff", "--binary", "--cached", "HEAD"]);
  if (!patch.trim()) return;
  try {
    git(target, ["apply", "--check", "--3way", "--whitespace=nowarn", "-"], patch);
  } catch (err) {
    throw new Error(
      `workspace merge would conflict; target was not modified: ${gitErrorMessage(err)}`,
    );
  }
  git(target, ["apply", "--3way", "--whitespace=nowarn", "-"], patch);
}

function worktreeHandle(
  repoRoot: string,
  path: string,
  baseCommit: string,
  removable: boolean,
): Worktree {
  return {
    path,
    baseCommit,
    diff: () => diffWorkspace(path),
    mergeInto: (target: string) => mergeWorkspaceIntoTarget(path, target),
    remove(): void {
      if (!removable) {
        try {
          git(repoRoot, ["worktree", "remove", "--force", path]);
        } catch {
          rmSync(path, { recursive: true, force: true });
        }
        return;
      }
      try {
        git(repoRoot, ["worktree", "remove", "--force", path]);
      } catch {
        rmSync(path, { recursive: true, force: true });
      }
    },
  };
}

function safeSegment(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "_";
}
