// Realm-host Phase 15 hardening: fail-closed explicit isolation, durable diffs,
// trusted-local secret env injection, worktree cleanup, and secret lifecycle.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "../../agents/codex.ts";
import { SecretStore } from "../../agents/secrets.ts";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
} from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { workspaceIdentity } from "../../workspace/identity.ts";
import {
  GIT_DIFF_MAX_BUFFER_BYTES,
  generatedWorktreeBranchName,
  retainedWorkspacePath,
} from "../../workspace/worktree.ts";
import { RealmKernel } from "./realm-host.ts";

const writeUrl = captureWorkflowFile(
  new URL("./fixtures/write-agent.workflow.ts", import.meta.url).pathname,
);
const readPlusBashUrl = captureWorkflowFile(
  new URL("./fixtures/read-plus-bash.workflow.ts", import.meta.url).pathname,
);
const readPlusBashSecretUrl = captureWorkflowFile(
  new URL("./fixtures/read-plus-bash-secret.workflow.ts", import.meta.url).pathname,
);
const streamUrl = captureWorkflowFile(
  new URL("./fixtures/stream-secret.workflow.ts", import.meta.url).pathname,
);
const writeSecretLooseUrl = captureWorkflowFile(
  new URL("./fixtures/write-secret-loose.workflow.ts", import.meta.url).pathname,
);

/** A provider that writes a file into its cwd (the worktree). */
const writerProvider: AgentProvider = {
  name: "writer",
  async generate(inv: AgentInvocation): Promise<AgentResult> {
    if (inv.cwd) writeFileSync(join(inv.cwd, "added-by-agent.txt"), "AGENT WAS HERE\n");
    return { text: "edited", transcript: [] };
  },
};

