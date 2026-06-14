// The `ctx` authoring surface (DESIGN.md §9.1) — Phase 2–4 subset.
//
// WorkflowCtx is the IN-PROCESS implementation: it runs step fns locally and
// journals through the shared StepEngine. The realm host (Phase 4) is a second
// front-end over the same StepEngine that runs fns in a Worker. agent/human/
// signal/sleep/spawn land in later phases.

import { type Capabilities, type ToolPolicy, resolveToolPolicy } from "../agents/capabilities.ts";
import { DEFAULT_AGENT_PROVIDER, DEFAULT_SCHEMA_MAX_RETRIES } from "../agents/defaults.ts";
import { AgentFailure, executeAgent, runAgentWithStall } from "../agents/execute.ts";
import { type AgentProfiles, resolveProfile } from "../agents/profiles.ts";
import type { AgentProviderRegistry } from "../agents/types.ts";
import type { Json } from "../hash.ts";
import type { JournalStore } from "../journal/store.ts";
import { finalAgentMessageEvents } from "./agent-events.ts";
import type { Schema } from "./schema.ts";
import { StepEngine } from "./step-engine.ts";
import { computeVersion } from "./version.ts";

const SESSION_STABLE_KEY_PREFIX = "__session.";

function assertNotReservedAuthorKey(key: string, kind: string): void {
  if (key.startsWith(SESSION_STABLE_KEY_PREFIX)) {
    throw new Error(`${kind} key "${key}" uses reserved prefix ${SESSION_STABLE_KEY_PREFIX}`);
  }
}

/** Optional per-step controls. `version` pins an explicit version (tests);
 * `bump` is the author's manual structural-invalidation knob (§5.2). */
export interface StepOpts {
  version?: string;
  bump?: string | number;
}

/** ctx.agent specification (DESIGN.md §9.1). */
export interface AgentSpec<T> {
  /** Stable step key (use ctx.stepKey for fan-out). */
  key: string;
  prompt: string;
  /** Named profile (daemon-configured) whose settings this spec inherits; the
   * resolved fields enter the version hash, the name does not. */
  profile?: string;
  /** Provider name; defaults to "pi" in v0 (L19). */
  provider?: string;
  schema?: Schema<T>;
  model?: string;
  /** Reasoning/thinking effort (Pi: off|minimal|low|medium|high|xhigh). */
  reasoning?: string;
  /** Semantic tool baseline; provider adapters map it to native tool flags. */
  toolPolicy?: ToolPolicy;
  /** Provider-native tools to add on top of `toolPolicy`. */
  allowTools?: string[];
  /** Provider-native tools to remove from the final provider allowlist. */
  denyTools?: string[];
  /** Run the provider in an isolated git worktree and journal its diff. Realm-only. */
  workspaceIsolation?: boolean;
  /** Explicit capabilities; overrides the default read-only policy (§11). */
  capabilities?: Partial<Capabilities>;
  /** Named secret refs to inject sealed at invocation (§11.2). */
  secrets?: string[];
  /** Terminal-failure policy after retries (D7): default 'throw'. */
  onFailure?: "throw" | "null";
  /** In-session validation retries (default 2). */
  maxRetries?: number;
  /** Opt into tolerant schema coercion (default strict). Use for loose models. */
  lenient?: boolean;
  /** Per-attempt stall timeout in ms (default 1 hour, §12.2). */
  timeoutMs?: number;
  /** Stall retries before StepTimeoutError (default 1). */
  stallRetries?: number;
  bump?: string | number;
  version?: string;
}

export type AgentSessionSpec = Omit<
  AgentSpec<unknown>,
  | "key"
  | "prompt"
  | "schema"
  | "onFailure"
  | "maxRetries"
  | "lenient"
  | "timeoutMs"
  | "stallRetries"
  | "bump"
  | "version"
> & {
  key: string;
};

