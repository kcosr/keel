# Writing & running a Keel workflow

A **workflow** is an `async (ctx, input) => output` function. You call agents and
do work through `ctx`; Keel runs it durably and survives crashes. For a single
workflow, run inline TypeScript with `keel run <<'TS'` so no workflow file is
needed. `keel run` prints a structured JSON envelope by default.
For reusable operational workflows, check `workflows/README.md` and launch the
documented workflow file instead of copying fixture code.

Assume the daemon is already running and the `keel` CLI is already configured to
reach it. Do not start the daemon, restart systemd, or use admin credentials from
this skill.

---

## 1. The shape

```ts
import type { Ctx } from "@kcosr/keel";
import { jsonSchema, passthrough } from "@kcosr/keel";

export default async function myWorkflow(ctx: Ctx, input: { /* your input */ }) {
  // ...do work via ctx...
  return /* your result (JSON-serializable) */;
}
```

- Default export, `async (ctx, input) => output`.
- `input` and the return value must be JSON-serializable.

## 2. Rules

The body runs in a sandbox. Stay inside it or the run is rejected:

- **No `Date.now()`, `new Date()`, `Math.random()`, `fetch`, `Bun.*`, or
  file/network access** in the body. Use `ctx.now()` / `ctx.random()`; do real
  work via `ctx.agent`.
- **Workflow code is single-file in v1** and imports only the exact authoring SDK
  specifier `@kcosr/keel`. Do not import local helper modules, other packages,
  SDK subpaths, or operator/control APIs such as `@kcosr/keel/execute`.
- **A `ctx.step` callback must use only its `inputs`** — don't read outer variables
  inside a `step` function; pass them in through `inputs`. (Agent prompts can use
  any variable freely.)

## 3. The `ctx` API

```ts
ctx.agent(spec)                       // call an LLM agent (the real work); see §4
ctx.agentSession(spec).turn(spec)     // realm-only multi-turn logical agent; see §4.1
ctx.step(key, schema, inputs, fn)     // pure compute; memoized & re-run only if inputs/code change
ctx.now() / ctx.random()              // the only time / randomness allowed
ctx.sleep(key, ms)                    // durable pause
ctx.human({ key, prompt })            // wait for a human approval → { status, note }
ctx.signal(name)                      // wait for an external signal
ctx.stepKey(name, id)                 // make a stable key for fan-out
ctx.log(msg) / ctx.phase(title)       // narration
```

**Fan out with `Promise.all`** over `ctx.agent`/`ctx.step`. Keys must be stable per
run — derive fan-out keys from content: `ctx.stepKey("verify", finding.id)`, never
from an array index.

## 4. Calling an agent (`ctx.agent`)

```ts
ctx.agent({
  key: "review:security",     // unique, stable (use ctx.stepKey for fan-out)
  prompt: "Review the code at /abs/path for security issues. Report each finding.",
  schema: Findings,           // structured output (§5); omit for plain text
  toolPolicy: "read-only",    // lets the agent read/grep the files
  reasoning: "high",          // off | minimal | low | medium | high | xhigh
  onFailure: "null",          // only for optional agents where partial results are OK
  lenient: true,              // tolerant output parsing — recommended
})
```

Filter tolerated failures out with `.filter(Boolean)`. Do not use `onFailure:
"null"` for required agents; let those failures fail the run so the run can be
retried.

`toolPolicy` is only `"none"`, `"read-only"`, `"workspace-write"`, or
`"unrestricted"`. To let an agent run shell commands, use explicit capabilities:

```ts
capabilities: { fs: "none", network: "none", shell: true, secrets: [] }
```

## 4.1 Multi-Turn Agent Sessions (`ctx.agentSession`)

Use `ctx.agentSession` only when later turns need the same backend conversation
memory as earlier turns. Declare participant identity once, then call `.turn`
with stable turn keys:

