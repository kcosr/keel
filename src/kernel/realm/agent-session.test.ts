import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentFailure } from "../../agents/execute.ts";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
} from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { GIT_DIFF_MAX_BUFFER_BYTES } from "../../workspace/worktree.ts";
import { WorkflowCtx } from "../ctx.ts";
import { type ClientCapturedWorkflow, RealmKernel, type RunHandle } from "./realm-host.ts";

const WORKFLOW = {
  source: `
    import { type Ctx, jsonSchema } from "@kcosr/keel";
    const Out = jsonSchema<{ value: number }>({
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "number" } },
    });
    export default async function wf(ctx: Ctx, input: { second?: boolean } | null): Promise<number> {
      const primary = ctx.agentSession({ key: "primary", provider: "session", toolPolicy: "read-only" });
      const first = await primary.turn({ key: "draft", prompt: "draft", schema: Out });
      if (input?.second === false) return first.value;
      const second = await primary.turn({ key: "revise", prompt: "revise", schema: Out });
      return first.value + second.value;
    }
  `,
  name: "session",
};

class RecordingSessionProvider implements AgentProvider {
  readonly name = "session";
  readonly supportsSessions = true;
  readonly calls: AgentInvocation[] = [];
  private n = 0;

  constructor(private readonly delayMs = 0) {}

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    this.calls.push(invocation);
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    const token = invocation.resumeToken ?? "sess-1";
    hooks.onEvent?.({ type: "session", data: token });
    hooks.onSessionToken?.(token);
    const value = ++this.n;
    return { text: JSON.stringify({ value }), transcript: [], sessionToken: token };
  }
}

class StreamingSessionProvider implements AgentProvider {
  readonly name = "session";
  readonly supportsSessions = true;
  readonly calls: AgentInvocation[] = [];
  private firstEvent: Promise<void>;
  private resolveFirstEvent!: () => void;
  private releaseStream: Promise<void>;
  private resolveRelease!: () => void;

  constructor() {
    this.firstEvent = new Promise((resolve) => {
      this.resolveFirstEvent = resolve;
    });
    this.releaseStream = new Promise((resolve) => {
      this.resolveRelease = resolve;
    });
  }

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    this.calls.push(invocation);
    const token = invocation.resumeToken ?? "sess-1";
    hooks.onSessionToken?.(token);
    hooks.onEvent?.({
      type: "tool_call",
      toolCallId: "session-call-1",
      data: { name: "Read", args: { file: "a.ts" } },
    });
    this.resolveFirstEvent();
    await this.releaseStream;
    hooks.onEvent?.({
      type: "tool_result",
      toolCallId: "session-call-1",
      data: { output: "ok" },
    });
    return { text: '{"value":1}', transcript: [], sessionToken: token };
  }

  waitForFirstEvent(): Promise<void> {
    return this.firstEvent;
  }

  release(): void {
    this.resolveRelease();
  }
}

class FailsOnceOnReviseProvider implements AgentProvider {
  readonly name = "session";
  readonly supportsSessions = true;
  readonly calls: AgentInvocation[] = [];
  private n = 0;
  private failed = false;

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    this.calls.push(invocation);
    const token = invocation.resumeToken ?? "sess-1";
    hooks.onSessionToken?.(token);
    if (invocation.key === "__session.primary.revise" && !this.failed) {
      this.failed = true;
      throw new Error("transient revise failure");
    }
    const value = ++this.n;
    return { text: JSON.stringify({ value }), transcript: [], sessionToken: token };
  }
}

type RunMeta = { name?: string | null; target?: string | null };

class TargetedRealmKernel extends RealmKernel {
  override run<O>(
    workflow: ClientCapturedWorkflow,
    input: unknown,
    meta: RunMeta = {},
  ): Promise<RunHandle<O>> {
    return super.run<O>(workflow, input, { target: process.cwd(), ...meta });
  }

  override launch<O>(
    workflow: ClientCapturedWorkflow,
    input: unknown,
    meta: RunMeta = {},
  ): { runId: string; done: Promise<RunHandle<O>> } {
    return super.launch<O>(workflow, input, { target: process.cwd(), ...meta });
  }
}

function kernel(store: JournalStore, provider: AgentProvider, extra: Record<string, unknown> = {}) {
  return new TargetedRealmKernel(store, {
    idgen: () => "run-1",
    clock: () => 1,
    rng: () => 0.5,
    agents: new AgentProviderRegistry().register(provider),
    ...extra,
  });
}

function initGitRepo(repo: string): void {
  const g = (args: string[]) => execFileSync("git", args, { cwd: repo });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
}

