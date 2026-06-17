// Review-item regressions: strict-by-default vs opt-in lenient coercion, and
// that a stalled attempt is ABORTED (signal fires), not just abandoned.

import { describe, expect, test } from "bun:test";
import { AgentFailure, StepTimeoutError, executeAgent, runAgentWithStall } from "./execute.ts";
import type { AgentHooks, AgentInvocation, AgentProvider, AgentResult } from "./types.ts";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["severity"],
  properties: { severity: { type: "string", enum: ["high", "low"] } },
};

function fixedProvider(text: string): AgentProvider {
  return {
    name: "mock",
    async generate(): Promise<AgentResult> {
      return { text, transcript: [] };
    },
  };
}

describe("strict-by-default vs opt-in lenient", () => {
  test("strict (default) rejects an off-schema enum case and throws after retries", async () => {
    await expect(
      executeAgent(
        fixedProvider('{"severity":"High"}'),
        { key: "k", provider: "mock", prompt: "p", cwd: process.cwd() },
        {},
        {
          jsonSchema: schema,
          maxRetries: 1,
        },
      ),
    ).rejects.toBeInstanceOf(AgentFailure);
  });

  test("lenient coerces the same output and validates", async () => {
    const r = await executeAgent(
      fixedProvider('{"severity":"High","extra":1}'),
      { key: "k", provider: "mock", prompt: "p", cwd: process.cwd() },
      {},
      { jsonSchema: schema, maxRetries: 1, coerce: true },
    );
    expect(r.output).toEqual({ severity: "high" }); // lowercased + extra dropped
  });
});

describe("schema retries preserve provider session", () => {
  test("a validation retry passes the prior session token back to the provider", async () => {
    const calls: AgentInvocation[] = [];
    const provider: AgentProvider = {
      name: "mock",
      async generate(invocation: AgentInvocation): Promise<AgentResult> {
        calls.push({ ...invocation });
        if (calls.length === 1) {
          return { text: '{"wrong":true}', transcript: [], sessionToken: "sess-retry" };
        }
        return { text: '{"severity":"high"}', transcript: [], sessionToken: "sess-retry" };
      },
    };

    const result = await executeAgent(
      provider,
      { key: "k", provider: "mock", prompt: "p", cwd: process.cwd() },
      {},
      { jsonSchema: schema, maxRetries: 1 },
    );

    expect(result.output).toEqual({ severity: "high" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.resumeToken).toBeUndefined();
    expect(calls[1]?.resumeToken).toBe("sess-retry");
  });
});

describe("stall aborts the attempt (signal fires)", () => {
  test("a timed-out attempt receives an abort signal and is killed", async () => {
    let aborted = false;
    const provider: AgentProvider = {
      name: "mock",
      generate(inv: AgentInvocation, _hooks: AgentHooks): Promise<AgentResult> {
        return new Promise((_resolve, reject) => {
          inv.abortSignal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("killed by abort"));
          });
          // otherwise never resolves (stall)
        });
      },
    };
    await expect(
      runAgentWithStall(
        (signal) =>
          executeAgent(
            provider,
            { key: "k", provider: "mock", prompt: "p", cwd: process.cwd(), abortSignal: signal },
            {},
            {},
          ),
        { timeoutMs: 40, stallRetries: 1 },
      ),
    ).rejects.toBeInstanceOf(StepTimeoutError);
    expect(aborted).toBe(true); // the provider's subprocess-kill path ran
  });
});
