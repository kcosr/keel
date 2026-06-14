// Git-worktree isolation + retained workspace lifecycle (DESIGN.md §11.3).
//
// `target` is the user repository an agent is meant to operate in. Retained
// isolated session workspaces live outside that target in a Keel-owned
// workspace store; one-shot isolated agents still use a temporary worktree that
// is removed after the call.

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const AGENT_DIFF_CONTENT_MAX_BYTES = 512 * 1024;
export const AGENT_DIFF_PATH_MAX_ENTRIES = 1_000;
export const GIT_DIFF_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export const GIT_STATUS_MAX_BUFFER_BYTES = 512 * 1024;
export const AGENT_DIFF_TRUNCATION_NOTICE = `[keel: contentDiff truncated at ${AGENT_DIFF_CONTENT_MAX_BYTES} bytes; inspect the retained workspace or run git diff locally for the full patch]`;

export interface DiffPathCounts {
  modified: number;
  added: number;
  deleted: number;
}

export interface DiffBundle {
  modified: string[];
  added: string[];
  deleted: string[];
  /** Number of changed paths not included after applying AGENT_DIFF_PATH_MAX_ENTRIES. */
  omittedPathCounts: DiffPathCounts;
  /** Maximum total modified/added/deleted paths retained in this bundle. */
  pathLimit: number;
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

function git(
  cwd: string,
  args: string[],
  input?: string,
  options: { maxBuffer?: number } = {},
): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
}

function gitDiff(cwd: string, args: string[]): string {
  return gitBounded(cwd, args, GIT_DIFF_MAX_BUFFER_BYTES, "git diff");
}

function gitStatus(cwd: string, args: string[]): string {
  return gitBounded(cwd, args, GIT_STATUS_MAX_BUFFER_BYTES, "git status");
}

function gitBounded(cwd: string, args: string[], maxBuffer: number, label: string): string {
  try {
    return git(cwd, args, undefined, { maxBuffer });
  } catch (err) {
    if (isMaxBufferError(err)) {
      throw new Error(`${label} output exceeded explicit ${maxBuffer} byte buffer limit`);
    }
    throw err;
  }
}

function isMaxBufferError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const message = err instanceof Error ? err.message : String(err);
  return code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || message.includes("maxBuffer");
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

class DiffContentBuilder {
  private chunks: string[] = [];
  private byteLength = 0;
  truncated = false;

  get value(): string {
    return this.chunks.join("");
  }

  append(chunk: string): void {
    if (this.truncated || chunk.length === 0) return;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (this.byteLength + chunkBytes <= AGENT_DIFF_CONTENT_MAX_BYTES) {
      this.chunks.push(chunk);
      this.byteLength += chunkBytes;
      return;
    }
    this.appendPrefixAndNotice(chunk);
  }

  markTruncated(): void {
    if (this.truncated) return;
    const notice = this.notice();
    const noticeBytes = Buffer.byteLength(notice, "utf8");
    const remaining = AGENT_DIFF_CONTENT_MAX_BYTES - this.byteLength;
    if (remaining >= noticeBytes) {
      this.chunks.push(notice);
      this.byteLength += noticeBytes;
    } else {
      this.trimToByteLength(Math.max(0, AGENT_DIFF_CONTENT_MAX_BYTES - noticeBytes));
      this.chunks.push(notice);
      this.byteLength += noticeBytes;
    }
    this.truncated = true;
  }

  private appendPrefixAndNotice(chunk: string): void {
    const notice = this.notice();
    const noticeBytes = Buffer.byteLength(notice, "utf8");
    if (this.byteLength + noticeBytes > AGENT_DIFF_CONTENT_MAX_BYTES) {
      this.trimToByteLength(Math.max(0, AGENT_DIFF_CONTENT_MAX_BYTES - noticeBytes));
    }
    const prefixBytes = Math.max(0, AGENT_DIFF_CONTENT_MAX_BYTES - this.byteLength - noticeBytes);
    if (prefixBytes > 0) {
      const prefix = utf8Prefix(chunk, prefixBytes);
      this.chunks.push(prefix);
      this.byteLength += Buffer.byteLength(prefix, "utf8");
    }
    this.chunks.push(notice);
    this.byteLength += noticeBytes;
    this.truncated = true;
  }