describe("ctx.agentSession", () => {
  test("in-process WorkflowCtx rejects agentSession", () => {
    const ctx = new WorkflowCtx(JournalStore.memory(), "run-1", {
      clock: () => 1,
      rng: () => 0.5,
    });
    expect(() => ctx.agentSession({ key: "primary" })).toThrow(/requires the realm kernel/);
  });

  test("agent sessions reject a missing run target instead of using host cwd", async () => {
    const k = new RealmKernel(JournalStore.memory(), {
      idgen: () => "run-1",
      clock: () => 1,
      rng: () => 0.5,
      agents: new AgentProviderRegistry().register(new RecordingSessionProvider()),
    });

    await expect(k.run(WORKFLOW, { second: false })).rejects.toThrow(/requires target/);
  });

  test("session turns use the run settings snapshot after current settings change", async () => {
    const store = JournalStore.memory();
    store.putDaemonSettingRow({
      key: "agent.defaultTimeoutMs",
      valueJson: "1234",
      nowMs: 1,
    });
    const provider = new RecordingSessionProvider();
    let now = 1;
    const k = new TargetedRealmKernel(store, {
      idgen: () => "run-settings-session",
      clock: () => now,
      rng: () => 0.5,
      agents: new AgentProviderRegistry().register(provider),
    });
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const primary = ctx.agentSession({ key: "primary", provider: "session", toolPolicy: "read-only" });
          await primary.turn({ key: "one", prompt: "one" });
          await ctx.sleep("pause", 10);
          await primary.turn({ key: "two", prompt: "two" });
          return "done";
        }
      `,
      name: "settings-session",
    };

    const launched = k.launch<string>(workflow, null);
    await expect(launched.done).resolves.toMatchObject({ status: "waiting-timer" });
    expect(provider.calls.map((call) => call.timeoutMs)).toEqual([1234]);

    store.putDaemonSettingRow({
      key: "agent.defaultTimeoutMs",
      valueJson: "9999",
      nowMs: 2,
    });
    now = 20;
    await expect(k.resume<string>(launched.runId)).resolves.toMatchObject({
      status: "finished",
      output: "done",
    });
    expect(provider.calls.map((call) => call.timeoutMs)).toEqual([1234, 1234]);
  });

  test("selected providerConfig is in session identity and passed to every turn", async () => {
    const store = JournalStore.memory();
    const provider = new RecordingSessionProvider();
    const workflow = {
      source: `
        import { type Ctx, jsonSchema } from "@kcosr/keel";
        const Out = jsonSchema<{ value: number }>({
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "number" } },
        });
        export default async function wf(ctx: Ctx): Promise<number> {
          const primary = ctx.agentSession({
            key: "primary",
            provider: "session",
            providerConfig: {
              session: { transport: { type: "stdio" } },
              other: { ignored: true },
            },
          });
          const first = await primary.turn({ key: "draft", prompt: "draft", schema: Out });
          const second = await primary.turn({ key: "revise", prompt: "revise", schema: Out });
          return first.value + second.value;
        }
      `,
      name: "session-provider-config",
    };

    const handle = await kernel(store, provider).run<number>(workflow, null);
    expect(handle.status).toBe("finished");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.map((c) => c.providerConfig)).toEqual([
      { transport: { type: "stdio" } },
      { transport: { type: "stdio" } },
    ]);
    expect(Object.isFrozen(provider.calls[0]?.providerConfig)).toBe(true);
    expect(JSON.parse(store.getAgentSession("run-1", "primary")?.identityJson ?? "{}")).toEqual({
      agentKey: "primary",
      provider: "session",
      providerConfig: { transport: { type: "stdio" } },
      model: null,
      reasoning: null,
      toolPolicy: "read-only",
      allowTools: [],
      denyTools: [],
      workspaceId: "__default",
      capabilities: { fs: "read", shell: false, network: "none", secrets: [] },
      secrets: [],
    });
  });

  test("later turns resume the latest completed participant token and completed turns replay", async () => {
    const store = JournalStore.memory();
    const provider = new RecordingSessionProvider();
    const first = await kernel(store, provider).run<number>(WORKFLOW, { second: true });

    expect(first.status).toBe("finished");
    expect(first.output).toBe(3);
    expect(provider.calls.map((c) => c.key)).toEqual([
      "__session.primary.draft",
      "__session.primary.revise",
    ]);
    expect(provider.calls[0]?.resumeToken).toBeUndefined();
    expect(provider.calls[1]?.resumeToken).toBe("sess-1");
    expect(store.getAgentSession("run-1", "primary")?.currentSessionToken).toBe("sess-1");

    const replayed = await kernel(store, provider).resume<number>("run-1");
    expect(replayed.output).toBe(3);
    expect(provider.calls.length).toBe(2);
  });

  test("codex agentSession turns preserve thread id continuity", async () => {
    const store = JournalStore.memory();
    const calls: AgentInvocation[] = [];
    const provider: AgentProvider = {
      name: "codex",
      supportsSessions: true,
      async generate(invocation, hooks) {
        calls.push(invocation);
        const token = invocation.resumeToken ?? "codex-thread-1";
        hooks.onSessionToken?.(token);
        return { text: "ok", transcript: [], sessionToken: token };
      },
    };
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          const codex = ctx.agentSession({
            key: "primary",
            provider: "codex",
            toolPolicy: "unrestricted",
            providerConfig: { codex: { transport: { type: "stdio" } } },
          });
          await codex.turn({ key: "draft", prompt: "draft" });
          await codex.turn({ key: "revise", prompt: "revise" });
          return "done";
        }
      `,
      name: "codex-session",
    };

    const handle = await kernel(store, provider).run<string>(workflow, null);
    expect(handle.status).toBe("finished");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.resumeToken).toBeUndefined();
    expect(calls[1]?.resumeToken).toBe("codex-thread-1");
    expect(calls.map((c) => c.providerConfig)).toEqual([
      { transport: { type: "stdio" } },
      { transport: { type: "stdio" } },
    ]);
    expect(store.getAgentSession("run-1", "primary")?.currentSessionToken).toBe("codex-thread-1");
  });

  test("a pending later turn resumes with the token it started with", async () => {
    const store = JournalStore.memory();
    const provider = new RecordingSessionProvider();
    const crashing = kernel(store, provider, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "__session.primary.revise") {
          throw new Error("CRASH");
        }
      },
    });
    await crashing.run(WORKFLOW, { second: true }).catch(() => null);
    expect(provider.calls.length).toBe(2);
    expect(store.getRun("run-1")?.status).toBe("running");

    const resumed = await kernel(store, provider).resume<number>("run-1");
    expect(resumed.status).toBe("finished");
    expect(provider.calls.length).toBe(3);
    expect(provider.calls[2]?.key).toBe("__session.primary.revise");
    expect(provider.calls[2]?.resumeToken).toBe("sess-1");
  });

  test("retry deletes a failed session turn and re-drives it from the completed token", async () => {
    const store = JournalStore.memory();
    const provider = new FailsOnceOnReviseProvider();
    const k = kernel(store, provider);

    await k.run(WORKFLOW, { second: true }).catch(() => null);
    expect(store.getRun("run-1")?.status).toBe("failed");
    expect(store.getLatestAgentSessionTurn("run-1", "primary", "revise")?.status).toBe("failed");
    expect(store.getAgentSession("run-1", "primary")?.currentSessionToken).toBe("sess-1");

    const retried = await k.retry<number>("run-1");
    expect(retried.status).toBe("finished");
    expect(retried.output).toBe(3);
    expect(provider.calls.map((c) => c.key)).toEqual([
      "__session.primary.draft",
      "__session.primary.revise",
      "__session.primary.revise",
    ]);
    expect(provider.calls[2]?.resumeToken).toBe("sess-1");
    expect(store.getLatestAgentSessionTurn("run-1", "primary", "revise")?.status).toBe("completed");
    const failedTurns = store.db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM agent_session_turns WHERE run_id = 'run-1' AND status = 'failed'",
      )
      .get()?.c;
    expect(failedTurns).toBe(0);
  });

  test("session provider support, key validation, and missing workspace store fail closed", async () => {
    const noSession: AgentProvider = {
      name: "session",
      async generate() {
        return { text: "{}", transcript: [] };
      },
    };
    await expect(kernel(JournalStore.memory(), noSession).run(WORKFLOW, null)).rejects.toThrow(
      /does not support durable sessions/,
    );

    const badKey = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<void> {
          await ctx.agentSession({ key: "bad.key", provider: "session" }).turn({ key: "x", prompt: "x" });
        }
      `,
      name: "bad-key",
    };
    await expect(
      kernel(JournalStore.memory(), new RecordingSessionProvider()).run(badKey, null),
    ).rejects.toThrow(/must match/);

    const isolated = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<void> {
          const workspace = await ctx.workspace({ key: "p-workspace", mode: "worktree" });
          await ctx.agentSession({ key: "p", provider: "session", workspace }).turn({ key: "x", prompt: "x" });
        }
      `,
      name: "isolated",
    };
    await expect(
      kernel(JournalStore.memory(), new RecordingSessionProvider()).run(isolated, null),
    ).rejects.toThrow(/workspaceStore/);
  });

  test("worktree sessions reuse one retained workspace across turns", async () => {
    const repo = mkdtempSync(join(tmpdir(), "keel-session-target-"));
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-session-store-"));
    try {
      const g = (args: string[]) => execFileSync("git", args, { cwd: repo });
      g(["init", "-q"]);
      g(["config", "user.email", "t@t"]);
      g(["config", "user.name", "t"]);
      writeFileSync(join(repo, "seed.txt"), "seed\n");
      g(["add", "-A"]);
      g(["commit", "-q", "-m", "init"]);

      const isolated = {
        source: `
          import { type Ctx } from "@kcosr/keel";
          export default async function wf(ctx: Ctx): Promise<string> {
            const workspace = await ctx.workspace({ key: "primary-workspace", mode: "worktree", retention: "retain" });
            const primary = ctx.agentSession({ key: "primary", provider: "session", workspace, capabilities: { fs: "workspace-write" } });
            await primary.turn({ key: "draft", prompt: "draft" });
            await primary.turn({ key: "revise", prompt: "revise" });
            return "done";
          }
        `,
        name: "isolated-session",
      };
      const calls: AgentInvocation[] = [];
      const provider: AgentProvider = {
        name: "session",
        supportsSessions: true,
        async generate(invocation, hooks) {
          calls.push({ ...invocation });
          const token = invocation.resumeToken ?? "sess-1";
          hooks.onSessionToken?.(token);
          const path = join(invocation.cwd ?? "", "state.txt");
          const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
          writeFileSync(path, `${prior}${invocation.key}\n`);
          return { text: "ok", transcript: [], sessionToken: token };
        },
      };

      const store = JournalStore.memory();
      const result = await kernel(store, provider, { workspaceStore }).run<string>(isolated, null, {
        target: repo,
      });
      expect(result.status).toBe("finished");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.cwd).toBe(calls[1]?.cwd);
      expect(calls[0]?.cwd?.startsWith(workspaceStore)).toBe(true);
      const workspace = store.listAgentWorkspaces("run-1")[0];
      expect(workspace).toMatchObject({
        sourcePath: repo,
        status: "pending_review",
        ownerKind: "workflow",
        key: "primary-workspace",
      });
      expect(workspace?.workspacePath).toBe(calls[0]?.cwd);
      expect(readFileSync(join(workspace?.workspacePath ?? "", "state.txt"), "utf8")).toContain(
        "__session.primary.draft\n__session.primary.revise\n",
      );
      expect(existsSync(join(repo, "state.txt"))).toBe(false);
      const diffEvents = store.listEvents("run-1").filter((e) => e.type === "agent.diff");
      expect(diffEvents).toHaveLength(2);
      expect(JSON.parse(diffEvents[0]?.payloadJson ?? "{}")).toMatchObject({
        workspaceId: store.listAgentWorkspaces("run-1")[0]?.workspaceId,
        agentKey: "primary",
      });

      const replayed = await kernel(store, provider, { workspaceStore }).resume<string>("run-1");
      expect(replayed.output).toBe("done");
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(workspaceStore, { recursive: true, force: true });
    }
  });

  test("two worktree participants can use different repositories", async () => {
    const repoA = mkdtempSync(join(tmpdir(), "keel-session-target-a-"));
    const repoB = mkdtempSync(join(tmpdir(), "keel-session-target-b-"));
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-session-store-multi-"));
    try {
      initGitRepo(repoA);
      initGitRepo(repoB);
      const workflow = {
        source: `
          import { type Ctx } from "@kcosr/keel";
          export default async function wf(ctx: Ctx, input: { a: string; b: string }): Promise<string> {
            const workspaceA = await ctx.workspace({ key: "a-workspace", mode: "worktree", path: input.a, retention: "retain" });
            const workspaceB = await ctx.workspace({ key: "b-workspace", mode: "worktree", path: input.b, retention: "retain" });
            await ctx.agentSession({ key: "a", provider: "session", workspace: workspaceA, capabilities: { fs: "workspace-write" } }).turn({ key: "one", prompt: "one" });
            await ctx.agentSession({ key: "b", provider: "session", workspace: workspaceB, capabilities: { fs: "workspace-write" } }).turn({ key: "one", prompt: "one" });
            return "done";
          }
        `,
        name: "isolated-session-multi-target",
      };
      const provider: AgentProvider = {
        name: "session",
        supportsSessions: true,
        async generate(invocation, hooks) {
          const token = invocation.resumeToken ?? `${invocation.key}-token`;
          hooks.onSessionToken?.(token);
          writeFileSync(join(invocation.cwd ?? "", "owner.txt"), `${invocation.key}\n`);
          return { text: "ok", transcript: [], sessionToken: token };
        },
      };
      const store = JournalStore.memory();
      const result = await kernel(store, provider, { workspaceStore }).run<string>(
        workflow,
        { a: repoA, b: repoB },
        { target: repoA },
      );
      expect(result.status).toBe("finished");
      const rows = store.listAgentWorkspaces("run-1");
      const a = rows.find((row) => row.key === "a-workspace");
      const b = rows.find((row) => row.key === "b-workspace");
      expect(a?.sourcePath).toBe(repoA);
      expect(b?.sourcePath).toBe(repoB);
      expect(a?.workspacePath).not.toBe(b?.workspacePath);
      expect(readFileSync(join(a?.workspacePath ?? "", "owner.txt"), "utf8")).toBe(
        "__session.a.one\n",
      );
      expect(readFileSync(join(b?.workspacePath ?? "", "owner.txt"), "utf8")).toBe(
        "__session.b.one\n",
      );
      expect(existsSync(join(repoA, "owner.txt"))).toBe(false);
      expect(existsSync(join(repoB, "owner.txt"))).toBe(false);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
      rmSync(workspaceStore, { recursive: true, force: true });
    }
  });

  test("retry reuses the retained isolated workspace", async () => {
    const repo = mkdtempSync(join(tmpdir(), "keel-session-retry-target-"));
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-session-retry-store-"));
    try {
      initGitRepo(repo);
      const workflow = {
        source: `
          import { type Ctx } from "@kcosr/keel";
          export default async function wf(ctx: Ctx): Promise<string> {
            const workspace = await ctx.workspace({ key: "primary-workspace", mode: "worktree", retention: "retain" });
            const primary = ctx.agentSession({ key: "primary", provider: "session", workspace, capabilities: { fs: "workspace-write" } });
            await primary.turn({ key: "draft", prompt: "draft" });
            await primary.turn({ key: "revise", prompt: "revise" });
            return "done";
          }
        `,
        name: "isolated-retry",
      };
      const calls: AgentInvocation[] = [];
      let failed = false;
      const provider: AgentProvider = {
        name: "session",
        supportsSessions: true,
        async generate(invocation, hooks) {
          calls.push({ ...invocation });
          const token = invocation.resumeToken ?? "sess-1";
          hooks.onSessionToken?.(token);
          const state = join(invocation.cwd ?? "", "state.txt");
          const prior = existsSync(state) ? readFileSync(state, "utf8") : "";
          writeFileSync(state, `${prior}${invocation.key}\n`);
          if (invocation.key === "__session.primary.revise" && !failed) {
            failed = true;
            throw new Error("transient failure");
          }
          return { text: "ok", transcript: [], sessionToken: token };
        },
      };
      const store = JournalStore.memory();
      await kernel(store, provider, { workspaceStore })
        .run<string>(workflow, null, { target: repo })
        .catch(() => null);
      expect(store.getRun("run-1")?.status).toBe("failed");
      const failedWorkspace = store.listAgentWorkspaces("run-1")[0];
      expect(failedWorkspace?.status).toBe("pending_review");

      const retried = await kernel(store, provider, { workspaceStore }).retry<string>("run-1");
      expect(retried.status).toBe("finished");
      const workspace = store.listAgentWorkspaces("run-1")[0];
      expect(workspace?.workspacePath).toBe(failedWorkspace?.workspacePath);
      expect(readFileSync(join(workspace?.workspacePath ?? "", "state.txt"), "utf8")).toBe(
        "__session.primary.draft\n__session.primary.revise\n__session.primary.revise\n",
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(workspaceStore, { recursive: true, force: true });
    }
  });

  test("retry fails closed when a session workspace was removed by terminal cleanup", async () => {
    const repo = mkdtempSync(join(tmpdir(), "keel-session-removed-target-"));
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-session-removed-store-"));
    try {
      initGitRepo(repo);
      const workflow = {
        source: `
          import { type Ctx } from "@kcosr/keel";
          export default async function wf(ctx: Ctx): Promise<string> {
            const workspace = await ctx.workspace({ key: "primary-workspace", mode: "worktree" });
            const primary = ctx.agentSession({ key: "primary", provider: "session", workspace, capabilities: { fs: "workspace-write" } });
            await primary.turn({ key: "draft", prompt: "draft" });
            await primary.turn({ key: "revise", prompt: "revise" });
            return "done";
          }
        `,
        name: "removed-session-workspace-retry",
      };
      let failed = false;
      const provider: AgentProvider = {
        name: "session",
        supportsSessions: true,
        async generate(invocation, hooks) {
          const token = invocation.resumeToken ?? "sess-1";
          hooks.onSessionToken?.(token);
          if (invocation.key === "__session.primary.revise" && !failed) {
            failed = true;
            throw new Error("transient failure");
          }
          return { text: "ok", transcript: [], sessionToken: token };
        },
      };
      const store = JournalStore.memory();
      await kernel(store, provider, { workspaceStore })
        .run<string>(workflow, null, { target: repo })
        .catch(() => null);
      expect(store.getRun("run-1")?.status).toBe("failed");
      expect(store.listAgentWorkspaces("run-1", { includeRemoved: true })[0]?.status).toBe(
        "removed",
      );

      await expect(
        kernel(store, provider, { workspaceStore }).retry<string>("run-1"),
      ).rejects.toThrow(/referenced by an existing agent session/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(workspaceStore, { recursive: true, force: true });
    }
  });

  test("on-failure retention stays sticky when a later session turn succeeds", async () => {
    const repo = mkdtempSync(join(tmpdir(), "keel-session-sticky-failure-target-"));
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-session-sticky-failure-store-"));
    try {
      initGitRepo(repo);
      const workflow = {
        source: `
          import { type Ctx } from "@kcosr/keel";
          export default async function wf(ctx: Ctx): Promise<string> {
            const workspace = await ctx.workspace({ key: "primary-workspace", mode: "worktree", retention: "retain-on-failure" });
            const primary = ctx.agentSession({ key: "primary", provider: "session", workspace, capabilities: { fs: "workspace-write" } });
            await primary.turn({ key: "optional", prompt: "optional", onFailure: "null" });
            await primary.turn({ key: "repair", prompt: "repair" });
            return "done";
          }
        `,
        name: "isolated-sticky-session-failure",
      };
      const provider: AgentProvider = {
        name: "session",
        supportsSessions: true,
        async generate(invocation, hooks) {
          const token = invocation.resumeToken ?? "sess-1";
          hooks.onSessionToken?.(token);
          if (invocation.cwd) {
            writeFileSync(join(invocation.cwd, `${invocation.key}.txt`), `${invocation.key}\n`);
          }
          if (invocation.key === "__session.primary.optional") {
            throw new AgentFailure("optional failure");
          }
          return { text: "ok", transcript: [], sessionToken: token };
        },
      };

      const store = JournalStore.memory();
      const result = await kernel(store, provider, { workspaceStore }).run<string>(workflow, null, {
        target: repo,
      });
      expect(result.status).toBe("finished");
      const workspace = store.listAgentWorkspaces("run-1")[0];
      expect(workspace).toMatchObject({
        ownerKind: "workflow",
        key: "primary-workspace",
        status: "pending_review",
        failureSeen: true,
        retentionPolicy: "retain-on-failure",
      });
      expect(
        readFileSync(
          join(workspace?.workspacePath ?? "", "__session.primary.optional.txt"),
          "utf8",
        ),
      ).toBe("__session.primary.optional\n");
      expect(
        readFileSync(join(workspace?.workspacePath ?? "", "__session.primary.repair.txt"), "utf8"),
      ).toBe("__session.primary.repair\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(workspaceStore, { recursive: true, force: true });
    }
  });

  test("oversized retained workspace diffs become explicit diff_error events", async () => {
    const repo = mkdtempSync(join(tmpdir(), "keel-session-large-diff-target-"));
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-session-large-diff-store-"));
    try {
      initGitRepo(repo);
      const workflow = {
        source: `
          import { type Ctx } from "@kcosr/keel";
          export default async function wf(ctx: Ctx): Promise<string> {
            const workspace = await ctx.workspace({ key: "primary-workspace", mode: "worktree", retention: "retain" });
            const primary = ctx.agentSession({ key: "primary", provider: "session", workspace, capabilities: { fs: "workspace-write" } });
            await primary.turn({ key: "huge", prompt: "huge" });
            return "done";
          }
        `,
        name: "isolated-large-diff",
      };
      const provider: AgentProvider = {
        name: "session",
        supportsSessions: true,
        async generate(invocation, hooks) {
          const token = invocation.resumeToken ?? "sess-1";
          hooks.onSessionToken?.(token);
          writeFileSync(
            join(invocation.cwd ?? "", "seed.txt"),
            `${"z".repeat(GIT_DIFF_MAX_BUFFER_BYTES + 64 * 1024)}\n`,
          );
          return { text: "ok", transcript: [], sessionToken: token };
        },
      };

      const store = JournalStore.memory();
      const result = await kernel(store, provider, { workspaceStore }).run<string>(workflow, null, {
        target: repo,
      });

      expect(result.status).toBe("finished");
      const workspace = store.listAgentWorkspaces("run-1")[0];
      expect(workspace?.status).toBe("diff_error");
      const events = store.listEvents("run-1");
      expect(events.some((e) => e.type === "agent.diff")).toBe(false);
      const diffError = events.find((e) => e.type === "workspace.diff_error");
      const diffErrorPayload = JSON.parse(diffError?.payloadJson ?? "{}");
      expect(diffErrorPayload).toMatchObject({
        workspaceId: store.listAgentWorkspaces("run-1")[0]?.workspaceId,
        agentKey: "primary",
      });
      expect(diffError?.payloadJson).toContain("git diff output exceeded explicit");
      expect(diffError?.payloadJson).toContain(String(GIT_DIFF_MAX_BUFFER_BYTES));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(workspaceStore, { recursive: true, force: true });
    }
  });

  test("a later turn can continue after diff_error while preserving diagnostics", async () => {
    const repo = mkdtempSync(join(tmpdir(), "keel-session-diff-error-target-"));
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-session-diff-error-store-"));
    try {
      initGitRepo(repo);
      const workflow = {
        source: `
          import { type Ctx } from "@kcosr/keel";
          export default async function wf(ctx: Ctx): Promise<string> {
            const workspace = await ctx.workspace({ key: "primary-workspace", mode: "worktree", retention: "retain" });
            const primary = ctx.agentSession({ key: "primary", provider: "session", workspace, capabilities: { fs: "workspace-write" } });
            await primary.turn({ key: "break", prompt: "break" });
            await primary.turn({ key: "repair", prompt: "repair" });
            return "done";
          }
        `,
        name: "isolated-diff-error",
      };
      let first = true;
      const provider: AgentProvider = {
        name: "session",
        supportsSessions: true,
        async generate(invocation, hooks) {
          const token = invocation.resumeToken ?? "sess-1";
          hooks.onSessionToken?.(token);
          const gitFile = join(invocation.cwd ?? "", ".git");
          const backup = join(invocation.cwd ?? "", ".git.bak");
          if (first) {
            first = false;
            renameSync(gitFile, backup);
          } else {
            renameSync(backup, gitFile);
            writeFileSync(join(invocation.cwd ?? "", "repaired.txt"), "ok\n");
          }
          return { text: "ok", transcript: [], sessionToken: token };
        },
      };

      const store = JournalStore.memory();
      const result = await kernel(store, provider, { workspaceStore }).run<string>(workflow, null, {
        target: repo,
      });
      expect(result.status).toBe("finished");
      const workspace = store.listAgentWorkspaces("run-1")[0];
      expect(workspace?.status).toBe("pending_review");
      expect(typeof workspace?.lastErrorEventSeq).toBe("number");
      expect(typeof workspace?.lastDiffEventSeq).toBe("number");
      expect(workspace?.lastDiffEventSeq).toBeGreaterThan(workspace?.lastErrorEventSeq ?? 0);
      const events = store.listEvents("run-1");
      expect(events.map((e) => e.type)).toContain("workspace.diff_error");
      expect(events.filter((e) => e.type === "agent.diff")).toHaveLength(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(workspaceStore, { recursive: true, force: true });
    }
  });

  test("participant identity drift fails closed before provider execution", async () => {
    const store = JournalStore.memory();
    const provider = new RecordingSessionProvider();
    const crashing = kernel(store, provider, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "__session.primary.revise") {
          throw new Error("CRASH");
        }
      },
    });
    await crashing.run(WORKFLOW, { second: true }).catch(() => null);
    expect(provider.calls.length).toBe(2);

    store.db
      .query("UPDATE agent_sessions SET identity_hash = 'changed' WHERE run_id = 'run-1'")
      .run();
    await expect(kernel(store, provider).resume("run-1")).rejects.toThrow(/identity changed/);
    expect(provider.calls.length).toBe(2);
  });

  test("turn identity drift fails closed before provider execution", async () => {
    const store = JournalStore.memory();
    const provider = new RecordingSessionProvider();
    const crashing = kernel(store, provider, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "__session.primary.revise") {
          throw new Error("CRASH");
        }
      },
    });
    await crashing.run(WORKFLOW, { second: true }).catch(() => null);
    expect(provider.calls.length).toBe(2);

    const identity = store.getAgentSession("run-1", "primary")?.identityHash ?? "";
    store.db
      .query("UPDATE agent_sessions SET identity_hash = ? WHERE run_id = 'run-1'")
      .run(identity);
    store.db
      .query(
        "UPDATE journal SET version = 'changed' WHERE run_id = 'run-1' AND stable_key = '__session.primary.draft'",
      )
      .run();
    await expect(kernel(store, provider).resume("run-1")).rejects.toThrow(
      /turn "draft" identity changed/,
    );
    expect(provider.calls.length).toBe(2);
  });

  test("concurrent turns on one participant are rejected", async () => {
    const store = JournalStore.memory();
    const concurrent = {
      source: `
        import { type Ctx, jsonSchema } from "@kcosr/keel";
        const Out = jsonSchema<{ value: number }>({
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "number" } },
        });
        export default async function wf(ctx: Ctx): Promise<number> {
          const primary = ctx.agentSession({ key: "primary", provider: "session" });
          const [a, b] = await Promise.all([
            primary.turn({ key: "a", prompt: "a", schema: Out }),
            primary.turn({ key: "b", prompt: "b", schema: Out }),
          ]);
          return a.value + b.value;
        }
      `,
      name: "concurrent",
    };
    await expect(
      kernel(store, new RecordingSessionProvider(50)).run(concurrent, null),
    ).rejects.toThrow(/already has active turn/);
    await Bun.sleep(100);
    expect(store.getAgentSession("run-1", "primary")?.currentSessionToken).toBeNull();
  });

  test("a session provider that does not report a token cannot complete a turn", async () => {
    const silent: AgentProvider = {
      name: "session",
      supportsSessions: true,
      async generate() {
        return { text: '{"value":1}', transcript: [] };
      },
    };
    await expect(
      kernel(JournalStore.memory(), silent).run(WORKFLOW, { second: false }),
    ).rejects.toThrow(/completed without a session token/);
  });

  test("onFailure null can complete only after a session token was captured", async () => {
    const tolerant = {
      source: `
        import { type Ctx, jsonSchema } from "@kcosr/keel";
        const Out = jsonSchema<{ value: number }>({
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "number" } },
        });
        export default async function wf(ctx: Ctx): Promise<{ value: number } | null> {
          const primary = ctx.agentSession({ key: "primary", provider: "session" });
          return await primary.turn({
            key: "draft",
            prompt: "draft",
            schema: Out,
            onFailure: "null",
            maxRetries: 0,
          });
        }
      `,
      name: "tolerant-session",
    };
    const invalidWithToken: AgentProvider = {
      name: "session",
      supportsSessions: true,
      async generate(_invocation, hooks) {
        hooks.onSessionToken?.("sess-1");
        return { text: '{"wrong":true}', transcript: [], sessionToken: "sess-1" };
      },
    };
    const finished = await kernel(JournalStore.memory(), invalidWithToken).run(tolerant, null);
    expect(finished.status).toBe("finished");
    expect(finished.output).toBeNull();

    const invalidWithoutToken: AgentProvider = {
      name: "session",
      supportsSessions: true,
      async generate() {
        return { text: '{"wrong":true}', transcript: [] };
      },
    };
    await expect(
      kernel(JournalStore.memory(), invalidWithoutToken).run(tolerant, null),
    ).rejects.toThrow(/completed without a session token/);
  });

  test("a new later turn fails closed when the current session token is missing", async () => {
    const waitThenContinue = {
      source: `
        import { type Ctx, jsonSchema } from "@kcosr/keel";
        const Out = jsonSchema<{ value: number }>({
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "number" } },
        });
        export default async function wf(ctx: Ctx): Promise<number> {
          const primary = ctx.agentSession({ key: "primary", provider: "session" });
          await primary.turn({ key: "draft", prompt: "draft", schema: Out });
          await ctx.signal("go");
          const second = await primary.turn({ key: "revise", prompt: "revise", schema: Out });
          return second.value;
        }
      `,
      name: "missing-token-later-turn",
    };
    const store = JournalStore.memory();
    const provider = new RecordingSessionProvider();
    const k = kernel(store, provider);
    const parked = await k.run(waitThenContinue, null);
    expect(parked.status).toBe("waiting-signal");
    expect(provider.calls).toHaveLength(1);

    store.db
      .query("UPDATE agent_sessions SET current_session_token = NULL WHERE run_id = 'run-1'")
      .run();
    store.putSignal("run-1", "go", {}, 1);
    await expect(k.resume("run-1")).rejects.toThrow(/no current session token/);
    expect(provider.calls).toHaveLength(1);
  });

  test("resume uses a workspace persisted path and retention policy", async () => {
    const repo = mkdtempSync(join(tmpdir(), "keel-session-migrated-target-"));
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-session-migrated-store-"));
    try {
      initGitRepo(repo);
      const waitThenContinue = {
        source: `
          import { type Ctx } from "@kcosr/keel";
          export default async function wf(ctx: Ctx): Promise<string> {
            const workspace = await ctx.workspace({ key: "primary-workspace", mode: "worktree", retention: "retain" });
            const primary = ctx.agentSession({
              key: "primary",
              provider: "session",
              workspace,
              capabilities: { fs: "workspace-write" },
            });
            await primary.turn({ key: "draft", prompt: "draft" });
            await ctx.signal("go");
            await primary.turn({ key: "revise", prompt: "revise" });
            return "done";
          }
        `,
        name: "migrated-isolated-session",
      };
      const calls: AgentInvocation[] = [];
      const provider: AgentProvider = {
        name: "session",
        supportsSessions: true,
        async generate(invocation, hooks) {
          calls.push({ ...invocation });
          const token = invocation.resumeToken ?? "sess-1";
          hooks.onSessionToken?.(token);
          const state = join(invocation.cwd ?? "", "state.txt");
          const prior = existsSync(state) ? readFileSync(state, "utf8") : "";
          writeFileSync(state, `${prior}${invocation.key}\n`);
          return { text: "ok", transcript: [], sessionToken: token };
        },
      };

      const store = JournalStore.memory();
      const k = kernel(store, provider, { workspaceStore });
      const parked = await k.run<string>(waitThenContinue, null, { target: repo });
      expect(parked.status).toBe("waiting-signal");
      expect(calls).toHaveLength(1);
      const workspace = store.listAgentWorkspaces("run-1")[0];
      if (!workspace) throw new Error("missing workspace row");
      const migratedPath = join(workspaceStore, "run-1", "primary");
      renameSync(workspace.workspacePath, migratedPath);
      store.db
        .query(
          "UPDATE agent_workspaces SET workspace_path = ?, retention_policy = 'retain' WHERE run_id = ? AND workspace_id = ?",
        )
        .run(migratedPath, "run-1", workspace.workspaceId);

      store.putSignal("run-1", "go", {}, 1);
      const resumed = await k.resume<string>("run-1");
      expect(resumed.status).toBe("finished");
      expect(resumed.output).toBe("done");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.cwd).toBe(migratedPath);
      expect(readFileSync(join(migratedPath, "state.txt"), "utf8")).toBe(
        "__session.primary.draft\n__session.primary.revise\n",
      );
      expect(store.getAgentWorkspace("run-1", workspace.workspaceId)).toMatchObject({
        workspacePath: migratedPath,
        retentionPolicy: "retain",
        status: "pending_review",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(workspaceStore, { recursive: true, force: true });
    }
  });

  test("a resumed turn fails if the provider reports a different token", async () => {
    const mismatch: AgentProvider = {
      name: "session",
      supportsSessions: true,
      async generate(invocation, hooks) {
        const token = invocation.resumeToken ? "different-token" : "sess-1";
        hooks.onSessionToken?.(token);
        return { text: '{"value":1}', transcript: [], sessionToken: token };
      },
    };
    await expect(
      kernel(JournalStore.memory(), mismatch).run(WORKFLOW, { second: true }),
    ).rejects.toThrow(/resumed with token/);
  });

  test("duplicate resumes of a pending session run are fenced in one kernel", async () => {
    const store = JournalStore.memory();
    const provider = new RecordingSessionProvider(80);
    const crashing = kernel(store, provider, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "__session.primary.revise") {
          throw new Error("CRASH");
        }
      },
    });
    await crashing.run(WORKFLOW, { second: true }).catch(() => null);

    const k = kernel(store, provider);
    const results = await Promise.allSettled([k.resume("run-1"), k.resume("run-1")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results.some(
        (r) => r.status === "rejected" && String(r.reason).includes("already executing"),
      ),
    ).toBe(true);
  });

  test("session turn tool calls are durable before turn completion", async () => {
    const store = JournalStore.memory();
    const provider = new StreamingSessionProvider();
    const { runId, done } = kernel(store, provider).launch(WORKFLOW, { second: false });

    await provider.waitForFirstEvent();
    expect(store.getJournalRow(runId, "__session.primary.draft", 1)?.status).toBe("pending");
    expect(
      store
        .listEvents(runId)
        .filter((e) => e.type === "agent.tool_call")
        .map((e) => JSON.parse(e.payloadJson)),
    ).toEqual([
      {
        key: "__session.primary.draft",
        attempt: 1,
        toolCallId: "session-call-1",
        data: { name: "Read", args: { file: "a.ts" } },
      },
    ]);

    provider.release();
    const finished = await done;
    expect(finished.status).toBe("finished");
    expect(
      store
        .listEvents(runId)
        .filter((e) => e.type.startsWith("agent."))
        .map((e) => ({ type: e.type, payload: JSON.parse(e.payloadJson) })),
    ).toEqual([
      {
        type: "agent.tool_call",
        payload: {
          key: "__session.primary.draft",
          attempt: 1,
          toolCallId: "session-call-1",
          data: { name: "Read", args: { file: "a.ts" } },
        },
      },
      {
        type: "agent.tool_result",
        payload: {
          key: "__session.primary.draft",
          attempt: 1,
          toolCallId: "session-call-1",
          data: { output: "ok" },
        },
      },
      {
        type: "agent.message",
        payload: { key: "__session.primary.draft", attempt: 1, text: '{"value":1}' },
      },
    ]);
  });

  test("tool rows survive a pre-completion crash and repeated resume observations", async () => {
    const store = JournalStore.memory();
    const provider = new StreamingSessionProvider();
    let crash = true;
    const crashing = kernel(store, provider, {
      fault: (point: string, key: string) => {
        if (crash && point === "before-commit" && key === "__session.primary.draft") {
          crash = false;
          throw new Error("CRASH after tool rows");
        }
      },
    });
    const { runId, done } = crashing.launch(WORKFLOW, { second: false });

    await provider.waitForFirstEvent();
    provider.release();
    await done.catch(() => null);
    expect(store.getRun(runId)?.status).toBe("running");
    expect(store.getJournalRow(runId, "__session.primary.draft", 1)?.status).toBe("pending");
    expect(
      store
        .listEvents(runId)
        .filter((e) => e.type === "agent.tool_call")
        .map((e) => JSON.parse(e.payloadJson)),
    ).toEqual([
      {
        key: "__session.primary.draft",
        attempt: 1,
        toolCallId: "session-call-1",
        data: { name: "Read", args: { file: "a.ts" } },
      },
    ]);

    const resumed = await kernel(store, provider).resume<number>(runId);
    expect(resumed.status).toBe("finished");
    expect(resumed.output).toBe(1);
    expect(provider.calls).toHaveLength(2);

    expect(
      store
        .listEvents(runId)
        .filter((e) => e.type.startsWith("agent."))
        .map((e) => ({ type: e.type, payload: JSON.parse(e.payloadJson) })),
    ).toEqual([
      {
        type: "agent.tool_call",
        payload: {
          key: "__session.primary.draft",
          attempt: 1,
          toolCallId: "session-call-1",
          data: { name: "Read", args: { file: "a.ts" } },
        },
      },
      {
        type: "agent.tool_result",
        payload: {
          key: "__session.primary.draft",
          attempt: 1,
          toolCallId: "session-call-1",
          data: { output: "ok" },
        },
      },
      {
        type: "agent.tool_call",
        payload: {
          key: "__session.primary.draft",
          attempt: 1,
          toolCallId: "session-call-1",
          data: { name: "Read", args: { file: "a.ts" } },
        },
      },
      {
        type: "agent.tool_result",
        payload: {
          key: "__session.primary.draft",
          attempt: 1,
          toolCallId: "session-call-1",
          data: { output: "ok" },
        },
      },
      {
        type: "agent.message",
        payload: { key: "__session.primary.draft", attempt: 1, text: '{"value":1}' },
      },
    ]);

    const replayed = await kernel(store, provider).resume<number>(runId);
    expect(replayed.output).toBe(1);
    expect(provider.calls).toHaveLength(2);
  });

  test("session-token events are not journaled", async () => {
    const store = JournalStore.memory();
    await kernel(store, new RecordingSessionProvider()).run(WORKFLOW, { second: false });

    const events = store.listEvents("run-1").map((e) => ({
      type: e.type,
      payload: JSON.parse(e.payloadJson),
    }));
    expect(JSON.stringify(events)).not.toContain("sess-1");
    expect(events.some((e) => e.type === "agent.event")).toBe(false);
  });

  test("rewind, rerun, and fork reject runs that used durable agent sessions", async () => {
    const store = JournalStore.memory();
    const k = kernel(store, new RecordingSessionProvider());
    await k.run(WORKFLOW, { second: false });

    await expect(k.rerun("run-1")).rejects.toThrow(/cannot be rerun/);
    await expect(k.rewind("run-1", "__session.primary.draft")).rejects.toThrow(/cannot be rewound/);
    expect(() => k.fork("run-1", { newRunId: "forked" })).toThrow(/cannot be forked/);
  });

  test("continueAsNew successor starts without inherited agent session rows", async () => {
    const chain = {
      source: `
        import { type Ctx, jsonSchema } from "@kcosr/keel";
        const Out = jsonSchema<{ value: number }>({
          type: "object",
          additionalProperties: false,
          required: ["value"],
          properties: { value: { type: "number" } },
        });
        export default async function wf(ctx: Ctx, input: { count: number }): Promise<number> {
          if (input.count > 0) return 9;
          const primary = ctx.agentSession({ key: "primary", provider: "session" });
          await primary.turn({ key: "draft", prompt: "draft", schema: Out });
          await ctx.continueAsNew({ count: 1 });
        }
      `,
      name: "session-continue",
    };
    const store = JournalStore.memory();
    const provider = new RecordingSessionProvider();
    let n = 0;
    const k = new TargetedRealmKernel(store, {
      idgen: () => `chain-${n++}`,
      clock: () => 1,
      rng: () => 0.5,
      agents: new AgentProviderRegistry().register(provider),
    });

    const first = await k.run<{ continuedTo: string }>(chain, { count: 0 });
    expect(first.status).toBe("continued");
    expect(first.output?.continuedTo).toBe("chain-1");
    await until(() => store.getRun("chain-1")?.status === "finished", 4000);
    expect(store.hasAgentSessions("chain-0")).toBe(true);
    expect(store.hasAgentSessions("chain-1")).toBe(false);
    expect(
      store.db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) AS c FROM agent_session_turns WHERE run_id = 'chain-1'",
        )
        .get()?.c,
    ).toBe(0);
  });
});

