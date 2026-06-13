# Writing & running a Keel workflow

A **workflow** is an `async (ctx, input) => output` function. You call agents and
do work through `ctx`; Keel runs it durably and survives crashes. Write a `.ts`
file, then run it with `keel launch`.

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
- **Workflow code imports only the authoring SDK** (`@kcosr/keel`) and local
  helper modules. Do not import operator/control APIs such as
  `@kcosr/keel/execute`.
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

## 7. Run it

```bash
keel launch ./adversarial-review.workflow.ts '{"root":"/abs/path/to/code"}'
```

`keel launch` watches by default. Use `keel launch --detach ...` when you need a
run id for scripting; detached launch returns JSON with `runId` and
`capabilityRef`, and follow-up commands need that cap file:

```bash
LAUNCH=$(keel launch --detach ./adversarial-review.workflow.ts '{"root":"/abs/path/to/code"}')
RUN=$(printf '%s' "$LAUNCH" | jq -r .runId)
CAP=$(printf '%s' "$LAUNCH" | jq -r .capabilityRef)
KEEL_CAP_FILE="$CAP" keel watch "$RUN"
KEEL_CAP_FILE="$CAP" keel get "$RUN"       # final result (JSON)
```

Omit the input argument for `{}`. Pass valid JSON for any other input.

## 8. Tips

- Use **absolute paths** for the code you're reviewing.
- On optional review fan-out agents, set **`toolPolicy: "read-only"`**, **`lenient:
  true`**, and **`onFailure: "null"`** so one flaky branch doesn't sink the run.
  For required agents, omit `onFailure` so failures can be retried.
- A run resumes from its immutable launch-time workflow snapshot. Edit the source
  file only when you intend a later rerun/adopt-latest path to snapshot new code.
- Use `keel execute` for short stateless control scripts that launch/resume/wait
  and shape JSON output. Do not put durable orchestration state in `execute`;
  durable pauses belong in workflow code.
