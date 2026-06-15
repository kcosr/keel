// Realm-host Phase 15 hardening: fail-closed explicit isolation, durable diffs,
// trusted-local secret env injection, worktree cleanup, and secret lifecycle.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { GIT_DIFF_MAX_BUFFER_BYTES } from "../../workspace/worktree.ts";
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
      /git repository root/,
    );
    rmSync(target, { recursive: true, force: true });
    expect(called).toBe(false); // provider never invoked — failed closed
    expect(store.getRun("r")?.status).toBe("failed");
  });

  test("workspaceRetention requires workspaceIsolation", async () => {
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
      /workspaceRetention requires workspaceIsolation/,
    );
  });

  test("an explicitly allowed shell tool does not imply workspace isolation", async () => {
    const store = JournalStore.memory();
    let called = false;
    const provider: AgentProvider = {
      name: "writer",
      async generate(): Promise<AgentResult> {
        called = true;
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
    expect(called).toBe(true);
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
    expect(store.listAgentWorkspaces("r", { includeRemoved: true })[0]?.status).toBe("removed");
  });

  test("workspaceRetention always keeps a one-shot success workspace for review", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          return await ctx.agent({
            key: "edit",
            prompt: "make a change",
            provider: "writer",
            workspaceIsolation: true,
            workspaceRetention: "always",
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
    expect(workspace).toMatchObject({ kind: "agent", key: "edit", status: "pending_review" });
    expect(existsSync(workspace?.workspacePath ?? "")).toBe(true);
  });

  test("workspaceRetention on-failure keeps a one-shot workspace after fail-then-retry-success", async () => {
    const store = JournalStore.memory();
    const workflow = {
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx): Promise<string> {
          return await ctx.agent({
            key: "edit",
            prompt: "make a change",
            provider: "writer",
            workspaceIsolation: true,
            workspaceRetention: "on-failure",
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
          return await ctx.agent({
            key: "edit",
            prompt: "make a change",
            provider: "writer",
            workspaceIsolation: true,
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
    expect(store.listAgentWorkspaces("r", { includeRemoved: true })[0]?.status).toBe("removed");
    expect(firstCwd ? existsSync(firstCwd) : true).toBe(false);

    const retried = await kernel.retry<string>("r");
    expect(retried.status).toBe("finished");
    expect(retried.output).toBe("ok");
    expect(calls).toBe(2);
    expect(secondSawFirstAttempt).toBe(false);
    expect(store.listAgentWorkspaces("r", { includeRemoved: true })[0]?.status).toBe("removed");
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
