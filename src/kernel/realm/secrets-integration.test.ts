// Trusted-local secret side channel: named refs are injected as provider env, while
// agent outputs/events/errors are journaled as ordinary data.

import { describe, expect, test } from "bun:test";
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
import { RealmKernel } from "./realm-host.ts";

const url = captureWorkflowFile(new URL("./fixtures/secret.workflow.ts", import.meta.url).pathname);

/** A provider that echoes whatever secret env it was injected with. */
const echoProvider: AgentProvider = {
  name: "mock",
  async generate(inv: AgentInvocation): Promise<AgentResult> {
    return { text: `the token is ${inv.env?.TOKEN ?? "<none>"}`, transcript: [] };
  },
};

const SESSION_SECRET_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string> {
      const primary = ctx.agentSession({
        key: "primary",
        provider: "session",
        capabilities: { fs: "workspace-write", shell: true, secrets: ["TOKEN"] },
        allowTools: ["mcp__local__edit"],
        environment: { secrets: ["TOKEN"] },
      });
      return await primary.turn({ key: "draft", prompt: "draft" });
    }
  `,
  name: "session-secret",
};

const TOLERATED_FAILURE_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string> {
      const value = await ctx.agent({
        key: "maybe",
        prompt: "p",
        provider: "mock",
        capabilities: { secrets: ["TOKEN"] },
        environment: { secrets: ["TOKEN"] },
        onFailure: "null",
        maxRetries: 0,
      });
      return value === null ? "tolerated" : String(value);
    }
  `,
  name: "tolerated-secret",
};

const ISOLATED_SESSION_SECRET_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string> {
      const workspace = await ctx.workspace({ key: "primary-workspace", mode: "worktree", retention: "retain" });
      const primary = ctx.agentSession({
        key: "primary",
        provider: "session",
        workspace,
        capabilities: { fs: "workspace-write", secrets: ["TOKEN"] },
        environment: { secrets: ["TOKEN"] },
      });
      return await primary.turn({ key: "draft", prompt: "draft" });
    }
  `,
  name: "isolated-session-secret",
};

const UNGRANTED_SECRET_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string> {
      return await ctx.agent({
        key: "leak",
        provider: "mock",
        prompt: "p",
        environment: { secrets: ["TOKEN"] },
      });
    }
  `,
  name: "ungranted-secret",
};

function initGitRepo(repo: string): void {
  const g = (args: string[]) => execFileSync("git", args, { cwd: repo });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
}

