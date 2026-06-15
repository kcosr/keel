// Git-worktree isolation + retained workspace lifecycle (DESIGN.md §11.3).
//
// `target` is the user repository an agent is meant to operate in. Retained
// isolated agent and session workspaces live outside that target in a Keel-owned
// workspace store. Terminal cleanup is governed by the persisted workspace
// retention policy, not by per-call temporary directory cleanup.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  mode?: "worktree" | "copy" | "clone";
  diffKind?: "git-patch" | "recursive-copy";
  baseLabel?: string;
  workspaceLabel?: string;
  fileChanges?: FileChange[];
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "type_changed";
  oldMode?: string | null;
  newMode?: string | null;
  oldSymlinkTarget?: string | null;
  newSymlinkTarget?: string | null;
  binary?: boolean;
  textDiffIncluded?: boolean;
}

export interface GitTarget {
  /** Resolved source repository root. Kept as target for legacy call sites. */
  target: string;
  repoRoot: string;
  baseCommit: string;
}

export interface CloneSource {
  repo: string;
  sourceKind: "local-clone-git" | "remote-git";
  sourcePath: string | null;
  sourceBare: boolean | null;
  sourceMergeEligible: boolean;
}

export interface CloneResult extends CloneSource {
  baseCommit: string;
  checkoutBranch: string | null;
  resolvedRef: string | null;
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
  options: { maxBuffer?: number; env?: Record<string, string | undefined> } = {},
): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
}

function gitDiff(cwd: string, args: string[], env?: Record<string, string | undefined>): string {
  return gitBounded(cwd, args, GIT_DIFF_MAX_BUFFER_BYTES, "git diff", env);
}

function gitStatus(cwd: string, args: string[], env?: Record<string, string | undefined>): string {
  return gitBounded(cwd, args, GIT_STATUS_MAX_BUFFER_BYTES, "git status", env);
}

