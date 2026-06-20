# Model Routing Workflow Helper

`model-routing.ts` is a captured workflow helper for choosing explicit agent
providers, models, reasoning levels, timeouts, and loop hints from task
metadata. It is workflow source, not daemon policy: importing it into a workflow
snapshots the helper with the workflow bundle and pins the routing behavior for
that run.

Use deterministic routing when the workflow already knows the task shape:

```ts
import { selectModelRoute } from "./model-routing/model-routing";

const reviewerRoute = selectModelRoute({
  role: "reviewer",
  task: "implementation-review",
  complexity: "high",
  surfaces: ["rpc", "journal", "workflow-sdk"],
  risks: ["migration", "replay", "authorization"],
  budget: "balanced",
});

const reviewer = ctx.agentSession({
  key: "reviewer",
  provider: reviewerRoute.provider,
  model: reviewerRoute.model,
  reasoning: reviewerRoute.reasoning,
  toolPolicy: "read-only",
});

const review = await reviewer.turn({
  key: "review",
  prompt,
  schema: ReviewSchema,
  ...(reviewerRoute.timeoutMs ? { timeoutMs: reviewerRoute.timeoutMs } : {}),
});
```

Use agentic routing when an early read-only agent should inspect the request and
return a bounded implementer/reviewer plan:

```ts
import { routeWithAgent } from "./model-routing/model-routing";

const codexBackend = { provider: "codex", model: "gpt-5.5" };
const claudeBackend = { provider: "claude", model: "claude-opus-4-8" };

const route = await routeWithAgent(ctx, {
  key: "model-router",
  request: input.task,
  specPath: input.specPath,
  target: ctx.run.target,
  candidateSurfaces: ["rpc", "journal", "workflow-sdk"],
  candidateRisks: ["migration", "replay", "authorization"],
  constraints: {
    router: claudeBackend,
    allowedBackends: [codexBackend, claudeBackend],
    allowedReasoning: ["low", "medium", "high", "xhigh"],
    maxReasoning: "xhigh",
    defaultImplementer: codexBackend,
    defaultReviewer: claudeBackend,
  },
});
```

Guardrails:

- The router uses `ctx.agent` with `toolPolicy: "read-only"`.
- Router output can select only allowlisted provider/model backends and
  allowlisted reasoning values.
- Caller-declared `candidateSurfaces` and `candidateRisks` are trusted floor
  inputs. The router can add classification detail, but it cannot lower the
  minimum reasoning by omitting a critical surface or risk.
- `routeWithAgent` needs a stable `key`, just like direct `ctx.agent` calls. Use
  distinct keys for multiple routing decisions in one workflow.
- Critical surfaces and risks enforce minimum reasoning floors. If the floor is
  above `maxReasoning`, routing fails instead of downgrading.
- Router output cannot select tool policy, capabilities, secrets, provider
  config, workspace mode, or workflow source.
- `timeoutMs` belongs on `ctx.agent(...)` or `session.turn(...)`; `maxRounds`
  and `verification[]` are workflow-owned hints.
- Custom `reasoningOrder` values may add provider-specific levels such as `off`
  or `minimal`, but must keep the default critical floor levels used by
  `CRITICAL_REASONING_FLOORS`.

`example-smart-implement-review.workflow.ts` demonstrates agentic routing feeding
an implementer/reviewer session pair. It requires explicit candidate surfaces
and risks from the caller, keeps backend allowlists in workflow source, and
consumes the route's `maxRounds` hint in a bounded loop. It is intentionally
small; production workflows should keep their own workspace setup and completion
criteria explicit.