describe("trusted-local agent isolation controls", () => {
  test("an agent requesting workspace isolation refuses a non-git target", async () => {
    const store = JournalStore.memory();
    const target = mkdtempSync(join(tmpdir(), "keel-non-git-target-"));
    let called = false;
    const provider: AgentProvider = {
      name: "writer",
      async generate(): Promise<AgentResult> {
        called = true;
        return { text: "x", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    await expect(kernel.run(writeUrl, null, { name: "w", target })).rejects.toThrow(
      /not inside a git repository/,
    );
    rmSync(target, { recursive: true, force: true });
    expect(called).toBe(false); // provider never invoked — failed closed
    expect(store.getRun("r")?.status).toBe("failed");
  });

  test("removed per-agent workspaceRetention is rejected", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          return await ctx.agent({ key: "edit", prompt: "x", provider: "writer", workspaceRetention: "always" });
        }
      `,
      name: "retention-without-isolation",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(writerProvider),
    });
    await expect(kernel.run(workflow, null, { name: "w", target: process.cwd() })).rejects.toThrow(
      /no longer accepts workspaceRetention/,
    );
  });

  test("an explicitly allowed shell tool does not imply workspace isolation", async () => {
    const store = JournalStore.memory();
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        invocation = inv;
        return { text: "inspected", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    const handle = await kernel.run<string>(readPlusBashUrl, null, {
      name: "w",
      target: process.cwd(),
    });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("inspected");
    expect(invocation?.cwd).toBe(process.cwd());
    expect(store.getAgentWorkspace("r", "__default")).toMatchObject({
      mode: "direct",
      ownerKind: "workflow",
      owned: false,
      workspacePath: process.cwd(),
    });
    expect(store.listAgentWorkspaces("r")).toEqual([]);
  });

  test("secrets with write capability run without workspace isolation and receive env", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "file-secret-abc");
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        invocation = inv;
        return { text: `saw ${inv.env?.TOKEN}`, transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
      secrets,
    });
    const handle = await kernel.run<string>(writeSecretLooseUrl, null, {
      name: "ws",
      target: process.cwd(),
    });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("saw file-secret-abc");
    expect(invocation?.cwd).toBe(process.cwd());
    expect(invocation?.capabilities?.fs).toBe("workspace-write");
    expect(invocation?.env?.TOKEN).toBe("file-secret-abc");
  });

  test("selected providerConfig reaches provider immutably without affecting cwd", async () => {
    const store = JournalStore.memory();
    const calls: AgentInvocation[] = [];
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        calls.push(inv);
        expect(inv.cwd).toBe(process.cwd());
        expect(inv.providerConfig).toEqual({ transport: { type: "stdio" } });
        expect(() => {
          (inv.providerConfig as { transport: { type: string } }).transport.type = "mutated";
        }).toThrow();
        return { text: "ok", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          return await ctx.agent({
            key: "cfg",
            provider: "writer",
            prompt: "x",
            providerConfig: {
              writer: { transport: { type: "stdio" } },
              other: { ignored: true },
            },
          });
        }
      `,
      name: "provider-config-cwd",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
    });
    const handle = await kernel.run<string>(workflow, null, { name: "cfg", target: process.cwd() });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  test("unselected providerConfig does not affect replay identity but selected config does", async () => {
    const store = JournalStore.memory();
    const calls: AgentInvocation[] = [];
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        calls.push(inv);
        return { text: `saw ${JSON.stringify(inv.providerConfig)}`, transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { selected: string; unused: string }): Promise<string> {
          return await ctx.agent({
            key: "cfg",
            provider: "writer",
            prompt: "x",
            providerConfig: {
              writer: { selected: input.selected },
              other: { unused: input.unused },
            },
          });
        }
      `,
      name: "provider-config-identity",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
    });
    await kernel.run<string>(workflow, { selected: "a", unused: "one" }, { target: process.cwd() });
    expect(calls).toHaveLength(1);
    await kernel.rerun<string>("r", { input: { selected: "a", unused: "two" } });
    expect(calls).toHaveLength(1);
    await kernel.rerun<string>("r", { input: { selected: "b", unused: "two" } });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.providerConfig)).toEqual([{ selected: "a" }, { selected: "b" }]);
  });

  test("codex omitted providerConfig and explicit stdio are distinct identities", async () => {
    const store = JournalStore.memory();
    const calls: AgentInvocation[] = [];
    const provider: AgentProvider = {
      name: "codex",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        calls.push(inv);
        return { text: "ok", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { explicit: boolean }): Promise<string> {
          return await ctx.agent({
            key: "edit",
            provider: "codex",
            toolPolicy: "unrestricted",
            prompt: "x",
            ...(input.explicit ? { providerConfig: { codex: { transport: { type: "stdio" } } } } : {}),
          });
        }
      `,
      name: "codex-provider-config-identity",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
    });
    await kernel.run<string>(workflow, { explicit: false }, { target: process.cwd() });
    await kernel.rerun<string>("r", { input: { explicit: false } });
    expect(calls).toHaveLength(1);
    await kernel.rerun<string>("r", { input: { explicit: true } });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.providerConfig)).toEqual([
      undefined,
      { transport: { type: "stdio" } },
    ]);
  });

  test("codex default read-only policy fails before falling back to daemon cwd", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          return await ctx.agent({ key: "edit", provider: "codex", prompt: "x" });
        }
      `,
      name: "codex-default-rejects",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(new CodexProvider({ bin: "missing-codex" })),
    });
    await expect(kernel.run<string>(workflow, null, { target: process.cwd() })).rejects.toThrow(
      /toolPolicy: "unrestricted"/,
    );
    expect(store.getRun("r")?.status).toBe("failed");
  });

  test("secrets with provider-native tool additions run without workspace isolation and receive env", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "tool-secret-abc");
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        invocation = inv;
        return { text: `tool saw ${inv.env?.TOKEN}`, transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
      secrets,
    });
    const handle = await kernel.run<string>(readPlusBashSecretUrl, null, {
      name: "ws",
      target: process.cwd(),
    });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("tool saw tool-secret-abc");
    expect(invocation?.allowTools).toContain("bash");
    expect(invocation?.env?.TOKEN).toBe("tool-secret-abc");
  });

  test("explicit direct workspace uses the supplied cwd and persists a direct row", async () => {
    const store = JournalStore.memory();
    const target = mkdtempSync(join(tmpdir(), "keel-direct-target-"));
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        invocation = inv;
        return { text: "direct", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "direct-review", mode: "direct" });
          return await ctx.agent({ key: "review", provider: "writer", prompt: "review", workspace });
        }
      `,
      name: "direct-workspace",
    };
    try {
      const kernel = new RealmKernel(store, {
        idgen: () => "r",
        agents: new AgentProviderRegistry().register(provider),
      });
      const handle = await kernel.run<string>(workflow, null, { name: "direct", target });
      expect(handle.status).toBe("finished");
      expect(invocation?.cwd).toBe(target);
      expect(store.getAgentWorkspace("r", "direct-review")).toMatchObject({
        mode: "direct",
        ownerKind: "workflow",
        owned: false,
        sourcePath: target,
        workspacePath: target,
      });
      expect(store.listAgentWorkspaces("r")).toEqual([]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("withWorkspace works when destructured from ctx", async () => {
    const store = JournalStore.memory();
    const target = mkdtempSync(join(tmpdir(), "keel-direct-target-"));
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        invocation = inv;
        return { text: "scoped", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const { withWorkspace } = ctx;
          return await withWorkspace({ key: "scoped-direct", mode: "direct" }, async () => {
            return await ctx.agent({ key: "review", provider: "writer", prompt: "review" });
          });
        }
      `,
      name: "destructured-with-workspace",
    };
    try {
      const kernel = new RealmKernel(store, {
        idgen: () => "r",
        agents: new AgentProviderRegistry().register(provider),
      });
      const handle = await kernel.run<string>(workflow, null, { name: "direct", target });
      expect(handle.status).toBe("finished");
      expect(handle.output).toBe("scoped");
      expect(invocation?.cwd).toBe(target);
      expect(store.getAgentWorkspace("r", "scoped-direct")).toMatchObject({
        mode: "direct",
        ownerKind: "workflow",
        owned: false,
        workspacePath: target,
      });
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("durable diff + worktree cleanup", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "keel-wsrepo-"));
    const g = (a: string[]) => execFileSync("git", a, { cwd: repo });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function insertCreatingBranchWorkspace(input: {
    store: JournalStore;
    runId: string;
    key: string;
    workspaceStore: string;
    branchName: string;
    baseCommit: string;
    retentionPolicy?: "remove" | "retain-on-failure" | "retain";
    acquired?: boolean;
  }): string {
    const retentionPolicy = input.retentionPolicy ?? "retain";
    const workspacePath = retainedWorkspacePath(input.workspaceStore, input.runId, input.key);
    const identity = workspaceIdentity({
      key: input.key,
      mode: "worktree",
      sourcePath: repo,
      sourceRef: "HEAD",
      retentionPolicy,
      branchPolicy: "generated",
      sdkAbiVersion: 7,
    });
    input.store.insertAgentWorkspace({
      runId: input.runId,
      workspaceId: input.key,
      mode: "worktree",
      ownerKind: "workflow",
      key: input.key,
      lastAttempt: null,
      retentionPolicy,
      workspacePath,
      sourceKind: "worktree-git",
      sourcePath: repo,
      sourceUri: null,
      sourceBare: null,
      sourceMergeEligible: true,
      suppliedPath: null,
      sourceRef: "HEAD",
      resolvedRef: "HEAD",
      checkoutBranch: input.branchName,
      worktreeCheckoutKind: "branch",
      worktreeBranchOwned: true,
      baseCommit: input.baseCommit,
      copyBaselinePath: null,
      creationErrorJson: null,
      workspaceIdentityJson: identity.json,
      workspaceIdentityHash: identity.hash,
      owned: true,
      status: "creating",
      failureSeen: true,
      lastTurnKey: input.acquired ? "edit" : null,
      lastTurnAttempt: input.acquired ? 1 : null,
      activeHolderKind: input.acquired ? "agent" : null,
      activeHolderKey: input.acquired ? "edit" : null,
      activeHolderAttempt: input.acquired ? 1 : null,
      activeStartedAtMs: input.acquired ? 1 : null,
      lastDiffEventSeq: null,
      lastErrorEventSeq: null,
      cleanupErrorJson: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      mergedAtMs: null,
      discardedAtMs: null,
      removedAtMs: null,
    });
    return workspacePath;
  }

  test("two agents sharing one worktree handle observe the same cwd", async () => {
    const store = JournalStore.memory();
    const calls: AgentInvocation[] = [];
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        calls.push({ ...inv });
        if (inv.prompt === "write" && inv.cwd)
          writeFileSync(join(inv.cwd, "shared.txt"), "shared\n");
        if (inv.prompt === "read" && inv.cwd) {
          return { text: readFileSync(join(inv.cwd, "shared.txt"), "utf8"), transcript: [] };
        }
        return { text: "wrote", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "shared", mode: "worktree", retention: "retain" });
          await ctx.agent({ key: "write", provider: "writer", prompt: "write", workspace, capabilities: { fs: "workspace-write" } });
          return await ctx.agent({ key: "read", provider: "writer", prompt: "read", workspace });
        }
      `,
      name: "shared-worktree",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    const handle = await kernel.run<string>(workflow, null, { name: "w", target: repo });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("shared\n");
    expect(calls[0]?.cwd).toBe(calls[1]?.cwd);
    expect(store.listAgentWorkspaces("r")[0]).toMatchObject({
      workspaceId: "shared",
      status: "pending_review",
    });
  });

  test("concurrent active use of the same worktree fails clearly", async () => {
    const store = JournalStore.memory();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        if (inv.prompt === "slow") await gate;
        return { text: inv.prompt, transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string[]> {
          const workspace = await ctx.workspace({ key: "shared", mode: "worktree" });
          return await Promise.all([
            ctx.agent({ key: "slow", provider: "writer", prompt: "slow", workspace }),
            ctx.agent({ key: "fast", provider: "writer", prompt: "fast", workspace }),
          ]);
        }
      `,
      name: "concurrent-worktree",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    await expect(kernel.run<string[]>(workflow, null, { name: "w", target: repo })).rejects.toThrow(
      /already active/,
    );
    release?.();
  });

  test("parallel default direct workspace agents are permitted", async () => {
    const store = JournalStore.memory();
    const cwdByKey = new Map<string, string | undefined>();
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        cwdByKey.set(inv.key, inv.cwd);
        await Bun.sleep(20);
        return { text: inv.key, transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string[]> {
          return await Promise.all([
            ctx.agent({ key: "a", provider: "writer", prompt: "a" }),
            ctx.agent({ key: "b", provider: "writer", prompt: "b" }),
          ]);
        }
      `,
      name: "parallel-default-direct",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    const handle = await kernel.run<string[]>(workflow, null, { name: "w", target: repo });
    expect(handle.status).toBe("finished");
    expect(cwdByKey.get("a")).toBe(repo);
    expect(cwdByKey.get("b")).toBe(repo);
    expect(store.getAgentWorkspace("r", "__default")).toMatchObject({
      mode: "direct",
      owned: false,
    });
  });

  test("late provider completion does not overwrite terminal workspace cleanup", async () => {
    const store = JournalStore.memory();
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        if (inv.prompt === "fail") throw new Error("boom");
        await Bun.sleep(80);
        return { text: "slow", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string[]> {
          const slowWorkspace = await ctx.workspace({ key: "slow-workspace", mode: "worktree" });
          const failWorkspace = await ctx.workspace({ key: "fail-workspace", mode: "worktree" });
          return await Promise.all([
            ctx.agent({ key: "slow", provider: "writer", prompt: "slow", workspace: slowWorkspace }),
            ctx.agent({ key: "fail", provider: "writer", prompt: "fail", workspace: failWorkspace }),
          ]);
        }
      `,
      name: "late-workspace-release",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    await expect(kernel.run<string[]>(workflow, null, { name: "w", target: repo })).rejects.toThrow(
      /boom/,
    );
    await Bun.sleep(120);

    const slowWorkspace = store
      .listAgentWorkspaces("r", { includeRemoved: true })
      .find((row) => row.key === "slow-workspace");
    expect(slowWorkspace?.status).toBe("removed");
    expect(slowWorkspace?.activeHolderKind).toBeNull();
  });

  test("the agent.diff event carries bounded reviewable contentDiff, and the worktree is removed", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(writerProvider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    const handle = await kernel.run<string>(writeUrl, null, { name: "w", target: repo });
    expect(handle.status).toBe("finished");

    const diffEvent = store.listEvents("r").find((e) => e.type === "agent.diff");
    expect(diffEvent).toBeDefined();
    const payload = JSON.parse(diffEvent?.payloadJson ?? "{}");
    expect(payload.added).toContain("added-by-agent.txt");
    expect(payload.contentDiff).toContain("AGENT WAS HERE"); // durable reviewable patch content
    // the real tree is untouched (changes stay in the worktree until approval)
    expect(existsSync(join(repo, "added-by-agent.txt"))).toBe(false);
    expect(store.listAgentWorkspaces("r")).toEqual([]);
    expect(
      store
        .listAgentWorkspaces("r", { includeRemoved: true })
        .find((row) => row.key === "edit-workspace")?.status,
    ).toBe("removed");
  });

  test("retention retain keeps a one-shot success workspace for review", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "edit-workspace", mode: "worktree", retention: "retain" });
          return await ctx.agent({
            key: "edit",
            prompt: "make a change",
            provider: "writer",
            workspace,
            capabilities: { fs: "workspace-write" },
          });
        }
      `,
      name: "one-shot-retain-always",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(writerProvider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    const handle = await kernel.run<string>(workflow, null, { name: "w", target: repo });
    expect(handle.status).toBe("finished");
    const workspace = store.listAgentWorkspaces("r")[0];
    expect(workspace).toMatchObject({
      mode: "worktree",
      ownerKind: "workflow",
      key: "edit-workspace",
      status: "pending_review",
      retentionPolicy: "retain",
    });
    expect(existsSync(workspace?.workspacePath ?? "")).toBe(true);
  });

  test("copy workspace snapshots dirty files, excludes git metadata, and uses managed cwd", async () => {
    const store = JournalStore.memory();
    const target = mkdtempSync(join(tmpdir(), "keel-copy-target-"));
    mkdirSync(join(target, ".git"), { recursive: true });
    writeFileSync(join(target, ".git", "config"), "secret git metadata\n");
    writeFileSync(join(target, "dirty.txt"), "dirty\n");
    let cwd: string | undefined;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        cwd = inv.cwd;
        expect(readFileSync(join(inv.cwd as string, "dirty.txt"), "utf8")).toBe("dirty\n");
        expect(existsSync(join(inv.cwd as string, ".git"))).toBe(false);
        writeFileSync(join(inv.cwd as string, "agent.txt"), "agent\n");
        return { text: "copied", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "snapshot", mode: "copy", retention: "retain" });
          return await ctx.agent({ key: "edit", provider: "writer", prompt: "edit", workspace, capabilities: { fs: "workspace-write" } });
        }
      `,
      name: "copy-workspace",
    };
    try {
      const kernel = new RealmKernel(store, {
        idgen: () => "r-copy",
        agents: new AgentProviderRegistry().register(provider),
        workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
      });
      const handle = await kernel.run<string>(workflow, null, { target });
      expect(handle.status).toBe("finished");
      const row = store.getAgentWorkspace("r-copy", "snapshot");
      expect(row).toMatchObject({
        mode: "copy",
        sourceKind: "local-copy",
        sourcePath: target,
        sourceMergeEligible: true,
        status: "pending_review",
      });
      expect(cwd).toBe(row?.workspacePath);
      expect(row?.copyBaselinePath).toBeTruthy();
      expect(existsSync(row?.copyBaselinePath ?? "")).toBe(true);
      expect(existsSync(join(target, "agent.txt"))).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("clone workspace uses explicit local repo and excludes dirty source files", async () => {
    const store = JournalStore.memory();
    writeFileSync(join(repo, "dirty-source.txt"), "not committed\n");
    let cwd: string | undefined;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        cwd = inv.cwd;
        expect(readFileSync(join(inv.cwd as string, "seed.txt"), "utf8")).toBe("seed\n");
        expect(existsSync(join(inv.cwd as string, "dirty-source.txt"))).toBe(false);
        writeFileSync(join(inv.cwd as string, "clone-agent.txt"), "agent\n");
        return { text: "cloned", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "clone-local", mode: "clone", repo: ctx.run.target, retention: "retain" });
          return await ctx.agent({ key: "edit", provider: "writer", prompt: "edit", workspace, capabilities: { fs: "workspace-write" } });
        }
      `,
      name: "clone-workspace",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r-clone",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    const handle = await kernel.run<string>(workflow, null, { target: repo });
    expect(handle.status).toBe("finished");
    const row = store.getAgentWorkspace("r-clone", "clone-local");
    expect(row).toMatchObject({
      mode: "clone",
      sourceKind: "local-clone-git",
      sourcePath: repo,
      sourceMergeEligible: true,
      status: "pending_review",
    });
    expect(row?.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(cwd).toBe(row?.workspacePath);
  });

  test("branch-backed worktree uses default direct source and generated branch cwd", async () => {
    const store = JournalStore.memory();
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    let cwd: string | undefined;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        cwd = inv.cwd;
        if (inv.cwd) writeFileSync(join(inv.cwd, "branch-agent.txt"), "agent\n");
        return { text: "branched", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "feature / odd key?!", mode: "worktree", branch: true, retention: "retain" });
          return await ctx.agent({ key: "edit", provider: "writer", prompt: "edit", workspace, capabilities: { fs: "workspace-write" } });
        }
      `,
      name: "branch-worktree",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r-branch",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    const handle = await kernel.run<string>(workflow, null, { target: repo });
    expect(handle.status).toBe("finished");
    const row = store.getAgentWorkspace("r-branch", "feature / odd key?!");
    expect(row).toMatchObject({
      mode: "worktree",
      sourcePath: repo,
      suppliedPath: null,
      worktreeCheckoutKind: "branch",
      worktreeBranchOwned: true,
      baseCommit,
      status: "pending_review",
    });
    expect(store.getAgentWorkspace("r-branch", "__default")).toMatchObject({
      mode: "direct",
      workspacePath: repo,
    });
    expect(cwd).toBe(row?.workspacePath);
    const checkoutBranch = row?.checkoutBranch;
    const workspacePath = row?.workspacePath;
    if (!checkoutBranch || !workspacePath) throw new Error("branch workspace row was incomplete");
    expect(checkoutBranch).toMatch(/^keel\/[0-9a-f]{16}\/feature-odd-key-[0-9a-f]{12}$/);
    expect(
      execFileSync("git", ["check-ref-format", "--branch", checkoutBranch], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
    ).toBe(checkoutBranch);
    expect(
      execFileSync("git", ["rev-parse", `refs/heads/${checkoutBranch}`], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
    ).toBe(baseCommit);
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: workspacePath,
        encoding: "utf8",
      }).trim(),
    ).toBe(checkoutBranch);
  });

  test("removed branch-backed worktree reattaches to the persisted branch without reset", async () => {
    const store = JournalStore.memory();
    let calls = 0;
    let branchName: string | null = null;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        calls += 1;
        if (calls === 1) throw new Error("first attempt fails");
        expect(inv.cwd ? existsSync(join(inv.cwd, "human.txt")) : false).toBe(true);
        return { text: "reattached", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "impl", mode: "worktree", branch: true });
          return await ctx.agent({ key: "edit", provider: "writer", prompt: "edit", workspace });
        }
      `,
      name: "branch-reattach",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r-reattach",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });

    await kernel.run<string>(workflow, null, { target: repo }).catch(() => null);
    const removed = store.getAgentWorkspace("r-reattach", "impl");
    expect(removed?.status).toBe("removed");
    branchName = removed?.checkoutBranch ?? null;
    expect(branchName).toBeTruthy();

    const humanWorktree = mkdtempSync(join(tmpdir(), "keel-human-branch-"));
    rmSync(humanWorktree, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", humanWorktree, branchName as string], { cwd: repo });
    writeFileSync(join(humanWorktree, "human.txt"), "human commit\n");
    execFileSync("git", ["add", "-A"], { cwd: humanWorktree });
    execFileSync("git", ["commit", "-q", "-m", "human"], { cwd: humanWorktree });
    execFileSync("git", ["worktree", "remove", "--force", humanWorktree], { cwd: repo });

    const retried = await kernel.retry<string>("r-reattach");
    expect(retried).toMatchObject({ status: "finished", output: "reattached" });
    expect(calls).toBe(2);
    expect(store.getAgentWorkspace("r-reattach", "impl")?.checkoutBranch).toBe(branchName);
  });

  test("removed branch-backed worktree fails closed when the persisted branch is missing", async () => {
    const store = JournalStore.memory();
    let calls = 0;
    const provider: AgentProvider = {
      name: "writer",
      async generate(): Promise<AgentResult> {
        calls += 1;
        throw new Error("first attempt fails");
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "impl", mode: "worktree", branch: true });
          return await ctx.agent({ key: "edit", provider: "writer", prompt: "edit", workspace });
        }
      `,
      name: "branch-missing-reattach",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r-missing-branch",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });

    await kernel.run<string>(workflow, null, { target: repo }).catch(() => null);
    const removed = store.getAgentWorkspace("r-missing-branch", "impl");
    const branchName = removed?.checkoutBranch;
    if (!branchName) throw new Error("branch workspace row was incomplete");
    execFileSync("git", ["branch", "-D", branchName], { cwd: repo });

    await expect(kernel.retry<string>("r-missing-branch")).rejects.toThrow(
      /cannot be reattached because branch .* is missing/,
    );
    expect(calls).toBe(1);
  });

  test("branch-backed worktree refuses an existing generated branch collision", async () => {
    const store = JournalStore.memory();
    let called = false;
    const provider: AgentProvider = {
      name: "writer",
      async generate(): Promise<AgentResult> {
        called = true;
        return { text: "unexpected", transcript: [] };
      },
    };
    const branchName = generatedWorktreeBranchName("r-collision", "impl");
    execFileSync("git", ["branch", branchName, "HEAD"], { cwd: repo });
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "impl", mode: "worktree", branch: true });
          return await ctx.agent({ key: "edit", provider: "writer", prompt: "edit", workspace });
        }
      `,
      name: "branch-collision",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r-collision",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });

    await expect(kernel.run<string>(workflow, null, { target: repo })).rejects.toThrow(
      /worktree branch .* already exists/,
    );
    expect(store.getAgentWorkspace("r-collision", "impl")).toMatchObject({
      status: "removed",
      checkoutBranch: null,
      worktreeBranchOwned: false,
    });
    await expect(kernel.retry<string>("r-collision")).rejects.toThrow(
      /removed but has no persisted branch metadata/,
    );
    expect(called).toBe(false);
  });

  test("creating branch-backed worktree recovers a verified branch and stale worktree path", async () => {
    const store = JournalStore.memory();
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-workspaces-"));
    const runId = "r-create-recover";
    const key = "impl";
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const branchName = generatedWorktreeBranchName(runId, key);
    execFileSync("git", ["branch", branchName, baseCommit], { cwd: repo });
    const workspacePath = insertCreatingBranchWorkspace({
      store,
      runId,
      key,
      workspaceStore,
      branchName,
      baseCommit,
    });
    execFileSync("git", ["worktree", "add", workspacePath, branchName], { cwd: repo });
    rmSync(workspacePath, { recursive: true, force: true });
    let cwd: string | undefined;
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        cwd = inv.cwd;
        return { text: "recovered", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "impl", mode: "worktree", branch: true, retention: "retain" });
          return await ctx.agent({ key: "edit", provider: "writer", prompt: "edit", workspace });
        }
      `,
      name: "branch-creating-recover",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => runId,
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore,
    });

    const handle = await kernel.run<string>(workflow, null, { target: repo });
    expect(handle).toMatchObject({ status: "finished", output: "recovered" });
    expect(cwd).toBe(workspacePath);
    expect(store.getAgentWorkspace(runId, key)).toMatchObject({
      status: "pending_review",
      checkoutBranch: branchName,
    });
  });

  test("creating branch-backed worktree recovery fails closed after stale provider acquisition", async () => {
    const store = JournalStore.memory();
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-workspaces-"));
    const runId = "r-create-acquired";
    const key = "impl";
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const branchName = generatedWorktreeBranchName(runId, key);
    execFileSync("git", ["branch", branchName, baseCommit], { cwd: repo });
    insertCreatingBranchWorkspace({
      store,
      runId,
      key,
      workspaceStore,
      branchName,
      baseCommit,
      acquired: true,
    });
    let called = false;
    const provider: AgentProvider = {
      name: "writer",
      async generate(): Promise<AgentResult> {
        called = true;
        return { text: "unexpected", transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "impl", mode: "worktree", branch: true, retention: "retain" });
          return await ctx.agent({ key: "edit", provider: "writer", prompt: "edit", workspace });
        }
      `,
      name: "branch-creating-acquired",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => runId,
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore,
    });

    await expect(kernel.run<string>(workflow, null, { target: repo })).rejects.toThrow(
      /missing at/,
    );
    expect(called).toBe(false);
  });

  test("distinct branch-backed workspace keys with the same slug get distinct branches", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          await ctx.workspace({ key: "same slug", mode: "worktree", branch: true, retention: "retain" });
          await ctx.workspace({ key: "same/slug", mode: "worktree", branch: true, retention: "retain" });
          return "ok";
        }
      `,
      name: "branch-slug-collision",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r-same-slug",
      agents: new AgentProviderRegistry().register(writerProvider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });

    const handle = await kernel.run<string>(workflow, null, { target: repo });
    expect(handle.status).toBe("finished");
    const first = store.getAgentWorkspace("r-same-slug", "same slug")?.checkoutBranch;
    const second = store.getAgentWorkspace("r-same-slug", "same/slug")?.checkoutBranch;
    expect(first).toMatch(/^keel\/[0-9a-f]{16}\/same-slug-[0-9a-f]{12}$/);
    expect(second).toMatch(/^keel\/[0-9a-f]{16}\/same-slug-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
  });

  test("branch-backed worktree identity flips fail through ctx.workspace", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          await ctx.workspace({ key: "impl", mode: "worktree", retention: "retain" });
          await ctx.workspace({ key: "impl", mode: "worktree", branch: true, retention: "retain" });
          return "unreachable";
        }
      `,
      name: "branch-identity-flip",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r-identity-flip",
      agents: new AgentProviderRegistry().register(writerProvider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });

    await expect(kernel.run<string>(workflow, null, { target: repo })).rejects.toThrow(
      /workspace "impl" identity changed/,
    );
  });

  test("branch-backed worktree acquisition fails if the branch no longer contains the base commit", async () => {
    const store = JournalStore.memory();
    const calls: string[] = [];
    const provider: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        calls.push(inv.prompt);
        return { text: inv.prompt, transcript: [] };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "impl", mode: "worktree", branch: true, retention: "retain" });
          await ctx.agent({ key: "first", provider: "writer", prompt: "first", workspace });
          await ctx.signal("go");
          return await ctx.agent({ key: "second", provider: "writer", prompt: "second", workspace });
        }
      `,
      name: "branch-reset-before-acquire",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r-reset-branch",
      agents: new AgentProviderRegistry().register(provider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });

    const parked = await kernel.run<string>(workflow, null, { target: repo });
    expect(parked.status).toBe("waiting-signal");
    expect(calls).toEqual(["first"]);
    const branchName = store.getAgentWorkspace("r-reset-branch", "impl")?.checkoutBranch;
    if (!branchName) throw new Error("branch workspace row was incomplete");
    const unrelatedCommit = execFileSync("git", ["commit-tree", "HEAD^{tree}", "-m", "unrelated"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", `refs/heads/${branchName}`, unrelatedCommit], {
      cwd: repo,
    });
    store.putSignal("r-reset-branch", "go", {}, 1);

    await expect(kernel.resume<string>("r-reset-branch")).rejects.toThrow(
      /expected branch .* to contain base commit/,
    );
    expect(calls).toEqual(["first"]);
  });

  test("clone workspace rejects relative local-looking repo paths before git clone", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          await ctx.workspace({ key: "clone-relative", mode: "clone", repo: "subdir/repo" });
          return "unreachable";
        }
      `,
      name: "clone-relative-reject",
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r-relative",
      agents: new AgentProviderRegistry().register(writerProvider),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    await expect(kernel.run<string>(workflow, null, { target: repo })).rejects.toThrow(
      /absolute path or remote git URL/,
    );
  });

  test("retention retain-on-failure keeps a one-shot workspace after fail-then-retry-success", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "edit-workspace", mode: "worktree", retention: "retain-on-failure" });
          return await ctx.agent({
            key: "edit",
            prompt: "make a change",
            provider: "writer",
            workspace,
            capabilities: { fs: "workspace-write" },
          });
        }
      `,
      name: "one-shot-retain-on-failure",
    };
    let calls = 0;
    const failsThenSucceeds: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        calls += 1;
        if (inv.cwd) writeFileSync(join(inv.cwd, `attempt-${calls}.txt`), `attempt ${calls}\n`);
        if (calls === 1) throw new Error("transient write failure");
        return { text: "ok", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(failsThenSucceeds),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });

    await kernel.run<string>(workflow, null, { name: "w", target: repo }).catch(() => null);
    expect(store.getRun("r")?.status).toBe("failed");
    expect(store.listAgentWorkspaces("r")[0]?.failureSeen).toBe(true);

    const retried = await kernel.retry<string>("r");
    expect(retried.status).toBe("finished");
    const workspace = store.listAgentWorkspaces("r")[0];
    expect(workspace).toMatchObject({ status: "pending_review", failureSeen: true });
    expect(readFileSync(join(workspace?.workspacePath ?? "", "attempt-1.txt"), "utf8")).toBe(
      "attempt 1\n",
    );
    expect(readFileSync(join(workspace?.workspacePath ?? "", "attempt-2.txt"), "utf8")).toBe(
      "attempt 2\n",
    );
  });

  test("default-retention one-shot retry recreates a removed workspace", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const workspace = await ctx.workspace({ key: "edit-workspace", mode: "worktree" });
          return await ctx.agent({
            key: "edit",
            prompt: "make a change",
            provider: "writer",
            workspace,
            capabilities: { fs: "workspace-write" },
          });
        }
      `,
      name: "one-shot-default-retry",
    };
    let calls = 0;
    let firstCwd: string | undefined;
    let secondSawFirstAttempt = true;
    const failsThenSucceeds: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        calls += 1;
        if (calls === 1) {
          firstCwd = inv.cwd;
          if (inv.cwd) writeFileSync(join(inv.cwd, "attempt-1.txt"), "attempt 1\n");
          throw new Error("transient write failure");
        }
        expect(inv.cwd).toBe(firstCwd);
        secondSawFirstAttempt = inv.cwd ? existsSync(join(inv.cwd, "attempt-1.txt")) : true;
        if (inv.cwd) writeFileSync(join(inv.cwd, "attempt-2.txt"), "attempt 2\n");
        return { text: "ok", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(failsThenSucceeds),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });

    await kernel.run<string>(workflow, null, { name: "w", target: repo }).catch(() => null);
    expect(store.getRun("r")?.status).toBe("failed");
    expect(
      store
        .listAgentWorkspaces("r", { includeRemoved: true })
        .find((row) => row.key === "edit-workspace")?.status,
    ).toBe("removed");
    expect(firstCwd ? existsSync(firstCwd) : true).toBe(false);

    const retried = await kernel.retry<string>("r");
    expect(retried.status).toBe("finished");
    expect(retried.output).toBe("ok");
    expect(calls).toBe(2);
    expect(secondSawFirstAttempt).toBe(false);
    expect(
      store
        .listAgentWorkspaces("r", { includeRemoved: true })
        .find((row) => row.key === "edit-workspace")?.status,
    ).toBe("removed");
  });

  test("one-shot oversized diff emits diff_error without failing the agent step", async () => {
    const store = JournalStore.memory();
    const largeWriter: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        if (inv.cwd) {
          writeFileSync(
            join(inv.cwd, "seed.txt"),
            `${"z".repeat(GIT_DIFF_MAX_BUFFER_BYTES + 64 * 1024)}\n`,
          );
        }
        return { text: "edited despite diff size", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(largeWriter),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });

    const handle = await kernel.run<string>(writeUrl, null, { name: "w", target: repo });

    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("edited despite diff size");
    const events = store.listEvents("r");
    expect(events.some((event) => event.type === "agent.diff")).toBe(false);
    const diffError = events.find((event) => event.type === "workspace.diff_error");
    expect(diffError?.payloadJson).toContain("git diff output exceeded explicit");
    expect(existsSync(join(repo, "seed.txt"))).toBe(true);
  });

  test("a secret a write agent writes into a file is journaled in the durable diff", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "file-secret-abc");
    const writer: AgentProvider = {
      name: "writer",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        // the agent writes the injected secret into a config file
        if (inv.cwd) writeFileSync(join(inv.cwd, "config.ini"), `token=${inv.env?.TOKEN}\n`);
        return { text: "wrote config", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(writer),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
      secrets,
    });
    const writeSecretUrl = captureWorkflowFile(
      new URL("./fixtures/write-secret.workflow.ts", import.meta.url).pathname,
    );
    await kernel.run(writeSecretUrl, null, { name: "ws", target: repo });
    const diff = store.listEvents("r").find((e) => e.type === "agent.diff");
    expect(diff?.payloadJson).toContain("config.ini"); // the file is in the diff
    expect(diff?.payloadJson).toContain("file-secret-abc"); // exact values are not redacted
  });

  test("the worktree is removed even when the agent fails", async () => {
    const store = JournalStore.memory();
    const failing: AgentProvider = {
      name: "writer",
      async generate(): Promise<AgentResult> {
        throw new Error("boom");
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(failing),
      workspaceStore: mkdtempSync(join(tmpdir(), "keel-workspaces-")),
    });
    await kernel.run(writeUrl, null, { name: "w", target: repo }).catch(() => null);
    // git worktree list should show only the main worktree (no leaked temp ones)
    const list = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
    expect(list.trim().split("\n").length).toBe(1);
  });
});