function gitBounded(
  cwd: string,
  args: string[],
  maxBuffer: number,
  label: string,
  env?: Record<string, string | undefined>,
): string {
  try {
    return git(cwd, args, undefined, { maxBuffer, env });
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

/** Resolve any path inside a git repository to its repository root and base commit. */
export function resolveGitRootTarget(target: string, ref = "HEAD"): GitTarget {
  if (!isAbsolute(target)) {
    throw new Error(`workspace path must be an absolute daemon-resolvable path, got ${target}`);
  }
  let repoRoot: string;
  try {
    repoRoot = git(target, ["rev-parse", "--show-toplevel"]).trim();
  } catch (err) {
    throw new Error(
      `workspace path ${target} is not inside a git repository: ${gitErrorMessage(err)}`,
    );
  }
  const sourcePath = canonicalPath(repoRoot);
  let baseCommit: string;
  try {
    baseCommit = git(sourcePath, ["rev-parse", ref]).trim();
  } catch (err) {
    throw new Error(
      `workspace ref ${ref} cannot be resolved in ${sourcePath}: ${gitErrorMessage(err)}`,
    );
  }
  return { target: sourcePath, repoRoot: sourcePath, baseCommit };
}

export function assertUsableTargetDirectory(target: string): void {
  resolveUsableDirectory(target);
}

export function resolveUsableDirectory(target: string): string {
  if (!isAbsolute(target)) {
    throw new Error(`workspace path must be an absolute daemon-resolvable path, got ${target}`);
  }
  try {
    const real = realpathSync(target);
    if (!existsSync(real)) throw new Error("missing");
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch (err) {
    throw new Error(
      `workspace path ${target} is not an existing directory: ${gitErrorMessage(err)}`,
    );
  }
}

export function retainedWorkspacePath(
  workspaceStore: string,
  runId: string,
  agentKey: string,
): string {
  return join(workspaceStore, safeSegment(runId), safeSegment(agentKey));
}

export function copyBaselinePath(
  workspaceStore: string,
  runId: string,
  workspaceId: string,
): string {
  return join(workspaceStore, `${safeSegment(runId)}-baseline`, safeSegment(workspaceId));
}

export function createRetainedWorktree(
  repoRoot: string,
  workspacePath: string,
  baseCommit: string,
): void {
  mkdirSync(dirname(workspacePath), { recursive: true });
  git(repoRoot, ["worktree", "add", "--detach", workspacePath, baseCommit]);
}

export function createRetainedCopy(
  sourcePath: string,
  workspacePath: string,
  baselinePath: string,
): void {
  rmSync(workspacePath, { recursive: true, force: true });
  rmSync(baselinePath, { recursive: true, force: true });
  mkdirSync(dirname(workspacePath), { recursive: true });
  mkdirSync(dirname(baselinePath), { recursive: true });
  copyDirectorySnapshot(sourcePath, workspacePath);
  copyDirectorySnapshot(sourcePath, baselinePath);
}

export function classifyCloneSource(repo: string): CloneSource {
  if (!repo.trim()) throw new Error("clone workspace repo is required and must be non-empty");
  if (repo.startsWith("file://")) {
    return localCloneSource(fileURLToPath(repo), repo);
  }
  if (isAbsolute(repo)) return localCloneSource(repo, repo);
  if (looksLikeRelativeLocalPath(repo)) {
    throw new Error(`clone workspace repo must be an absolute path or remote git URL, got ${repo}`);
  }
  return {
    repo,
    sourceKind: "remote-git",
    sourcePath: null,
    sourceBare: null,
    sourceMergeEligible: false,
  };
}

export function createRetainedClone(
  source: CloneSource,
  workspacePath: string,
  ref?: string | null,
): CloneResult {
  rmSync(workspacePath, { recursive: true, force: true });
  mkdirSync(dirname(workspacePath), { recursive: true });
  git(dirname(workspacePath), ["clone", source.repo, workspacePath], undefined, {
    maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
  });
  if (ref && ref.length > 0) git(workspacePath, ["checkout", ref]);
  const baseCommit = git(workspacePath, ["rev-parse", "HEAD"]).trim();
  const checkoutBranch = git(workspacePath, ["branch", "--show-current"]).trim() || null;
  const resolvedRef = ref ?? checkoutBranch ?? "HEAD";
  return { ...source, baseCommit, checkoutBranch, resolvedRef };
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

export function removeManagedWorkspace(row: {
  mode: "worktree" | "copy" | "clone";
  sourcePath: string | null;
  workspacePath: string;
  baseCommit: string | null;
  copyBaselinePath?: string | null;
}): void {
  if (row.mode === "worktree") {
    if (!row.sourcePath || !row.baseCommit)
      throw new Error("worktree workspace has no git source/base commit");
    removeRetainedWorkspace(row.sourcePath, row.workspacePath, row.baseCommit);
    return;
  }
  rmSync(row.workspacePath, { recursive: true, force: true });
  if (row.mode === "copy" && row.copyBaselinePath) {
    rmSync(row.copyBaselinePath, { recursive: true, force: true });
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

export function diffGitFinalTree(workspacePath: string, baseCommit = "HEAD"): DiffBundle {
  const indexDir = mkdtempSync(join(tmpdir(), "keel-git-index-"));
  const indexPath = join(indexDir, "index");
  const indexEnv = { GIT_INDEX_FILE: indexPath };
  try {
    git(workspacePath, ["add", "-A"], undefined, { env: indexEnv });
    return diffGitFinalTreeWithIndex(workspacePath, baseCommit, indexEnv);
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

function diffGitFinalTreeWithIndex(
  workspacePath: string,
  baseCommit: string,
  indexEnv: Record<string, string | undefined>,
): DiffBundle {
  const status = gitStatus(
    workspacePath,
    ["diff", "--cached", "--name-status", baseCommit],
    indexEnv,
  );
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const omittedPathCounts: DiffPathCounts = { modified: 0, added: 0, deleted: 0 };
  let retainedPathCount = 0;
  const fileChanges: FileChange[] = [];
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const [code, ...pathParts] = line.split("\t");
    const file = pathParts.at(-1) ?? "";
    const bucket = code?.startsWith("A") ? added : code?.startsWith("D") ? deleted : modified;
    const omittedKey = bucket === added ? "added" : bucket === deleted ? "deleted" : "modified";
    if (retainedPathCount < AGENT_DIFF_PATH_MAX_ENTRIES) {
      bucket.push(file);
      retainedPathCount += 1;
    } else {
      omittedPathCounts[omittedKey] += 1;
    }
    fileChanges.push({
      path: file,
      status: code?.startsWith("A") ? "added" : code?.startsWith("D") ? "deleted" : "modified",
    });
  }
  const contentDiff = gitDiff(
    workspacePath,
    ["diff", "--binary", "--cached", baseCommit],
    indexEnv,
  );
  return {
    modified,
    added,
    deleted,
    omittedPathCounts,
    pathLimit: AGENT_DIFF_PATH_MAX_ENTRIES,
    contentDiff,
    mode: "clone",
    diffKind: "git-patch",
    baseLabel: baseCommit,
    workspaceLabel: workspacePath,
    fileChanges,
  };
}

export function diffCopyWorkspace(workspacePath: string, baselinePath: string): DiffBundle {
  const changes = compareTrees(baselinePath, workspacePath);
  return diffBundleFromCopyChanges(changes, baselinePath, workspacePath);
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

export function mergeCloneIntoTarget(
  workspacePath: string,
  target: string,
  baseCommit: string,
): void {
  assertUsableTargetDirectory(target);
  git(workspacePath, ["add", "-A"]);
  const patch = gitDiff(workspacePath, ["diff", "--binary", "--cached", baseCommit]);
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

export function mergeCopyIntoSource(
  workspacePath: string,
  baselinePath: string,
  sourcePath: string,
): void {
  const source = resolveUsableDirectory(sourcePath);
  const changes = compareTrees(baselinePath, workspacePath);
  for (const change of changes) {
    const sourceEntry = safeJoin(source, change.path);
    const baselineEntry = safeJoin(baselinePath, change.path);
    assertNoSymlinkParent(source, change.path);
    if (change.status === "added") {
      if (existsSync(sourceEntry)) {
        throw new Error(`copy workspace merge conflict at ${change.path}; source path was created`);
      }
      continue;
    }
    if (!entriesEqual(sourceEntry, baselineEntry)) {
      throw new Error(`copy workspace merge conflict at ${change.path}; source changed since copy`);
    }
  }
  const tmp = `${source}.keel-merge-${process.pid}-${Date.now()}`;
  const backup = `${source}.keel-backup-${process.pid}-${Date.now()}`;
  copyEntry(source, tmp, false);
  let sourceMovedToBackup = false;
  let tmpMovedToSource = false;
  try {
    for (const change of changes) {
      const tmpEntry = safeJoin(tmp, change.path);
      const workspaceEntry = safeJoin(workspacePath, change.path);
      assertNoSymlinkParent(tmp, change.path);
      if (change.status === "deleted") {
        rmSync(tmpEntry, { recursive: true, force: true });
      } else {
        rmSync(tmpEntry, { recursive: true, force: true });
        copyEntry(workspaceEntry, tmpEntry, true);
      }
    }
    renameSync(source, backup);
    sourceMovedToBackup = true;
    renameSync(tmp, source);
    tmpMovedToSource = true;
  } catch (err) {
    if (tmpMovedToSource) {
      if (existsSync(backup)) {
        rmSync(source, { recursive: true, force: true });
        renameSync(backup, source);
      }
    } else if (sourceMovedToBackup && !existsSync(source)) {
      renameSync(backup, source);
      rmSync(tmp, { recursive: true, force: true });
    } else {
      rmSync(tmp, { recursive: true, force: true });
    }
    throw err;
  }
  rmSync(backup, { recursive: true, force: true });
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

interface TreeEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  mode: string;
  symlinkTarget: string | null;
  binary: boolean;
}

interface CopyChange extends FileChange {
  path: string;
}

function localCloneSource(path: string, originalRepo: string): CloneSource {
  if (!isAbsolute(path)) {
    throw new Error(`clone workspace repo must be an absolute path or remote git URL, got ${path}`);
  }
  let sourcePath: string;
  let sourceBare = false;
  try {
    sourceBare = git(path, ["rev-parse", "--is-bare-repository"]).trim() === "true";
    sourcePath = sourceBare
      ? canonicalPath(path)
      : canonicalPath(git(path, ["rev-parse", "--show-toplevel"]).trim());
  } catch (err) {
    throw new Error(
      `clone workspace repo ${path} is not a git repository: ${gitErrorMessage(err)}`,
    );
  }
  return {
    repo: originalRepo.startsWith("file://") ? originalRepo : sourcePath,
    sourceKind: "local-clone-git",
    sourcePath,
    sourceBare,
    sourceMergeEligible: !sourceBare,
  };
}

function looksLikeRelativeLocalPath(repo: string): boolean {
  return !isRecognizedRemoteGitUrl(repo);
}

function isRecognizedRemoteGitUrl(repo: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(repo) || /^[^@\s:]+@[^@\s:]+:.+/.test(repo);
}

function copyDirectorySnapshot(sourcePath: string, destPath: string): void {
  const source = resolveUsableDirectory(sourcePath);
  copyEntry(source, destPath, true);
}

function copyEntry(source: string, dest: string, excludeGit: boolean): void {
  const st = lstatSync(source);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true, mode: st.mode & 0o777 });
    for (const name of readdirSync(source)) {
      if (excludeGit && name === ".git") continue;
      copyEntry(join(source, name), join(dest, name), excludeGit);
    }
    chmodSync(dest, st.mode & 0o777);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  if (st.isFile()) {
    copyFileSync(source, dest);
    chmodSync(dest, st.mode & 0o777);
    return;
  }
  if (st.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), dest);
    return;
  }
  throw new Error(`copy workspace source contains unsupported filesystem entry: ${source}`);
}

function compareTrees(base: string, workspace: string): CopyChange[] {
  const baseEntries = treeEntries(base);
  const workspaceEntries = treeEntries(workspace);
  const paths = [...new Set([...baseEntries.keys(), ...workspaceEntries.keys()])].sort();
  const changes: CopyChange[] = [];
  for (const path of paths) {
    const oldEntry = baseEntries.get(path);
    const newEntry = workspaceEntries.get(path);
    if (!oldEntry && newEntry) {
      changes.push(copyChange(path, "added", oldEntry, newEntry));
    } else if (oldEntry && !newEntry) {
      changes.push(copyChange(path, "deleted", oldEntry, newEntry));
    } else if (oldEntry && newEntry && !entriesMetadataEqual(oldEntry, newEntry)) {
      changes.push(
        copyChange(
          path,
          oldEntry.kind === newEntry.kind ? "modified" : "type_changed",
          oldEntry,
          newEntry,
        ),
      );
    } else if (oldEntry && newEntry && oldEntry.kind === "file") {
      const oldPath = join(base, path);
      const newPath = join(workspace, path);
      if (!filesEqual(oldPath, newPath)) {
        changes.push(copyChange(path, "modified", oldEntry, newEntry));
      }
    }
  }
  return changes.filter(
    (change) =>
      change.status !== "modified" ||
      !isDirectoryOnlyModeChange(baseEntries.get(change.path), workspaceEntries.get(change.path)),
  );
}

function treeEntries(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (abs: string, rel: string): void => {
    const st = lstatSync(abs);
    const mode = modeString(st.mode);
    if (st.isDirectory()) {
      if (rel)
        out.set(rel, { path: rel, kind: "directory", mode, symlinkTarget: null, binary: false });
      for (const name of readdirSync(abs)) {
        if (name === ".git") continue;
        walk(join(abs, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (st.isFile()) {
      out.set(rel, {
        path: rel,
        kind: "file",
        mode,
        symlinkTarget: null,
        binary: isBinaryFile(abs),
      });
      return;
    }
    if (st.isSymbolicLink()) {
      out.set(rel, {
        path: rel,
        kind: "symlink",
        mode,
        symlinkTarget: readlinkSync(abs),
        binary: false,
      });
      return;
    }
    throw new Error(`copy workspace contains unsupported filesystem entry: ${abs}`);
  };
  walk(root, "");
  return out;
}

function copyChange(
  path: string,
  status: CopyChange["status"],
  oldEntry: TreeEntry | undefined,
  newEntry: TreeEntry | undefined,
): CopyChange {
  return {
    path,
    status,
    oldMode: oldEntry?.mode ?? null,
    newMode: newEntry?.mode ?? null,
    oldSymlinkTarget: oldEntry?.symlinkTarget ?? null,
    newSymlinkTarget: newEntry?.symlinkTarget ?? null,
    binary: Boolean(oldEntry?.binary || newEntry?.binary),
    textDiffIncluded: false,
  };
}

function diffBundleFromCopyChanges(
  changes: CopyChange[],
  baselinePath: string,
  workspacePath: string,
): DiffBundle {
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const omittedPathCounts: DiffPathCounts = { modified: 0, added: 0, deleted: 0 };
  const content = new DiffContentBuilder();
  let retainedPathCount = 0;
  for (const change of changes) {
    const bucket =
      change.status === "added" ? added : change.status === "deleted" ? deleted : modified;
    const omittedKey = bucket === added ? "added" : bucket === deleted ? "deleted" : "modified";
    if (retainedPathCount < AGENT_DIFF_PATH_MAX_ENTRIES) {
      bucket.push(change.path);
      retainedPathCount += 1;
    } else {
      omittedPathCounts[omittedKey] += 1;
    }
    appendCopyChangeDiff(content, change, baselinePath, workspacePath);
  }
  return {
    modified,
    added,
    deleted,
    omittedPathCounts,
    pathLimit: AGENT_DIFF_PATH_MAX_ENTRIES,
    contentDiff: content.value,
    mode: "copy",
    diffKind: "recursive-copy",
    baseLabel: baselinePath,
    workspaceLabel: workspacePath,
    fileChanges: changes,
  };
}

function appendCopyChangeDiff(
  content: DiffContentBuilder,
  change: CopyChange,
  baselinePath: string,
  workspacePath: string,
): void {
  if (content.truncated) return;
  content.append(`diff --keel-copy a/${change.path} b/${change.path}\n`);
  if (change.oldMode !== change.newMode) {
    content.append(`mode ${change.oldMode ?? "000000"} => ${change.newMode ?? "000000"}\n`);
  }
  if (change.oldSymlinkTarget !== change.newSymlinkTarget) {
    content.append(
      `symlink ${change.oldSymlinkTarget ?? "(none)"} => ${change.newSymlinkTarget ?? "(none)"}\n`,
    );
  }
  if (change.binary) {
    content.append("binary files differ\n");
    return;
  }
  const oldPath = join(baselinePath, change.path);
  const newPath = join(workspacePath, change.path);
  const oldIsFile = existsSync(oldPath) && lstatSync(oldPath).isFile();
  const newIsFile = existsSync(newPath) && lstatSync(newPath).isFile();
  if (!oldIsFile && !newIsFile) return;
  if (oldIsFile && newIsFile) {
    try {
      content.append(
        execFileSync(
          "diff",
          ["-u", "--label", `a/${change.path}`, oldPath, "--label", `b/${change.path}`, newPath],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: AGENT_DIFF_CONTENT_MAX_BYTES,
          },
        ),
      );
      change.textDiffIncluded = true;
    } catch (err) {
      if (err && typeof err === "object" && "stdout" in err) {
        content.append(String((err as { stdout?: unknown }).stdout ?? ""));
        change.textDiffIncluded = true;
      }
    }
  } else if (newIsFile) {
    appendWholeFile(content, change.path, newPath, "+");
    change.textDiffIncluded = true;
  } else if (oldIsFile) {
    appendWholeFile(content, change.path, oldPath, "-");
    change.textDiffIncluded = true;
  }
}

function appendWholeFile(
  content: DiffContentBuilder,
  path: string,
  file: string,
  prefix: "+" | "-",
): void {
  const { text, truncated } = readTextFilePrefix(file, AGENT_DIFF_CONTENT_MAX_BYTES);
  content.append(
    `${prefix === "+" ? "--- /dev/null\n" : `--- a/${path}\n`}${prefix === "+" ? `+++ b/${path}\n` : "+++ /dev/null\n"}`,
  );
  content.append(
    text
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n"),
  );
  content.append("\n");
  if (truncated) content.markTruncated();
}

function entriesMetadataEqual(a: TreeEntry, b: TreeEntry): boolean {
  return a.kind === b.kind && a.mode === b.mode && a.symlinkTarget === b.symlinkTarget;
}

function isDirectoryOnlyModeChange(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  return Boolean(a && b && a.kind === "directory" && b.kind === "directory" && a.mode !== b.mode);
}

function entriesEqual(a: string, b: string): boolean {
  if (!existsSync(a) && !existsSync(b)) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  const left = lstatSync(a);
  const right = lstatSync(b);
  if (left.isDirectory() || right.isDirectory()) {
    if (!left.isDirectory() || !right.isDirectory()) return false;
    return directoriesEqual(a, b);
  }
  if (left.isSymbolicLink() || right.isSymbolicLink()) {
    return left.isSymbolicLink() && right.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
  }
  if (!left.isFile() || !right.isFile()) return false;
  return modeString(left.mode) === modeString(right.mode) && filesEqual(a, b);
}

function directoriesEqual(a: string, b: string): boolean {
  const left = readdirSync(a).sort();
  const right = readdirSync(b).sort();
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
    if (!entriesEqual(join(a, left[i] as string), join(b, right[i] as string))) return false;
  }
  return true;
}

function filesEqual(a: string, b: string): boolean {
  return readFileSync(a).equals(readFileSync(b));
}

function isBinaryFile(path: string): boolean {
  const data = readFileSync(path);
  return data.subarray(0, 8192).includes(0);
}

function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(6, "0");
}

function safeJoin(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (r.startsWith("..") || isAbsolute(r)) throw new Error(`workspace path escapes root: ${rel}`);
  return abs;
}

function assertNoSymlinkParent(root: string, rel: string): void {
  const parts = rel.split("/").filter(Boolean);
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) {
      throw new Error(`copy workspace merge refuses to write through symlink parent ${cur}`);
    }
  }
}

function safeSegment(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "_";
}
