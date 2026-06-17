// Agent adapter boundary (DESIGN.md §10.1).
//
// One structural interface behind ctx.agent: spawn/drive a vendor, stream its
// events, surface a session token (Phase 10), and return the final output. The
// daemon (host) — never the realm worker — runs providers (L4).

import type { Json } from "../hash.ts";
import type { Capabilities, ToolPolicy } from "./capabilities.ts";

export type ProviderConfigValue = { readonly [key: string]: Json };
export type ProviderConfigMap = Record<string, ProviderConfigValue>;

export interface TraceEvent {
  type:
    | "reasoning"
    | "text"
    | "tool_call"
    | "tool_result"
    | "wait"
    | "error"
    | "disconnect"
    | "session";
  data?: unknown;
  /** Provider-stable tool call/use id for finalized tool_call/tool_result events. */
  toolCallId?: string;
}

export interface AgentInvocation {
  /** Stable step key (for logging/session-dir scoping). */
  key: string;
  provider: string;
  prompt: string;
  /** Selected provider's immutable provider-owned JSON config, if any. */
  providerConfig?: ProviderConfigValue;
  model?: string;
  /** Normalized tool baseline; adapters map it to provider-native flags. */
  toolPolicy?: ToolPolicy;
  /** Provider-native tools added on top of the policy. */
  allowTools?: string[];
  /** Provider-native tools removed from the final provider allowlist. */
  denyTools?: string[];
  /** Vendor session/resume token for a mid-call reconnect (Phase 10). */
  resumeToken?: string;
  /** Per-step session storage directory (Phase 10). */
  sessionDir?: string;
  /** Reasoning/thinking effort level (mapped per vendor; Pi: --thinking). */
  reasoning?: string;
  /** Resolved capabilities (mapped to vendor enforcement; §11). */
  capabilities?: Capabilities;
  /** Provider working directory resolved from the run workspace. */
  cwd: string;
  /** Secret env injected at invocation (§11.2), wiped from the side channel after terminal cleanup. */
  env?: Record<string, string>;
  /** Fires when the kernel abandons a stalled attempt — kill the subprocess. */
  abortSignal?: AbortSignal;
  /** Resolved per-attempt timeout for providers that have an inner turn wait. */
  timeoutMs?: number;
}

export interface AgentResult {
  /** The agent's final message text (parsed for structured output upstream). */
  text: string;
  transcript: TraceEvent[];
  /** Vendor session token captured during the call (Phase 10). */
  sessionToken?: string;
}

export interface AgentHooks {
  /** Called the moment a session token is observed (write-ahead capture). */
  onSessionToken?: (token: string) => void;
  /** Called per streamed event for transcript capture. */
  onEvent?: (event: TraceEvent) => void;
}

export interface AgentProvider {
  readonly name: string;
  /** True when resumeToken is a stable handle to one forward-only backend thread. */
  readonly supportsSessions?: boolean;
  generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult>;
}

export function requireInvocationCwd(invocation: AgentInvocation, providerName: string): string {
  if (typeof invocation.cwd !== "string" || invocation.cwd.trim().length === 0) {
    throw new Error(`${providerName} agent "${invocation.key}" requires a resolved invocation cwd`);
  }
  return invocation.cwd;
}

export class AgentProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): this {
    this.providers.set(provider.name, provider);
    return this;
  }

  get(name: string): AgentProvider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`no agent provider registered for "${name}"`);
    return p;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}
