// Shared agent execution (DESIGN.md §10.3): run a provider, enforce structured
// output, retry a bounded number of times in-session on a validation failure.
// Used by both the realm host and the in-process ctx.

import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_SCHEMA_MAX_RETRIES,
  DEFAULT_STALL_RETRIES,
} from "./defaults.ts";
import type { AgentHooks, AgentInvocation, AgentProvider } from "./types.ts";
import { coerceToSchema, extractJson, validateJsonSchema } from "./validate.ts";

export class AgentFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFailure";
  }
}

export class StepTimeoutError extends Error {
  constructor(key: string, timeoutMs: number, attempts: number) {
    super(`agent "${key}" stalled past ${timeoutMs}ms on all ${attempts} attempt(s)`);
    this.name = "StepTimeoutError";
  }
}

/**
 * Run an agent under a per-attempt stall timeout (DESIGN.md §12.2). If an attempt
 * does not finish within `timeoutMs`, the attempt is ABORTED (its AbortSignal
 * fires, so the provider kills the in-flight subprocess) and retried up to
 * `stallRetries` times (the Claude-runtime "stalled — retrying" behavior); after
 * that a StepTimeoutError is thrown. `onStall` reports each detected stall.
 */
export async function runAgentWithStall(
  run: (signal: AbortSignal) => Promise<AgentExecution>,
  opts: { timeoutMs?: number; stallRetries?: number; onStall?: (attempt: number) => void },
): Promise<AgentExecution> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const stallRetries = opts.stallRetries ?? DEFAULT_STALL_RETRIES;
  for (let attempt = 0; attempt <= stallRetries; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<"stall">((resolve) => {
      timer = setTimeout(() => resolve("stall"), timeoutMs);
    });
    try {
      const result = await Promise.race([run(controller.signal), stall]);
      if (result !== "stall") return result;
      controller.abort(); // kill the stalled attempt's subprocess
      opts.onStall?.(attempt);
    } catch (err) {
      // an aborted attempt may reject; treat it as a stall and retry, else rethrow
      if (controller.signal.aborted) opts.onStall?.(attempt);
      else throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new StepTimeoutError("agent", timeoutMs, stallRetries + 1);
}

export interface AgentExecution {
  output: unknown;
  text: string;
  transcript: import("./types.ts").TraceEvent[];
  sessionToken?: string;
  attempts: number;
}

export interface AgentExecuteOptions {
  /** JSON Schema for structured output; if absent, the raw text is the output. */
  jsonSchema?: unknown;
  /** Additional in-session retries after a validation failure (default 2). */
  maxRetries?: number;
  /**
   * Opt-in tolerant coercion before validation (lowercase enums, number→string,
   * drop unknown fields). OFF by default: the kernel validates strictly and
   * journals the model's answer faithfully. Authors enable this per agent when
   * they have decided the leniency is acceptable for that contract (e.g. a loose
   * local model). The schema is always injected into the prompt regardless.
   */
  coerce?: boolean;
}

export async function executeAgent(
  provider: AgentProvider,
  invocation: AgentInvocation,
  hooks: AgentHooks,
  opts: AgentExecuteOptions = {},
): Promise<AgentExecution> {
  const maxRetries = opts.maxRetries ?? DEFAULT_SCHEMA_MAX_RETRIES;
  let lastErrors: string[] = [];
  let retryResumeToken = invocation.resumeToken;

  // Inject the schema into the prompt so the model knows the exact target format
  // (lowercase enums, string fields, no extra keys) — the "prompt-injected JSON"
  // path for CLI agents (§10.3).
  const schemaHint = opts.jsonSchema
    ? `\n\nReturn ONLY a single JSON object — no prose, no markdown fences — that EXACTLY matches this JSON Schema. Use enum values exactly as written (lowercase). Every listed field is required. Do not add fields outside the schema.\n\nJSON Schema:\n${JSON.stringify(opts.jsonSchema)}`
    : "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const prompt =
      attempt === 0
        ? invocation.prompt + schemaHint
        : `${invocation.prompt}${schemaHint}\n\n[Your previous response failed validation:\n${lastErrors.join("\n")}\nReturn ONLY corrected JSON.]`;

    const result = await provider.generate(
      { ...invocation, prompt, ...(retryResumeToken ? { resumeToken: retryResumeToken } : {}) },
      hooks,
    );
    if (result.sessionToken) retryResumeToken = result.sessionToken;

    if (!opts.jsonSchema) {
      return {
        output: result.text,
        text: result.text,
        transcript: result.transcript,
        ...(result.sessionToken ? { sessionToken: result.sessionToken } : {}),
        attempts: attempt + 1,
      };
    }

    const extracted = extractJson(result.text);
    if (!extracted.ok) {
      lastErrors = [extracted.error ?? "could not extract JSON"];
      continue;
    }
    // Strict by default; coerce only when the author opted in.
    const candidate = opts.coerce
      ? coerceToSchema(extracted.value, opts.jsonSchema)
      : extracted.value;
    const validated = validateJsonSchema(candidate, opts.jsonSchema);
    if (validated.ok) {
      return {
        output: candidate,
        text: result.text,
        transcript: result.transcript,
        ...(result.sessionToken ? { sessionToken: result.sessionToken } : {}),
        attempts: attempt + 1,
      };
    }
    lastErrors = validated.errors;
  }

  throw new AgentFailure(
    `agent "${invocation.key}" failed schema validation after ${maxRetries + 1} attempts: ${lastErrors.join("; ")}`,
  );
}