export interface AgentTurnSpec<T> {
  key: string;
  prompt: string;
  schema?: Schema<T>;
  onFailure?: "throw" | "null";
  maxRetries?: number;
  lenient?: boolean;
  timeoutMs?: number;
  stallRetries?: number;
  bump?: string | number;
  version?: string;
}

export interface AgentSession {
  turn<T>(spec: AgentTurnSpec<T>): Promise<T>;
}

export interface HumanSpec {
  /** Stable key for the approval request (durable across resume). */
  key: string;
  /** What the human is being asked to decide. */
  prompt: string;
  /** Optional capabilities this gate may grant on approval (§11.3). */
  requestedCaps?: Partial<Capabilities>;
}

export interface HumanDecision {
  status: "approved" | "denied";
  note: string | null;
  grantedCaps: unknown;
}

export interface Ctx {
  /** Pure, memoized step. `fn` must be deterministic in its explicit `inputs`.
   * `inputs` must be JSON-serializable at runtime (hashJson enforces it); the
   * type is left open so typed domain objects read cleanly. */
  step<T, I>(
    key: string,
    schema: Schema<T>,
    inputs: I,
    fn: (inputs: I) => T | Promise<T>,
    opts?: StepOpts,
  ): Promise<T>;

  /** Effectful agent call: journaled; a completed one never re-runs on resume. */
  agent<T>(spec: AgentSpec<T>): Promise<T>;

  /** Realm-only durable logical agent session. */
  agentSession(spec: AgentSessionSpec): AgentSession;

  /** Journaled wall-clock — the only time source in workflow scope. */
  now(): number;
  /** Journaled entropy — the only randomness in workflow scope. */
  random(): number;

  /** Durably sleep `ms` (§16). `key` is a stable author-supplied identity (like a
   * step key) so reordering/inserting waits never reattaches a persisted timer to
   * the wrong site; the duration is folded into the identity, so changing it is a
   * new timer. The run parks (waiting-timer) at zero cost; survives restarts. */
  sleep(key: string, ms: number): Promise<void>;

  /** Park (waiting-human) until a decision is delivered via the API (§17). */
  human(spec: HumanSpec): Promise<HumanDecision>;

  /** Park (waiting-signal) until a named external signal arrives; returns its
   * payload (§17). Ordered: the Nth ctx.signal(name) consumes the Nth signal. */
  signal<T = unknown>(name: string): Promise<T>;

  /** End this run (status 'continued') and start a fresh run of the same
   * workflow with `input` — bounds journal growth for long-lived/cron
   * workflows (§19). Never returns. */
  continueAsNew(input: unknown): Promise<never>;

  /** Stable fan-out key from a semantic name + a content-derived id. */
  stepKey(semanticName: string, stableId: string): string;

  /** Narration persisted to the event log (advisory, not control flow). */
  log(message: string, data?: Json): void;
  phase(title: string): void;
}

/**
 * Fault-injection points around the write-ahead protocol (§5.5), used by the
 * crash harness to die at precise boundaries:
 *  - "after-pending": the pending row is committed but `fn` has not run.
 *  - "before-commit": `fn` has run but the completed row is not yet committed.
 */
export type FaultPoint = "after-pending" | "before-commit";

export interface CtxHost {
  /** Wall-clock source the kernel injects (deterministic in tests). */
  clock: () => number;
  /** Entropy source the kernel injects (deterministic in tests). */
  rng: () => number;
  /** Optional crash/fault hook; a no-op in production. */
  fault?: (point: FaultPoint, key: string) => void;
  /** Push a live, non-durable event frame to current watchers. */
  liveEvent?: (runId: string, type: string, payload: Json, atMs: number) => void;
}

/** In-process `ctx`: runs step fns locally, journals via StepEngine. */
export class WorkflowCtx implements Ctx {
  private readonly engine: StepEngine;
  private readonly registry: AgentProviderRegistry | undefined;
  private readonly agentProfiles: Record<string, unknown> | undefined;

