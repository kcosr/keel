# Writing & running a Keel workflow

A **workflow** is an `async (ctx, input) => output` function. You call agents and
do work through `ctx`; Keel runs it durably and survives crashes. Write a `.ts`
workflow file, then use `keel execute` for agent-friendly control scripts that
launch, wait, inspect, and return one JSON result.

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
"null"` for required agents; let those failures fail the run so `keel retry` works.

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

## 7. Run it with `execute`

For agent-driven work, prefer `keel execute`: it lets you write the orchestration
around workflow commands in TypeScript, avoid repeated CLI round trips, and return
one structured JSON value.

```ts
// run-review.control.ts
const run = await keel.launch({
  workflow: "./adversarial-review.workflow.ts",
  input: { root: "/abs/path/to/code" },
});

const settled = await keel.wait(run.runId);
return {
  runId: run.runId,
  capabilityRef: run.capabilityRef,
  status: settled.status,
  output: settled.output,
};
```

```bash
keel execute ./run-review.control.ts
```

`execute` is stateless. Pass only non-secret handles through `--state`; pass
capabilities through credential channels such as `KEEL_CAP_FILE`,
`KEEL_RUN_CAP`, `KEEL_ADMIN_TOKEN`, or `--cap-file`. Child launches return a
`capabilityRef` by default. Raw child capabilities require `--emit-capability`.

Use `execute` when the next action is computable from the prior result: launch
fan-out, wait, retry, inspect output, shape JSON, or decide a simple branch.
Durable pauses, replayable workflow logic, and long-running state belong in the
workflow itself, not in `execute`.

## 8. CLI Reference

Use individual CLI verbs for quick one-shot commands or when you need to inspect
the result and decide the next action manually:

```bash
keel launch ./adversarial-review.workflow.ts --input '{"root":"/abs/path/to/code"}'
```

`keel launch` watches by default. Detached launch returns JSON with `runId` and
`capabilityRef`; follow-up commands need that cap file:

```bash
LAUNCH=$(keel launch --detach ./adversarial-review.workflow.ts --input '{"root":"/abs/path/to/code"}')
RUN=$(printf '%s' "$LAUNCH" | jq -r .runId)
CAP=$(printf '%s' "$LAUNCH" | jq -r .capabilityRef)
KEEL_CAP_FILE="$CAP" keel watch "$RUN"
KEEL_CAP_FILE="$CAP" keel get "$RUN"       # run projection (JSON)
KEEL_CAP_FILE="$CAP" keel output "$RUN"    # terminal output (JSON)
```

Other useful verbs:

```bash
KEEL_CAP_FILE="$CAP" keel resume "$RUN"
KEEL_CAP_FILE="$CAP" keel retry "$RUN"
KEEL_CAP_FILE="$CAP" keel rewind "$RUN" <stepKey>
KEEL_CAP_FILE="$CAP" keel fork "$RUN" [atStepKey]
```

Omit `--input` for `{}`. Pass valid JSON through `--input` for any other input.

## 9. Tips

- Use **absolute paths** for the code you're reviewing.
- On optional review fan-out agents, set **`toolPolicy: "read-only"`**, **`lenient:
  true`**, and **`onFailure: "null"`** so one flaky branch doesn't sink the run.
  For required agents, omit `onFailure` so failures can be retried.
- A run resumes from its immutable launch-time workflow snapshot. Edit the source
  file only when you intend a later rerun with a source override to snapshot new
  code.
- Use individual CLI verbs when judgment is needed between steps; use `execute`
  when the next step is mechanical.
