import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
});