describe("secret lifecycle", () => {
  test("a secret streamed in an agent.event is emitted without redaction, and secrets are wiped on terminal", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "leaky-secret-xyz");
    const liveFrames: unknown[] = [];
    const streamer: AgentProvider = {
      name: "streamer",
      async generate(inv: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
        // stream the secret before returning; trusted-local mode records it as-is.
        hooks.onEvent?.({ type: "text", data: `thinking about ${inv.env?.TOKEN}` });
        return { text: "all done", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(streamer),
      secrets,
      liveEvent: (_runId, type, payload) => liveFrames.push({ type, payload }),
    });
    const handle = await kernel.run<string>(streamUrl, null, {
      name: "s",
      target: process.cwd(),
    });
    expect(handle.status).toBe("finished");

    expect(JSON.stringify(liveFrames)).toContain("leaky-secret-xyz");
    expect(JSON.stringify(liveFrames)).not.toContain("«redacted»");
    expect(store.listEvents("r").some((e) => e.type === "agent.redacted")).toBe(false);
    // secrets wiped on run completion (per-run lifetime)
    expect(secrets.resolve("r", ["TOKEN"])).toEqual([]);
  });

  test("secret values in finalized agent event rows are persisted without redaction", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "persisted-secret-xyz");
    const streamer: AgentProvider = {
      name: "streamer",
      async generate(inv: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
        const secret = inv.env?.TOKEN ?? "";
        const transcript: AgentResult["transcript"] = [
          { type: "tool_call", data: { input: secret } },
          { type: "tool_result", data: { output: secret } },
          { type: "text", data: `final ${secret}` },
        ];
        for (const event of transcript) hooks.onEvent?.(event);
        return { text: `final ${secret}`, transcript };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(streamer),
      secrets,
    });
    const handle = await kernel.run<string>(streamUrl, null, {
      name: "s",
      target: process.cwd(),
    });
    expect(handle.status).toBe("finished");

    const agentEvents = store.listEvents("r").filter((event) => event.type.startsWith("agent."));
    const eventTypes = agentEvents.map((event) => event.type);
    expect(eventTypes).toContain("agent.tool_call");
    expect(eventTypes).toContain("agent.tool_result");
    expect(eventTypes).toContain("agent.message");
    const serialized = JSON.stringify(agentEvents.map((event) => JSON.parse(event.payloadJson)));
    expect(serialized).toContain("persisted-secret-xyz");
    expect(serialized).not.toContain("«redacted»");
  });
});