describe("trusted-local secrets side-channel", () => {
  test("an injected secret can appear in output and journal rows without exact-value redaction", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();

    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(echoProvider),
      secrets,
    });
    const handle = await kernel.run<string>(url, null, {
      name: "leak",
      target: process.cwd(),
      runSecrets: { TOKEN: "sup3r-s3cret-value" },
    });

    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("the token is sup3r-s3cret-value");

    const row = store.getJournalRow("r", "leak", 1);
    expect(JSON.stringify(row)).toContain("sup3r-s3cret-value");
    const all = JSON.stringify(store.listJournalRows("r")) + JSON.stringify(store.listEvents("r"));
    expect(all).toContain("sup3r-s3cret-value");
    expect(all).not.toContain("«redacted»");
    expect(store.listEvents("r").some((e) => e.type === "agent.redacted")).toBe(false);
  });

  test("ctx.agentSession with secrets and write/shell/native tools receives secret env", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "session-secret-value");
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "session",
      supportsSessions: true,
      async generate(inv: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
        invocation = inv;
        const token = inv.resumeToken ?? "sess-1";
        hooks.onSessionToken?.(token);
        return { text: `session saw ${inv.env?.TOKEN}`, transcript: [], sessionToken: token };
      },
    };

    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      secrets,
    });
    const handle = await kernel.run<string>(SESSION_SECRET_WORKFLOW, null, {
      target: process.cwd(),
    });

    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("session saw session-secret-value");
    expect(invocation?.env?.TOKEN).toBe("session-secret-value");
    expect(invocation?.capabilities?.fs).toBe("workspace-write");
    expect(invocation?.capabilities?.shell).toBe(true);
    expect(invocation?.allowTools).toContain("mcp__local__edit");
  });

  test("missing run secret values fail before provider invocation", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    let called = false;
    const provider: AgentProvider = {
      name: "mock",
      async generate(): Promise<AgentResult> {
        called = true;
        return { text: "unexpected", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      secrets,
    });

    await expect(kernel.run<string>(url, null, { target: process.cwd() })).rejects.toThrow(
      /missing secret value for TOKEN/,
    );
    expect(called).toBe(false);
    expect(store.getRun("r")?.status).toBe("failed");
  });

  test("ungranted environment secrets fail before provider invocation", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    let called = false;
    const provider: AgentProvider = {
      name: "mock",
      async generate(): Promise<AgentResult> {
        called = true;
        return { text: "unexpected", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      secrets,
    });

    await expect(
      kernel.run<string>(UNGRANTED_SECRET_WORKFLOW, null, {
        target: process.cwd(),
        runSecrets: { TOKEN: "value" },
      }),
    ).rejects.toThrow(/capabilities\.secrets/);
    expect(called).toBe(false);
    expect(store.getRun("r")?.status).toBe("failed");
  });

  test("worktree agent sessions receive secrets and retain secret-bearing diffs", async () => {
    const repo = mkdtempSync(join(tmpdir(), "keel-secret-isolated-target-"));
    const workspaceStore = mkdtempSync(join(tmpdir(), "keel-secret-isolated-store-"));
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "isolated-secret-value");
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "session",
      supportsSessions: true,
      async generate(inv: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
        invocation = inv;
        if (!inv.cwd) throw new Error("missing isolated cwd");
        hooks.onSessionToken?.(inv.resumeToken ?? "sess-1");
        writeFileSync(join(inv.cwd, "secret.txt"), `secret=${inv.env?.TOKEN}\n`);
        return { text: `isolated saw ${inv.env?.TOKEN}`, transcript: [], sessionToken: "sess-1" };
      },
    };

    try {
      initGitRepo(repo);
      const kernel = new RealmKernel(store, {
        idgen: () => "r",
        agents: new AgentProviderRegistry().register(provider),
        secrets,
        workspaceStore,
      });
      const handle = await kernel.run<string>(ISOLATED_SESSION_SECRET_WORKFLOW, null, {
        target: repo,
      });

      expect(handle.status).toBe("finished");
      expect(handle.output).toBe("isolated saw isolated-secret-value");
      expect(invocation?.env?.TOKEN).toBe("isolated-secret-value");
      expect(invocation?.cwd?.startsWith(workspaceStore)).toBe(true);
      const workspace = store.listAgentWorkspaces("r")[0];
      expect(workspace).toMatchObject({ sourcePath: repo, status: "pending_review" });
      expect(workspace?.workspacePath).toBe(invocation?.cwd);
      expect(readFileSync(join(workspace?.workspacePath ?? "", "secret.txt"), "utf8")).toBe(
        "secret=isolated-secret-value\n",
      );
      expect(existsSync(join(repo, "secret.txt"))).toBe(false);
      const diffEvent = store.listEvents("r").find((event) => event.type === "agent.diff");
      expect(diffEvent?.payloadJson).toContain("isolated-secret-value");
      expect(diffEvent?.payloadJson).not.toContain("«redacted»");
      expect(() => secrets.resolveOrThrow("r", ["TOKEN"])).toThrow(/missing secret value/);
    } finally {
      store.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(workspaceStore, { recursive: true, force: true });
    }
  });

  test("tolerated failure payloads containing a secret are journaled without redaction", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "failure-secret-value");
    const provider: AgentProvider = {
      name: "mock",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        throw new Error(`provider failed with ${inv.env?.TOKEN}`);
      },
    };

    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(provider),
      secrets,
    });
    const handle = await kernel.run<string>(TOLERATED_FAILURE_WORKFLOW, null, {
      target: process.cwd(),
    });

    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("tolerated");
    const tolerated = store
      .listEvents("r")
      .find((event) => event.type === "agent.tolerated_failure");
    expect(tolerated?.payloadJson).toContain("failure-secret-value");
    expect(tolerated?.payloadJson).not.toContain("«redacted»");
  });
});
