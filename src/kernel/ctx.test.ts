import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentInvocation,
  type AgentProvider,
  AgentProviderRegistry,
} from "../agents/types.ts";
import { JournalStore } from "../journal/store.ts";
import { WorkflowCtx } from "./ctx.ts";

describe("WorkflowCtx workspaces", () => {
  test("parallel in-process withWorkspace scopes do not bleed into each other", async () => {
    const target = mkdtempSync(join(tmpdir(), "keel-target-"));
    const pathA = mkdtempSync(join(tmpdir(), "keel-direct-a-"));
    const pathB = mkdtempSync(join(tmpdir(), "keel-direct-b-"));
    const calls = new Map<string, string | undefined>();
    const provider: AgentProvider = {
      name: "recorder",
      async generate(inv: AgentInvocation) {
        calls.set(inv.key, inv.cwd);
        return { text: inv.cwd ?? "", transcript: [] };
      },
    };
    try {
      const ctx = new WorkflowCtx(
        JournalStore.memory(),
        "run-1",
        { clock: () => Date.now(), rng: () => 0.5 },
        new AgentProviderRegistry().register(provider),
        undefined,
        target,
      );
      await Promise.all([
        ctx.withWorkspace({ key: "a", mode: "direct", path: pathA }, async () => {
          await Bun.sleep(20);
          return await ctx.agent({ key: "a", provider: "recorder", prompt: "a" });
        }),
        ctx.withWorkspace({ key: "b", mode: "direct", path: pathB }, async () => {
          await Bun.sleep(50);
          return await ctx.agent({ key: "b", provider: "recorder", prompt: "b" });
        }),
      ]);

      expect(calls.get("a")).toBe(pathA);
      expect(calls.get("b")).toBe(pathB);
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(pathA, { recursive: true, force: true });
      rmSync(pathB, { recursive: true, force: true });
    }
  });

  test("in-process command runs in a direct workspace and replays", async () => {
    const target = mkdtempSync(join(tmpdir(), "keel-target-"));
    const path = mkdtempSync(join(tmpdir(), "keel-command-direct-"));
    const store = JournalStore.memory();
    try {
      const ctx = new WorkflowCtx(
        store,
        "run-1",
        { clock: () => Date.now(), rng: () => 0.5 },
        undefined,
        undefined,
        target,
      );
      const workspace = await ctx.workspace({ key: "cmd", mode: "direct", path });
      const spec = {
        key: "count",
        workspace,
        cwd: ".",
        mode: "argv" as const,
        argv: ["/bin/sh", "-c", "printf ok; echo run >> count.txt"] as [string, ...string[]],
        capabilities: { fs: "workspace-write" as const, shell: true, network: "none" as const },
        timeoutMs: 5000,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
      };

      const first = await ctx.command(spec);
      const second = await ctx.command(spec);

      expect(first.stdout.text).toBe("ok");
      expect(second.stdout.text).toBe("ok");
      expect(second.attempt).toBe(1);
      expect(readFileSync(join(path, "count.txt"), "utf8")).toBe("run\n");
      expect(store.getJournalRow("run-1", "command.count", 1)).toMatchObject({
        effectType: "command",
        status: "completed",
      });
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("in-process command commit fault leaves the pending row resumable", async () => {
    const target = mkdtempSync(join(tmpdir(), "keel-target-"));
    const path = mkdtempSync(join(tmpdir(), "keel-command-commit-fault-"));
    const store = JournalStore.memory();
    let clock = 1_000;
    try {
      const ctx = new WorkflowCtx(
        store,
        "run-1",
        {
          clock: () => clock++,
          rng: () => 0.5,
          fault: (point, key) => {
            if (point === "before-commit" && key === "command.count") throw new Error("CRASH");
          },
        },
        undefined,
        undefined,
        target,
      );
      const workspace = await ctx.workspace({ key: "cmd", mode: "direct", path });
      await expect(
        ctx.command({
          key: "count",
          workspace,
          cwd: ".",
          mode: "argv" as const,
          argv: ["/bin/sh", "-c", "printf ok; echo run >> count.txt"] as [string, ...string[]],
          capabilities: { fs: "workspace-write" as const, shell: true, network: "none" as const },
          timeoutMs: 5000,
          maxStdoutBytes: 1000,
          maxStderrBytes: 1000,
        }),
      ).rejects.toThrow(/CRASH/);

      expect(readFileSync(join(path, "count.txt"), "utf8")).toBe("run\n");
      expect(store.getJournalRow("run-1", "command.count", 1)).toMatchObject({
        effectType: "command",
        status: "pending",
        resultInline: null,
        resultArtifact: null,
      });
      expect(store.getAgentWorkspace("run-1", workspace.id)).toMatchObject({
        status: "idle",
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
      });
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(path, { recursive: true, force: true });
    }
  });
});
