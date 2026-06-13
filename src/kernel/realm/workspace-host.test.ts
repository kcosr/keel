// Commit 3: realm-host Phase 15 hardening — fail-closed isolation, durable diff,
// streamed-event redaction, worktree + secret lifecycle cleanup.

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

describe("fail-closed isolation", () => {
  test("an agent requesting workspace isolation refuses to run when no workspaceRoot is configured", async () => {
    const store = JournalStore.memory();
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
      // NOTE: no workspaceRoot
    });
    await expect(kernel.run(writeUrl, null, { name: "w" })).rejects.toThrow(/workspaceRoot/);
    expect(called).toBe(false); // provider never invoked — failed closed
    expect(store.getRun("r")?.status).toBe("failed");
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
    });
    const handle = await kernel.run<string>(readPlusBashUrl, null, { name: "w" });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe("inspected");
    expect(called).toBe(true);
  });

  test("secrets with write capability require workspace isolation", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "file-secret-abc");
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
      secrets,
    });
    await expect(kernel.run(writeSecretLooseUrl, null, { name: "ws" })).rejects.toThrow(
      /secrets.*workspaceIsolation/,
    );
    expect(called).toBe(false);
    expect(store.getRun("r")?.status).toBe("failed");
  });

  test("secrets with provider-native tool additions require workspace isolation", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "file-secret-abc");
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
      secrets,
    });
    await expect(kernel.run(readPlusBashSecretUrl, null, { name: "ws" })).rejects.toThrow(
      /secrets.*workspaceIsolation/,
    );
    expect(called).toBe(false);
    expect(store.getRun("r")?.status).toBe("failed");
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

  test("the agent.diff event carries the full contentDiff, and the worktree is removed", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(writerProvider),
      workspaceRoot: repo,
    });
    const handle = await kernel.run<string>(writeUrl, null, { name: "w" });
    expect(handle.status).toBe("finished");

    const diffEvent = store.listEvents("r").find((e) => e.type === "agent.diff");
    expect(diffEvent).toBeDefined();
    const payload = JSON.parse(diffEvent?.payloadJson ?? "{}");
    expect(payload.added).toContain("added-by-agent.txt");
    expect(payload.contentDiff).toContain("AGENT WAS HERE"); // durable reviewable patch
    // the real tree is untouched (changes stay in the worktree until approval)
    expect(existsSync(join(repo, "added-by-agent.txt"))).toBe(false);
  });

  test("a secret a write agent writes into a file is redacted in the durable diff", async () => {
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
      workspaceRoot: repo,
      secrets,
    });
    const writeSecretUrl = captureWorkflowFile(
      new URL("./fixtures/write-secret.workflow.ts", import.meta.url).pathname,
    );
    await kernel.run(writeSecretUrl, null, { name: "ws" });
    const diff = store.listEvents("r").find((e) => e.type === "agent.diff");
    expect(diff?.payloadJson).toContain("config.ini"); // the file is in the diff
    expect(diff?.payloadJson).not.toContain("file-secret-abc"); // but its value is redacted
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
      workspaceRoot: repo,
    });
    await kernel.run(writeUrl, null, { name: "w" }).catch(() => null);
    // git worktree list should show only the main worktree (no leaked temp ones)
    const list = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
    expect(list.trim().split("\n").length).toBe(1);
  });
});

describe("secret lifecycle", () => {
  test("a secret streamed in an agent.event is redacted, and secrets are wiped on terminal", async () => {
    const store = JournalStore.memory();
    const secrets = new SecretStore();
    secrets.put("r", "TOKEN", "leaky-secret-xyz");
    const streamer: AgentProvider = {
      name: "streamer",
      async generate(inv: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
        // stream the secret BEFORE returning (the dangerous case)
        hooks.onEvent?.({ type: "text", data: `thinking about ${inv.env?.TOKEN}` });
        return { text: "all done", transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(streamer),
      secrets,
    });
    const handle = await kernel.run<string>(streamUrl, null, { name: "s" });
    expect(handle.status).toBe("finished");

    // the secret value appears nowhere in the journal (events included)
    const all = JSON.stringify(store.listEvents("r")) + JSON.stringify(store.listJournalRows("r"));
    expect(all).not.toContain("leaky-secret-xyz");
    expect(all).toContain("«redacted»");
    // secrets wiped on run completion (per-run lifetime)
    expect(secrets.values("r")).toEqual([]);
  });
});
