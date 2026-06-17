import { describe, expect, test } from "bun:test";
import { AgentConcurrencyLimiter } from "./concurrency.ts";

function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("AgentConcurrencyLimiter", () => {
  test("total limit serializes calls across providers", async () => {
    const limiter = new AgentConcurrencyLimiter({ total: 1, byProvider: {} }, { clock: () => 10 });

    const first = await limiter.acquire({ runId: "r1", stableKey: "a", provider: "claude" });
    let secondGranted = false;
    const secondPromise = limiter
      .acquire({ runId: "r2", stableKey: "b", provider: "codex" })
      .then((permit) => {
        secondGranted = true;
        return permit;
      });

    await flush();
    expect(secondGranted).toBe(false);
    expect(limiter.queuedWaitForRun("r2", 25)).toMatchObject({
      stableKey: "b",
      provider: "codex",
      queuedAtMs: 10,
      queuedForMs: 15,
      total: { active: 1, limit: 1 },
    });

    first.release();
    const second = await secondPromise;
    expect(secondGranted).toBe(true);
    second.release();
    expect(limiter.activeSnapshot("codex")).toEqual({
      total: { active: 0, limit: 1 },
      providerScope: { active: 0, limit: "unlimited" },
    });
  });

  test("provider limit only blocks matching providers", async () => {
    const limiter = new AgentConcurrencyLimiter({
      total: 3,
      byProvider: { claude: 1 },
    });

    const firstClaude = await limiter.acquire({
      runId: "r1",
      stableKey: "claude-1",
      provider: "claude",
    });
    let secondClaudeGranted = false;
    const secondClaudePromise = limiter
      .acquire({ runId: "r2", stableKey: "claude-2", provider: "claude" })
      .then((permit) => {
        secondClaudeGranted = true;
        return permit;
      });
    const codex = await limiter.acquire({ runId: "r3", stableKey: "codex", provider: "codex" });

    expect(secondClaudeGranted).toBe(false);
    expect(limiter.activeSnapshot("codex").total.active).toBe(2);
    codex.release();
    await flush();
    expect(secondClaudeGranted).toBe(false);

    firstClaude.release();
    const secondClaude = await secondClaudePromise;
    expect(secondClaudeGranted).toBe(true);
    secondClaude.release();
  });

  test("oldest grantable waiter can bypass a saturated provider", async () => {
    const limiter = new AgentConcurrencyLimiter({
      total: 2,
      byProvider: { claude: 1 },
    });

    const activeClaude = await limiter.acquire({
      runId: "r1",
      stableKey: "claude-active",
      provider: "claude",
    });
    let queuedClaudeGranted = false;
    void limiter
      .acquire({ runId: "r2", stableKey: "claude-queued", provider: "claude" })
      .then((permit) => {
        queuedClaudeGranted = true;
        permit.release();
      });

    const codex = await limiter.acquire({ runId: "r3", stableKey: "codex", provider: "codex" });
    expect(queuedClaudeGranted).toBe(false);

    codex.release();
    activeClaude.release();
  });

  test("queued waiters are cancellable and do not leak capacity", async () => {
    const limiter = new AgentConcurrencyLimiter({ total: 1, byProvider: {} });
    const active = await limiter.acquire({ runId: "r1", stableKey: "active", provider: "pi" });
    const controller = new AbortController();
    const queued = limiter.acquire({
      runId: "r2",
      stableKey: "queued",
      provider: "pi",
      signal: controller.signal,
    });

    controller.abort(new Error("interrupted"));
    await expect(queued).rejects.toThrow("interrupted");
    expect(limiter.queuedWaitForRun("r2")).toBeNull();

    active.release();
    expect(limiter.activeSnapshot("pi")).toEqual({
      total: { active: 0, limit: 1 },
      providerScope: { active: 0, limit: "unlimited" },
    });
  });
});