  constructor(
    store: JournalStore,
    runId: string,
    host: CtxHost,
    registry?: AgentProviderRegistry,
    agentProfiles?: Record<string, unknown>,
  ) {
    this.engine = new StepEngine(store, runId, host);
    this.registry = registry;
    this.agentProfiles = agentProfiles;
  }

  async step<T, I>(
    key: string,
    schema: Schema<T>,
    inputs: I,
    fn: (inputs: I) => T | Promise<T>,
    opts?: StepOpts,
  ): Promise<T> {
    assertNotReservedAuthorKey(key, "ctx.step");
    const version =
      opts?.version ??
      computeVersion({ fn, schema, ...(opts?.bump !== undefined ? { bump: opts.bump } : {}) });
    const begun = this.engine.beginStep(key, inputs as Json, version, null);
    if (begun.kind === "replay") {
      return begun.value as T;
    }
    try {
      const raw = await fn(inputs);
      const result = schema.parse(raw);
      this.engine.completeStep(
        key,
        begun.attempt,
        version,
        begun.inputHash,
        begun.startedAtMs,
        result,
        null,
      );
      return result;
    } catch (err) {
      if (isAbort(err)) throw err; // leave the row pending → resume re-executes
      this.engine.failStep(key, begun.attempt, version, begun.inputHash, begun.startedAtMs, err);
      throw err;
    }
  }