```ts
const primary = ctx.agentSession({
  key: "primary",
  provider: "pi",
  toolPolicy: "read-only",
});

await primary.turn({ key: "draft", prompt: draftPrompt, schema: Draft });
const revised = await primary.turn({ key: "revise", prompt: revisePrompt, schema: Draft });
```

Participant and turn keys must match `[A-Za-z0-9_-]+`. Do not use
`__session.` as a `ctx.step` or `ctx.agent` key prefix; Keel reserves it for
derived session-turn journal keys.

Do not use session turns for independent fan-out. A participant is a single
forward-only backend thread, so concurrent turns on the same participant fail.
Use separate participant keys for independent conversations.

Session runs can resume and retry, but not rerun, rewind, or fork. If a session
turn is interrupted after a backend token is observed, explicit resume continues
from that token rather than starting a fresh session. Changing a participant's
resolved provider/model/tool/capability identity or changing a completed/pending
turn's prompt/schema/options for the same turn key fails closed.
`workspaceIsolation: true` is not supported for `ctx.agentSession` yet.

## 5. Schemas

`jsonSchema` for structured agent output, `passthrough` for a plain step value:

```ts
const Findings = jsonSchema<{ findings: { title: string; file: string;
  severity: "high" | "medium" | "low"; detail: string }[] }>({
  type: "object", additionalProperties: false, required: ["findings"],
  properties: { findings: { type: "array", items: { type: "object",
    additionalProperties: false, required: ["title", "file", "severity", "detail"],
    properties: { title: { type: "string" }, file: { type: "string" },
      severity: { type: "string", enum: ["high", "medium", "low"] },
      detail: { type: "string" } } } } },
});
const out = passthrough<unknown>();
```

## 6. Example — adversarial code review

Several reviewers fan out by concern, findings are deduped in plain code, each one
gets an **adversarial verifier** that tries to refute it, and only confirmed
findings are kept. (Drop the verify phase for a plain review.)

```ts
import type { Ctx } from "@kcosr/keel";
import { jsonSchema, passthrough } from "@kcosr/keel";

type Finding = { title: string; file: string; severity: "high" | "medium" | "low"; detail: string };

const Findings = jsonSchema<{ findings: Finding[] }>({
  type: "object", additionalProperties: false, required: ["findings"],
  properties: { findings: { type: "array", items: { type: "object",
    additionalProperties: false, required: ["title", "file", "severity", "detail"],
    properties: { title: { type: "string" }, file: { type: "string" },
      severity: { type: "string", enum: ["high", "medium", "low"] }, detail: { type: "string" } } } } },
});
const Verdict = jsonSchema<{ real: boolean; reason: string }>({
  type: "object", additionalProperties: false, required: ["real", "reason"],
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
});
const out = passthrough<unknown>();

export default async function adversarialReview(ctx: Ctx, input: { root: string }) {
  ctx.phase("Find");
  const lenses = ["security", "correctness", "error-handling"];
  const found = await Promise.all(lenses.map((lens) =>
    ctx.agent({
      key: ctx.stepKey("find", lens),
      prompt: `Review the code under ${input.root} for ${lens} issues. Read the files. Report each problem.`,
      schema: Findings, toolPolicy: "read-only", reasoning: "high", onFailure: "null", lenient: true,
    }),
  ));

  // Dedupe in plain code (deterministic — no agent).
  const seen = new Set<string>();
  const deduped = found.filter(Boolean).flatMap((f) => f!.findings).filter((f) => {
    const k = `${f.file}|${f.title.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  ctx.phase("Verify");
  const checked = await Promise.all(deduped.map((f) =>
    ctx.agent({
      key: ctx.stepKey("verify", `${f.file}|${f.title}`),
      prompt: `Adversarially verify this finding — try to REFUTE it. Is it real? Read ${f.file}.\n${JSON.stringify(f)}`,
      schema: Verdict, toolPolicy: "read-only", reasoning: "high", onFailure: "null", lenient: true,
    }).then((v) => (v?.real ? f : null)),
  ));
  const confirmed = checked.filter(Boolean) as Finding[];

  ctx.phase("Report");
  return ctx.step("report", out, { confirmed, raw: deduped.length }, (x) => ({
    confirmed: x.confirmed,
    confirmedCount: (x.confirmed as Finding[]).length,
    rawCount: x.raw,
  }));
}
```

## 7. Run It Inline

For one workflow, prefer `keel run` with a TypeScript heredoc. Put runtime
input in `--input`; stdin is the workflow source.

```bash
keel run --input '{"root":"/abs/path/to/code"}' <<'TS'
import { type Ctx, jsonSchema, passthrough } from "@kcosr/keel";