async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition did not settle in time");
}

const LIVE = process.env.KEEL_LIVE === "1";

function liveContinuityWorkflow(provider: "claude" | "pi", toolPolicy: "none" | "read-only") {
  return {
    source: `
      import { type Ctx, jsonSchema } from "@kcosr/keel";
      const Ack = jsonSchema<{ ok: boolean }>({
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      });
      const Recall = jsonSchema<{ code: string }>({
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: { code: { type: "string" } },
      });
      export default async function wf(ctx: Ctx, input: { code: string }): Promise<string> {
        const agent = ctx.agentSession({
          key: "primary",
          provider: "${provider}",
          toolPolicy: "${toolPolicy}",
        });
        await agent.turn({
          key: "remember",
          prompt: "Remember this exact code word for a later question in this same conversation: " + input.code + ". Return ONLY this JSON: {\\\"ok\\\":true}",
          schema: Ack,
        });
        const recalled = await agent.turn({
          key: "recall",
          prompt: "What exact code word did I ask you to remember earlier in this conversation? Return ONLY one JSON object with exactly one string field named code.",
          schema: Recall,
        });
        return recalled.code;
      }
    `,
    name: `live-${provider}-session-continuity`,
  };
}

function liveKernel(provider: AgentProvider, calls: AgentInvocation[]) {
  return new TargetedRealmKernel(JournalStore.memory(), {
    idgen: () => "live-run",
    agents: new AgentProviderRegistry().register({
      name: provider.name,
      supportsSessions: provider.supportsSessions,
      generate(invocation, hooks) {
        calls.push({ ...invocation });
        return provider.generate(invocation, hooks);
      },
    }),
  });
}

