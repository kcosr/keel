// Public authoring SDK (the `keel` package entry).
//
// This is the ONLY surface a workflow file imports. Runtime values: the schema
// helpers (self-contained, dependency-free). Everything else is type-only and
// erased at runtime — the real `ctx` is injected by the engine. So a workflow's
// only runtime dependency is the two tiny schema helpers; with raw JSON Schema it
// has none at all.

export { jsonSchema, passthrough, type Schema } from "./kernel/schema.ts";
export type {
  AgentSession,
  AgentSessionSpec,
  AgentSpec,
  AgentTurnSpec,
  Ctx,
  HumanDecision,
  HumanSpec,
  StepOpts,
} from "./kernel/ctx.ts";
export type { Capabilities, ToolPolicy } from "./agents/capabilities.ts";