  async agent<T>(rawSpec: AgentSpec<T>): Promise<T> {
    if (!this.registry) {
      throw new Error("ctx.agent requires an agent provider registry");
    }
    // Resolve a named profile before versioning (resolved fields enter the hash).
    const spec = resolveProfile(
      rawSpec,
      this.agentProfiles as AgentProfiles | undefined,
    ) as AgentSpec<T>;
    assertNotReservedAuthorKey(spec.key, "ctx.agent");
    // Secret injection is realm-only (the side channel lives on the daemon host);
    // fail loudly rather than silently ignoring a secrets request in-process.
    if (spec.secrets?.length) {
      throw new Error("ctx.agent({ secrets }) requires the realm kernel (secret side-channel)");
    }
    if (spec.workspaceIsolation) {
      throw new Error("ctx.agent({ workspaceIsolation }) requires the realm kernel");
    }
    const provider = spec.provider ?? DEFAULT_AGENT_PROVIDER;
    // Resolve capabilities identically to the realm path so the two front-ends
    // produce the same version hash for the same spec (identity parity, §11).
    const tools = resolveToolPolicy({
      ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
      ...(spec.toolPolicy ? { toolPolicy: spec.toolPolicy } : {}),
      ...(spec.allowTools ? { allowTools: spec.allowTools } : {}),
      ...(spec.denyTools ? { denyTools: spec.denyTools } : {}),
    });
    const caps = tools.capabilities;
    const version =
      spec.version ??
      computeVersion({
        spec: {
          prompt: spec.prompt,
          provider,
          model: spec.model ?? null,
          reasoning: spec.reasoning ?? null,
          toolPolicy: tools.toolPolicy,
          allowTools: tools.allowTools,
          denyTools: tools.denyTools,
          workspaceIsolation: false,
          capabilities: caps,
          secrets: spec.secrets ?? [],
        },
        schema: spec.schema,
        ...(spec.bump !== undefined ? { bump: spec.bump } : {}),
      });
    const inputs = {
      prompt: spec.prompt,
      provider,
      model: spec.model ?? null,
      reasoning: spec.reasoning ?? null,
      toolPolicy: tools.toolPolicy,
      allowTools: tools.allowTools,
      denyTools: tools.denyTools,
      workspaceIsolation: false,
      capabilities: caps,
      secrets: spec.secrets ?? [],
    };
    const begun = this.engine.beginStep(
      spec.key,
      inputs as unknown as Json,
      version,
      null,
      "effectful",
    );
    if (begun.kind === "replay") {
      return begun.value as T;
    }
    try {
      const jsonSchema = spec.schema?.structural?.();
      const execution = await runAgentWithStall(
        (signal) =>
          executeAgent(
            this.registry?.get(provider) as ReturnType<NonNullable<typeof this.registry>["get"]>,
            {
              key: spec.key,
              provider,
              prompt: spec.prompt,
              ...(spec.model ? { model: spec.model } : {}),
              ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
              toolPolicy: tools.toolPolicy,
              allowTools: tools.allowTools,
              denyTools: tools.denyTools,
              capabilities: caps,
              ...(begun.resumeToken ? { resumeToken: begun.resumeToken } : {}),
              abortSignal: signal,
            },
            {
              onSessionToken: (tok) => this.engine.recordSessionToken(spec.key, begun.attempt, tok),
              onEvent: (e) => this.engine.emitAgentTrace(spec.key, begun.attempt, e),
            },
            {
              ...(jsonSchema !== undefined ? { jsonSchema } : {}),
              maxRetries: spec.maxRetries ?? DEFAULT_SCHEMA_MAX_RETRIES,
              ...(spec.lenient ? { coerce: true } : {}),
            },
          ),
        {
          ...(spec.timeoutMs != null ? { timeoutMs: spec.timeoutMs } : {}),
          ...(spec.stallRetries != null ? { stallRetries: spec.stallRetries } : {}),
          onStall: (a) => this.engine.emit("agent.stalled", { key: spec.key, attempt: a }),
        },
      );
      this.engine.completeStep(
        spec.key,
        begun.attempt,
        version,
        begun.inputHash,
        begun.startedAtMs,
        execution.output,
        null,
        "effectful",
        finalAgentMessageEvents(spec.key, begun.attempt, execution.text),
      );
      return execution.output as T;
    } catch (err) {
      if (isAbort(err)) throw err;
      // onFailure:'null' (D7): journal a completed null so resume replays it.
      if (spec.onFailure === "null" && err instanceof AgentFailure) {
        this.engine.emit("agent.tolerated_failure", {
          key: spec.key,
          error: { name: err.name, message: err.message },
        });
        this.engine.completeStep(
          spec.key,
          begun.attempt,
          version,
          begun.inputHash,
          begun.startedAtMs,
          null,
          null,
          "effectful",
        );
        return null as T;
      }
      this.engine.failStep(
        spec.key,
        begun.attempt,
        version,
        begun.inputHash,
        begun.startedAtMs,
        err,
        "effectful",
      );
      throw err;
    }
  }

  agentSession(_spec: AgentSessionSpec): AgentSession {
    throw new Error("ctx.agentSession requires the realm kernel");
  }

  now(): number {
    return this.engine.now();
  }

  random(): number {
    return this.engine.random();
  }

  // Durable park/wake (sleep/signal/human) requires the realm host's suspend
  // machinery; the in-process ctx is the legacy single-shot path.
  async sleep(_key: string, _ms: number): Promise<void> {
    throw new Error("ctx.sleep requires the realm kernel (durable park/wake)");
  }

  async human(_spec: HumanSpec): Promise<HumanDecision> {
    throw new Error("ctx.human requires the realm kernel (durable park/wake)");
  }

  async signal<T>(_name: string): Promise<T> {
    throw new Error("ctx.signal requires the realm kernel (durable park/wake)");
  }

  async continueAsNew(_input: unknown): Promise<never> {
    throw new Error("ctx.continueAsNew requires the realm kernel");
  }

  stepKey(semanticName: string, stableId: string): string {
    return `${semanticName}:${stableId}`;
  }

  log(message: string, data?: Json): void {
    this.engine.emit("log", { message, data: data ?? null });
  }

  phase(title: string): void {
    this.engine.emit("phase", { title });
  }
}

/** Detect the cooperative abort signal by name (avoids importing kernel.ts). */
function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "KeelAbort";
}