describe.if(LIVE)("LIVE ctx.agentSession backend continuity", () => {
  test("Claude recalls a first-turn code word only available through backend session resume", async () => {
    const { ClaudeProvider } = await import("../../agents/claude.ts");
    const calls: AgentInvocation[] = [];
    const code = `keelclaude${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const k = liveKernel(new ClaudeProvider({ timeoutMs: 120_000 }), calls);
    const result = await k.run<string>(liveContinuityWorkflow("claude", "none"), { code });

    expect(result.status).toBe("finished");
    expect(result.output).toBe(code);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.resumeToken).toBeUndefined();
    expect(calls[1]?.resumeToken).toBeTruthy();
    const replay = await k.resume<string>("live-run");
    expect(replay.output).toBe(code);
    expect(calls).toHaveLength(2);
  }, 260_000);

  test("Codex/Pi recalls a first-turn code word only available through backend session resume", async () => {
    const { PiProvider } = await import("../../agents/pi.ts");
    const calls: AgentInvocation[] = [];
    const code = `keelcodex${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const k = liveKernel(new PiProvider({ timeoutMs: 120_000 }), calls);
    const result = await k.run<string>(liveContinuityWorkflow("pi", "read-only"), { code });

    expect(result.status).toBe("finished");
    expect(result.output).toBe(code);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.resumeToken).toBeUndefined();
    expect(calls[1]?.resumeToken).toBeTruthy();
    const replay = await k.resume<string>("live-run");
    expect(replay.output).toBe(code);
    expect(calls).toHaveLength(2);
  }, 260_000);
});
