// Deterministic mock agent provider (DESIGN.md §10.5).
//
// Scripted responses keyed by step key, so every kill-and-resume and schema-retry
// test runs in CI in seconds for free. The step vocabulary (reasoning/text/
// tool_call/wait/error/disconnect) doubles as the checklist for the journal event
// model. Per-key call counting lets a scripted response fail validation on the
// first attempt and succeed on a retry.

import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
  TraceEvent,
} from "./types.ts";

export interface MockResponse {
  /** Output text per attempt; attempt n uses outputs[min(n, len-1)]. */
  outputs: string[];
  events?: TraceEvent[];
  sessionToken?: string;
  /** Throw (simulate a disconnect) on the first call only. */
  throwOnce?: boolean;
  /** Artificial latency (ms) — lets a test catch a run mid-flight. */
  delayMs?: number;
}

export interface MockConfig {
  responses?: Record<string, MockResponse>;
  default?: MockResponse;
}

export class MockProvider implements AgentProvider {
  readonly name = "mock";
  readonly supportsSessions = true;
  private readonly calls = new Map<string, number>();

  constructor(private readonly config: MockConfig = {}) {}

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    const response = this.config.responses?.[invocation.key] ?? this.config.default;
    if (!response) {
      throw new Error(`mock provider: no scripted response for key "${invocation.key}"`);
    }
    const n = this.calls.get(invocation.key) ?? 0;
    this.calls.set(invocation.key, n + 1);

    if (response.throwOnce && n === 0) {
      hooks.onEvent?.({ type: "disconnect" });
      throw new Error(`mock provider: simulated disconnect for "${invocation.key}"`);
    }
    if (response.delayMs) await Bun.sleep(response.delayMs);

    const events = response.events ?? [];
    for (const e of events) hooks.onEvent?.(e);
    if (response.sessionToken) {
      hooks.onEvent?.({ type: "session", data: response.sessionToken });
      hooks.onSessionToken?.(response.sessionToken);
    }

    const text = response.outputs[Math.min(n, response.outputs.length - 1)] ?? "";
    return {
      text,
      transcript: events,
      ...(response.sessionToken ? { sessionToken: response.sessionToken } : {}),
    };
  }
}
