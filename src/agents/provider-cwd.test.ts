import { describe, expect, test } from "bun:test";
import { ClaudeProvider } from "./claude.ts";
import { CodexProvider } from "./codex.ts";
import { PiProvider } from "./pi.ts";
import type { AgentHooks, AgentInvocation, TraceEvent } from "./types.ts";

function missingCwd(provider: string): AgentInvocation {
  return {
    key: `${provider}-missing-cwd`,
    provider,
    prompt: "hello",
    toolPolicy: "none",
  } as AgentInvocation;
}

describe("provider cwd boundary", () => {
  test("Pi, Claude, and Codex fail closed without hook side effects when invocation cwd is missing", async () => {
    const events: TraceEvent[] = [];
    const tokens: string[] = [];
    const hooks: AgentHooks = {
      onEvent: (event) => events.push(event),
      onSessionToken: (token) => tokens.push(token),
    };

    await expect(
      new PiProvider({ bin: "missing-pi" }).generate(missingCwd("pi"), hooks),
    ).rejects.toThrow('pi agent "pi-missing-cwd" requires a resolved invocation cwd');

    await expect(
      new ClaudeProvider({ bin: "missing-claude" }).generate(missingCwd("claude"), hooks),
    ).rejects.toThrow('claude agent "claude-missing-cwd" requires a resolved invocation cwd');

    await expect(
      new CodexProvider({ bin: "missing-codex" }).generate(missingCwd("codex"), hooks),
    ).rejects.toThrow('codex agent "codex-missing-cwd" requires a resolved invocation cwd');

    expect(events).toEqual([]);
    expect(tokens).toEqual([]);
  });
});
