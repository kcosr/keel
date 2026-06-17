import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInvocation, AgentProvider, AgentResult } from "../agents/types.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { JournalStore } from "../journal/store.ts";
import { DaemonClient } from "./client.ts";
import { KeelDaemon } from "./server.ts";

const PARALLEL_AGENTS_WORKFLOW = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function wf(ctx: Ctx): Promise<string[]> {
      return await Promise.all([
        ctx.agent({ key: "a", provider: "hold", prompt: "a" }),
        ctx.agent({ key: "b", provider: "hold", prompt: "b" }),
      ]);
    }
  `,
  name: "parallel-agents",
};

class BlockingProvider implements AgentProvider {
  readonly name = "hold";
  readonly calls: string[] = [];
  private readonly firstStartedPromise: Promise<void>;
  private resolveFirstStarted!: () => void;
  private readonly releaseFirstPromise: Promise<void>;
  private resolveReleaseFirst!: () => void;

  constructor() {
    this.firstStartedPromise = new Promise((resolve) => {
      this.resolveFirstStarted = resolve;
    });
    this.releaseFirstPromise = new Promise((resolve) => {
      this.resolveReleaseFirst = resolve;
    });
  }

  async generate(invocation: AgentInvocation): Promise<AgentResult> {
    this.calls.push(invocation.key);
    if (this.calls.length === 1) {
      this.resolveFirstStarted();
      await this.releaseFirstPromise;
    }
    return { text: invocation.prompt, transcript: [] };
  }

  waitForFirstStarted(): Promise<void> {
    return this.firstStartedPromise;
  }

  releaseFirst(): void {
    this.resolveReleaseFirst();
  }
}

async function eventually<T>(fn: () => Promise<T | null> | T | null): Promise<T> {
  for (let i = 0; i < 50; i += 1) {
    const value = await fn();
    if (value) return value;
    await Bun.sleep(5);
  }
  throw new Error("condition was not met");
}

describe("daemon agent concurrency limits", () => {
  test("daemon reads persisted total limit at startup and reports queued blockage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-agent-concurrency-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const setup = JournalStore.open(dbPath);
    setup.putDaemonSettingRow({
      key: "agent.maxConcurrentTotal",
      valueJson: "1",
      nowMs: 1_000,
    });
    setup.close();

    let now = 1_000;
    const provider = new BlockingProvider();
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(provider),
      clock: () => now,
    });
    await daemon.start();
    const client = await DaemonClient.connect(socketPath);
    try {
      const launched = await client.launchRun({
        source: PARALLEL_AGENTS_WORKFLOW.source,
        input: null,
        target: process.cwd(),
        name: "queued",
      });
      await client.authenticate(launched.capability as string);
      await provider.waitForFirstStarted();
      await eventually(async () => {
        const candidate = await client.getBlockage(launched.runId);
        return candidate.reason === "agent_concurrency" ? candidate : null;
      });
      now = 1_300;

      expect(await client.getBlockage(launched.runId)).toMatchObject({
        reason: "agent_concurrency",
        blockedOn: { stableKey: "b", since: 1_000 },
        agentConcurrency: {
          queuedForMs: 300,
          total: { active: 1, limit: 1 },
        },
      });

      provider.releaseFirst();
      expect((await client.waitForRun(launched.runId)).status).toBe("finished");
    } finally {
      provider.releaseFirst();
      client.close();
      daemon.stop();
    }
  });
});
