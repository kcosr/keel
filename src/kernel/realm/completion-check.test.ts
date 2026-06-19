import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore } from "../../journal/store.ts";
import {
  normalizeCompletionCheckFailureAction,
  normalizeCompletionChecks,
} from "../completion-check.ts";
import { RealmKernel } from "./realm-host.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function kernel(store: JournalStore, extra: Record<string, unknown> = {}): RealmKernel {
  let clock = 1_000;
  return new RealmKernel(store, {
    idgen: () => "run_completion_check",
    clock: () => clock++,
    rng: () => 0.5,
    ...extra,
  });
}

function initGitRepo(path: string): void {
  execFileSync("git", ["init"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "keel@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Keel Test"], { cwd: path });
  writeFileSync(join(path, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: path });
  execFileSync("git", ["commit", "-m", "base"], { cwd: path, stdio: "ignore" });
}

const directCompletionCheckWorkflow = {
  name: "completion-check-direct",
  source: `
    import {
      type Ctx,
      completionCheckStableKey,
      normalizeCompletionChecks
    } from "@kcosr/keel";
    export default async function wf(ctx: Ctx, input: { workspace: string; checks: unknown[] }) {
      const workspace = await ctx.workspace({ key: "repo", mode: "direct", path: input.workspace });
      const checks = normalizeCompletionChecks(input.checks, {
        workspaceMode: "direct",
      });
      return await ctx.completionCheck({
        key: completionCheckStableKey(1, checks[0].key),
        workspace,
        attempt: 1,
        trigger: "auto",
        check: checks[0],
        markFailureSeenOnFailure: true,
      });
    }
  `,
};

const worktreeCompletionCheckWorkflow = {
  name: "completion-check-worktree",
  source: `
    import {
      type Ctx,
      completionCheckStableKey,
      normalizeCompletionChecks
    } from "@kcosr/keel";
    export default async function wf(ctx: Ctx, input: { repository: string }) {
      const workspace = await ctx.workspace({
        key: "impl",
        mode: "worktree",
        path: input.repository,
        branch: true,
        retention: "retain-on-failure",
      });
      const checks = normalizeCompletionChecks([{ key: "committed", type: "has-commits" }], {
        workspaceMode: "worktree",
      });
      return await ctx.completionCheck({
        key: completionCheckStableKey(1, checks[0].key),
        workspace,
        attempt: 1,
        trigger: "auto",
        check: checks[0],
        markFailureSeenOnFailure: true,
      });
    }
  `,
};

const worktreeCommandFailureWorkflow = {
  name: "completion-check-worktree-command-failure",
  source: `
    import {
      type Ctx,
      completionCheckStableKey,
      normalizeCompletionChecks
    } from "@kcosr/keel";
    export default async function wf(ctx: Ctx, input: { repository: string }) {
      const workspace = await ctx.workspace({
        key: "impl",
        mode: "worktree",
        path: input.repository,
        branch: true,
        retention: "retain-on-failure",
      });
      const checks = normalizeCompletionChecks([
        {
          key: "tests",
          type: "command",
          command: "/bin/sh",
          args: ["-c", "printf failed >&2; exit 7"],
        },
      ], {
        workspaceMode: "worktree",
      });
      return await ctx.completionCheck({
        key: completionCheckStableKey(1, checks[0].key),
        workspace,
        attempt: 1,
        trigger: "auto",
        check: checks[0],
        markFailureSeenOnFailure: true,
      });
    }
  `,
};

describe("ctx.completionCheck", () => {
  test("static validation rejects invalid completion-check input", () => {
    expect(() =>
      normalizeCompletionChecks(
        [
          { key: "dup", type: "git-clean" },
          { key: "dup", type: "git-clean" },
        ],
        { workspaceMode: "direct" },
      ),
    ).toThrow(/duplicate key/);
    expect(() =>
      normalizeCompletionChecks([{ key: "committed", type: "has-commits" }], {
        workspaceMode: "direct",
      }),
    ).toThrow(/baseRef is required/);
    expect(() =>
      normalizeCompletionChecks([{ key: "pushed", type: "branch-pushed", remoteRef: "main" }], {
        workspaceMode: "worktree",
      }),
    ).toThrow(/fully qualified ref/);
    expect(() => normalizeCompletionCheckFailureAction("park", "auto")).toThrow(
      /requires completionMode/,
    );
  });

  test("runs command checks in the selected workspace and emits durable events", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-completion-command-");
    const result = await kernel(store).run(
      directCompletionCheckWorkflow,
      {
        workspace,
        checks: [
          {
            key: "write",
            type: "command",
            command: "/bin/sh",
            args: ["-c", "printf ok > completion.txt"],
          },
        ],
      },
      { target: workspace },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toMatchObject({ key: "write", status: "passed" });
    await expect(Bun.file(join(workspace, "completion.txt")).text()).resolves.toBe("ok");
    expect(store.listEvents("run_completion_check").map((event) => event.type)).toContain(
      "completion_check.completed",
    );
  });

  test("reports dirty worktree diagnostics for git-clean checks", async () => {
    const store = JournalStore.memory();
    const repo = tempDir("keel-completion-clean-");
    initGitRepo(repo);
    writeFileSync(join(repo, "untracked.txt"), "dirty\n");
    const result = await kernel(store).run(
      directCompletionCheckWorkflow,
      {
        workspace: repo,
        checks: [{ key: "clean", type: "git-clean" }],
      },
      { target: repo },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toMatchObject({
      key: "clean",
      status: "failed",
      failureKind: "dirty-worktree",
    });
    expect(JSON.stringify(result.output)).toContain("untracked.txt");
  });

  test("failed owned worktree checks mark failureSeen for retain-on-failure", async () => {
    const store = JournalStore.memory();
    const repo = tempDir("keel-completion-worktree-repo-");
    const workspaceStore = tempDir("keel-completion-worktree-store-");
    initGitRepo(repo);
    const result = await kernel(store, { workspaceStore }).run(
      worktreeCompletionCheckWorkflow,
      {
        repository: repo,
      },
      { target: repo },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toMatchObject({
      key: "committed",
      status: "failed",
      failureKind: "no-commits",
    });
    expect(store.getAgentWorkspace("run_completion_check", "impl")?.failureSeen).toBe(true);
  });

  test("failed owned worktree command checks mark failureSeen for retain-on-failure", async () => {
    const store = JournalStore.memory();
    const repo = tempDir("keel-completion-worktree-command-repo-");
    const workspaceStore = tempDir("keel-completion-worktree-command-store-");
    initGitRepo(repo);
    const result = await kernel(store, { workspaceStore }).run(
      worktreeCommandFailureWorkflow,
      {
        repository: repo,
      },
      { target: repo },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toMatchObject({
      key: "tests",
      status: "failed",
      failureKind: "nonzero-exit",
    });
    expect(store.getAgentWorkspace("run_completion_check", "impl")?.failureSeen).toBe(true);
  });
});