  private trimToByteLength(targetBytes: number): void {
    const current = this.value;
    const trimmed = utf8Prefix(current, targetBytes);
    this.chunks = trimmed.length > 0 ? [trimmed] : [];
    this.byteLength = Buffer.byteLength(trimmed, "utf8");
  }

  private notice(): string {
    return `\n${AGENT_DIFF_TRUNCATION_NOTICE}\n`;
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  const chars: string[] = [];
  for (const ch of value) {
    const bytes = Buffer.byteLength(ch, "utf8");
    if (used + bytes > maxBytes) break;
    chars.push(ch);
    used += bytes;
  }
  return chars.join("");
}

function readTextFilePrefix(path: string, maxBytes: number): { text: string; truncated: boolean } {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${path} is not a file`);
  const readBytes = Math.min(stat.size, maxBytes + 1);
  const buffer = Buffer.alloc(readBytes);
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, readBytes, 0);
    const keptBytes = Math.min(bytesRead, maxBytes);
    return {
      text: buffer.subarray(0, keptBytes).toString("utf8"),
      truncated: stat.size > maxBytes || bytesRead > maxBytes,
    };
  } finally {
    closeSync(fd);
  }
}

export function diffWorkspace(workspacePath: string): DiffBundle {
  // include untracked files so added files show up
  const status = gitStatus(workspacePath, ["status", "--porcelain", "--untracked-files=all"]);
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const omittedPathCounts: DiffPathCounts = { modified: 0, added: 0, deleted: 0 };
  let retainedPathCount = 0;
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    const bucket =
      code.includes("?") || code.includes("A") ? added : code.includes("D") ? deleted : modified;
    const omittedKey = bucket === added ? "added" : bucket === deleted ? "deleted" : "modified";
    if (retainedPathCount < AGENT_DIFF_PATH_MAX_ENTRIES) {
      bucket.push(file);
      retainedPathCount += 1;
    } else {
      omittedPathCounts[omittedKey] += 1;
    }
  }
  // `git diff --binary HEAD` preserves tracked binary/mode/symlink deltas for
  // review and merge. Add readable untracked file bodies for convenient text
  // review; unreadable/binary untracked files remain represented by path and are
  // preserved by merge after staging. The durable contentDiff is intentionally
  // capped; the retained workspace remains the source of truth for full review.
  const content = new DiffContentBuilder();
  content.append(gitDiff(workspacePath, ["diff", "--binary", "HEAD"]));
  for (const f of added) {
    if (content.truncated) break;
    try {
      const { text, truncated } = readTextFilePrefix(
        join(workspacePath, f),
        AGENT_DIFF_CONTENT_MAX_BYTES,
      );
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      content.append(
        `\ndiff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${lines
          .map((l) => `+${l}`)
          .join("\n")}\n`,
      );
      if (truncated) content.markTruncated();
    } catch {
      // unreadable (binary/directory/etc.) — path remains in `added`; merge uses
      // `git diff --binary --cached` after staging, not this text append.
    }
  }
  return {
    modified,
    added,
    deleted,
    omittedPathCounts,
    pathLimit: AGENT_DIFF_PATH_MAX_ENTRIES,
    contentDiff: content.value,
  };
}

export function mergeWorkspaceIntoTarget(workspacePath: string, target: string): void {
  assertUsableTargetDirectory(target);
  // Stage the retained workspace state so untracked files, binary files, modes,
  // and symlinks enter the binary patch. This mutates only the retained
  // workspace index, not the target.
  git(workspacePath, ["add", "-A"]);
  const patch = gitDiff(workspacePath, ["diff", "--binary", "--cached", "HEAD"]);
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