const Hostname = jsonSchema<{ hostname: string }>({
  type: "object",
  additionalProperties: false,
  required: ["hostname"],
  properties: { hostname: { type: "string" } },
});
const Out = passthrough<unknown>();

export default async function workflow(ctx: Ctx, input: { root: string }) {
  const report = await ctx.agent({
    key: "report-hostname",
    prompt: "Run hostname and return JSON with the hostname.",
    schema: Hostname,
    capabilities: { fs: "none", network: "none", shell: true, secrets: [] },
    lenient: true,
  });

  const confirm = await ctx.agent({
    key: "confirm-hostname",
    prompt: "Independently run hostname and confirm this value: " + report.hostname,
    schema: Hostname,
    capabilities: { fs: "none", network: "none", shell: true, secrets: [] },
    lenient: true,
  });

  return ctx.step("report", Out, { report, confirm, root: input.root }, (x) => ({
    root: x.root,
    reportedHostname: x.report.hostname,
    confirmedHostname: x.confirm.hostname,
    matches: x.report.hostname === x.confirm.hostname,
  }));
}
TS
```

## 8. Use `execute` For Orchestration

Use `keel execute` when you need a TypeScript control script to drive multiple
run operations. Avoid nesting a full workflow source string inside `execute`
unless you really need orchestration; nested template literals are easy to break.

Inside `execute`, use this TypeScript control surface:

```bash
keel execute -- "$RUN_ID" <<'TS'
const runId = args[0];
if (!runId) throw new Error("missing run id");
const settled = await keel.wait(runId, { timeoutMs: 30_000 });
const projection = await keel.get(runId);
const output = settled.status === "finished" ? await keel.output(runId) : null;
return { runId, status: settled.status, output, phase: projection?.phase ?? null };
TS
```

```ts
await keel.wait(runId);
await keel.get(runId);
await keel.report(runId);
await keel.output(runId);
await keel.retry(runId);
await keel.interrupt(runId, "operator inspection");
await keel.resume(runId);
```

`interrupt` is resumable, not terminal cancellation: it stops active work
best-effort and parks the run as `interrupted`; only `resume` continues it.

`execute` is stateless. Return the small JSON result the caller needs: usually
`runId`, `capabilityRef`, `status`, `output`, and any next-step context. Use
`execute` when the next action is computable from the prior result: start
fan-out, wait, retry, inspect output, shape JSON, or decide a simple branch.
Durable pauses, replayable workflow logic, and long-running state belong in the
workflow itself, not in `execute`.

## 9. Tips

- Use **absolute paths** for the code you're reviewing.
- On optional review fan-out agents, set **`toolPolicy: "read-only"`**, **`lenient:
  true`**, and **`onFailure: "null"`** so one flaky branch doesn't sink the run.
  For required agents, omit `onFailure` so failures can be retried.
- A run resumes from its immutable start-time workflow snapshot. To change code,
  run again or rerun with new inline source. Do not use retry/rewind/rerun to
  continue an interrupted run; resume it first.
- Use `run` for a single workflow; use `execute` only for mechanical
  follow-up across one or more runs.
