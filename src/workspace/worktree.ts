// Git-worktree isolation + diff-review gate (DESIGN.md §11.3).
//
// An agent that opts into workspaceIsolation runs with cwd in an isolated git
// worktree checked out at the run's base commit. Its changes are captured as a
// diff bundle and merge to the real tree only through approval — never directly.
// Plain git (jj dropped, L9); the VCS lives behind this interface so a container
// backend can swap in.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DiffBundle {
  modified: string[];
  added: string[];
  deleted: string[];
  /** Unified diff of all changes (empty if none). */
  contentDiff: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export interface Worktree {
  path: string;
  baseCommit: string;
  /** Capture the agent's changes as a reviewable diff bundle. */
  diff(): DiffBundle;
  /** Apply this worktree's changes onto the real tree (post-approval merge). */
  mergeInto(realRoot: string): void;
  /** Remove the worktree. */
  remove(): void;
}

/** Create an isolated worktree of `repoRoot` at its current HEAD. */
export function createWorktree(repoRoot: string, label: string): Worktree {
  const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const dir = mkdtempSync(join(tmpdir(), `keel-wt-${sanitize(label)}-`));
  // A detached worktree at HEAD; the agent edits here in isolation.
  git(repoRoot, ["worktree", "add", "--detach", dir, baseCommit]);

  const diff = (): DiffBundle => {
    // include untracked files so added files show up
    const status = git(dir, ["status", "--porcelain", "--untracked-files=all"]);
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
    // Unified diff of tracked changes, plus the FULL content of each untracked
    // added file (read directly — `git diff --no-index` exits nonzero and throws,
    // which previously dropped added-file content silently). The contentDiff is
    // the durable reviewable patch the diff gate approves.
    let contentDiff = git(dir, ["diff", "HEAD"]);
    for (const f of added) {
      try {
        const body = readFileSync(join(dir, f), "utf8");
        const lines = body.split("\n");
        if (lines.at(-1) === "") lines.pop(); // drop trailing empty from final newline
        contentDiff += `\ndiff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${lines
          .map((l) => `+${l}`)
          .join("\n")}\n`;
      } catch {
        // unreadable (e.g. a directory entry) — skip; it still shows in `added`
      }
    }
    return { modified, added, deleted, contentDiff };
  };

  return {
    path: dir,
    baseCommit,
    diff,
    mergeInto(realRoot: string): void {
      // Stage everything in the worktree and apply the resulting patch to the
      // real tree. (A real merge would handle conflicts; this is the approved-
      // patch apply for the linear case.)
      git(dir, ["add", "-A"]);
      const patch = git(dir, ["diff", "--cached", "HEAD"]);
      if (patch.trim()) {
        execFileSync("git", ["apply", "--whitespace=nowarn", "-"], {
          cwd: realRoot,
          input: patch,
          encoding: "utf8",
        });
      }
    },
    remove(): void {
      try {
        git(repoRoot, ["worktree", "remove", "--force", dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 24);
}
