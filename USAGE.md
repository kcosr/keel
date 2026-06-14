# Keel Usage Reference

Keel is a durable agent-workflow orchestrator. A workflow is an ordinary
`async (ctx, input) => output` TypeScript function; every external effect goes
through `ctx.*` and is journaled by a single-writer daemon. If the process dies,
resuming re-runs the workflow body and replays completed effects from the
journal, so only incomplete work runs again.

Use this file as the operational reference: install, run, command syntax, paths,
workflow API, agent API, daemon behavior, and current limitations. For a compact
agent-facing authoring guide, read [`SKILL.md`](./SKILL.md). For repository
working conventions, read [`AGENTS.md`](./AGENTS.md). `DESIGN.md` is architecture
and design-history material, not the command/API reference.

## Contents

- [Quick Start](#quick-start)
- [CLI Reference](#cli-reference)
- [Paths, State, And Workspaces](#paths-state-and-workspaces)
- [Workflow Authoring](#workflow-authoring)
- [Agent Calls](#agent-calls)
- [Capabilities And Secrets](#capabilities-and-secrets)
- [Durability Features](#durability-features)
- [API Reference](#api-reference)
- [Development And Operations](#development-and-operations)
- [Known Limitations](#known-limitations)

## Quick Start

Keel runs on [Bun](https://bun.sh). The repo is self-contained.

### Install The CLI

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /path/to/keel
bun link
keel help
```

`bun link` creates a live symlink to this repo, so edits take effect without
reinstalling. Without the link, run the CLI directly:

```bash
bun /path/to/keel/src/cli/keel.ts help
```

### Start The Daemon

```bash
keel daemon
```

For local systemd usage in this workspace, see [`AGENTS.md`](./AGENTS.md).

### Launch A Workflow

```bash
keel launch ./path/to/workflow.ts --input '{"n":3}'
```

The CLI reads `workflow.ts` locally and sends the TypeScript source to the
daemon. The daemon never opens the client path. Omit the file to read workflow
source from stdin:

```bash
cat ./path/to/workflow.ts | keel run --input '{"n":3}'
```

Lifecycle commands watch by default. Attached `launch` streams newline-delimited
JSON frame envelopes by default until the run reaches a terminal state:

```json
{"kind":"durable","seq":1,"type":"run.started","payload":{"name":"workflow.ts"},"atMs":...}
...
```

Use `--output text` when you want the compact human transcript; adjacent live
agent text/reasoning chunks are coalesced into readable paragraphs.

Use `--detach` when a script needs the run id without streaming:

```bash
LAUNCH=$(keel launch --detach ./path/to/workflow.ts --input '{"n":3}')
RUN=$(printf '%s' "$LAUNCH" | jq -r .runId)
CAP=$(printf '%s' "$LAUNCH" | jq -r .capabilityRef)
KEEL_CAP_FILE="$CAP" keel watch "$RUN"
KEEL_CAP_FILE="$CAP" keel get "$RUN"
KEEL_CAP_FILE="$CAP" keel output "$RUN"
KEEL_CAP_FILE="$CAP" keel report "$RUN"
```

Omit `--input` for `{}`:

```bash
keel launch ./path/to/no-input.workflow.ts
```

Pass valid JSON through `--input` for any other input, including `null` or `""`.
An empty `--input` value is rejected so script mistakes are visible.

### Link Workflows Outside This Repo

Workflow files import the SDK as `@kcosr/keel`:

```ts
import { jsonSchema, type Ctx } from "@kcosr/keel";
```

Inside this repo that resolves automatically. For workflows in another
directory, link the SDK once:

```bash
keel link ~/my-workflows
```

## CLI Reference

Run `keel help` for the command list and `keel help <command>` for command-level
usage.

The installed command and the source command are equivalent:

```bash
keel <command> [args]
bun src/cli/keel.ts <command> [args]
```

### Command Summary

| Command | Purpose |
|---|---|
| `daemon` | Start the daemon in the foreground. |
| `link [dir]` | Symlink this repo's SDK into `<dir>/node_modules`; defaults to the current directory. |
| `launch [workflow.ts] [--name n] [--input json] [--output json\|text\|ndjson] [--tools] [--detach] [--emit-capability]` | Start a run from client-captured workflow source. Attached launch streams NDJSON by default; detached launch prints JSON. |
| `run [workflow.ts] [--name n] [--input json] [--output json\|text\|ndjson] [--tools]` | Launch a run and print a JSON envelope, text transcript, or NDJSON events. |
| `watch <runId> [--output ndjson\|text] [--tools]` | Stream run events until terminal. |
| `get <runId>` | Print the canonical run projection as JSON. |
| `output <runId> [--output json\|text]` | Print the terminal workflow output. |
| `report <runId> [--output json\|text]` | Print a journaled per-node result digest. |
| `list [--output text\|json]` | List runs as an aligned table or JSON envelope. Requires admin. |
| `gc` | Prune unreferenced workflow definition rows and cache entries. Requires admin. |
| `resume [--detach] [--tools] <runId>` | Resume a parked or incomplete run. Watches by default. |
| `retry [--detach] [--tools] <runId>` | Re-run a failed run from its failed step. Watches by default. |
| `rewind [--detach] [--tools] <runId> <stepKey>` | Discard everything after a step and re-run. Watches by default. |
| `fork <runId> [atStepKey]` | Copy a terminal run into a new independent run. |
| `execute [file] [--entry name] [--state file] [--cap-file file] [--output json] [--emit-capability] [-- args...]` | Run a stateless TypeScript control script over the daemon API. Omit `file` to read stdin. |
| `approve <runId> <key> [note]` | Approve a `ctx.human` gate. |
| `deny <runId> <key> [note]` | Deny a `ctx.human` gate. |
| `signal <runId> <name> [json]` | Deliver a payload to `ctx.signal(name)`. |

### Attach And Detach Behavior

`launch`, `resume`, `retry`, and `rewind` attach by default:

```bash
keel retry run_...
```

Attached `launch` defaults to NDJSON and does not print a text header. Attached
`resume`, `retry`, and `rewind` print `run <runId>` first and then behave like
`keel watch <runId> --output text`.

Use `--detach` for background operation:

```bash
keel launch --detach ./workflow.ts --input '{"target":"src"}'
keel resume --detach run_...
keel retry --detach run_...
keel rewind --detach run_... step-key
```

Attached `launch` defaults to `--output ndjson`; use `--output text` for a human
transcript. Detached `launch` defaults to `--output json` and prints `runId` plus
`capabilityRef`. The capability file contains the bearer token needed for
follow-up control of that run. Detached `resume`, `retry`, and `rewind` print the
run id and status separated by a tab.

`launch --output json` is only valid with `--detach`; attached launch streams
events, so `--output json` is rejected there. `launch --detach --output ndjson`
is also rejected because detached launch returns a snapshot handle, not a stream.

### Watch Output

Default watch output is newline-delimited JSON frame envelopes. Durable frames
have `kind:"durable"` plus a per-run `seq`; live agent delta frames have
`kind:"ephemeral"` and no sequence because they are delivered only to currently
connected watchers. Finalized tool calls/results are durable immediately as
`agent.tool_call`/`agent.tool_result` rows; live text/reasoning remains
`agent.event` and is not backfilled.

```bash
keel watch run_...
```

```json
{"kind":"durable","seq":1,"type":"run.started","payload":{"name":"review.workflow.ts"},"atMs":...}
{"kind":"ephemeral","type":"agent.event","payload":{"key":"review:auth","event":{"type":"text","data":"..."}},"atMs":...}
{"kind":"durable","seq":3,"type":"agent.tool_call","payload":{"key":"review:auth","attempt":1,"toolCallId":"toolu_...","data":{"name":"Read","args":{"file":"a.ts"}}},"atMs":...}
{"kind":"durable","seq":4,"type":"agent.message","payload":{"key":"review:auth","attempt":1,"text":"..."},"atMs":...}
```

Use `--output text` for human-oriented compact output. Adjacent live `text` and
`reasoning` chunks from the same agent key are rendered under one header, while
durable final messages still print as their own rows:

```text
[1] run.started {"name":"review.workflow.ts"}
[2] phase: Find
[live] agent review:auth text: streaming answer...
[3] agent review:auth message: streaming answer...
[4] step.completed review:auth (effectful)
[5] run.finished
```

Text mode hides agent tool calls and tool results by default. Add `--tools` to an
attached text command when you want those details:

```bash
keel watch run_... --output text --tools
keel run --output text --tools ./workflow.ts --input '{"n":3}'
```

Durable history is transcript-unit-granular, not token-granular. Live token and
reasoning deltas are not backfilled and are not stored in SQLite; a watcher that
connects mid-message receives live deltas from that point forward. Complete tool
calls/results are appended and pushed as durable rows as soon as Keel observes
them. A non-empty final assistant answer is appended at successful turn
completion as one `agent.message` row containing the final `AgentResult.text`,
not an interleaving of earlier text deltas. New transcript rows include
`attempt`; tool rows include `toolCallId` when the provider supplies a stable id.
Retries or recovery can produce duplicate-looking durable tool rows, which are
kept as append-only audit history.

### Run, Output, And Report Formats

`keel run` defaults to `--output json`, a single envelope containing `runId`,
`capabilityRef`, `status`, and terminal `output`/`error`/`blockage` fields when
present.

Use `keel run --output ndjson` to render the same attached execution as event
envelopes while it runs, or `keel run --output text` for the compact transcript.
Use `--tools` with text output to include agent tool call/result lines; NDJSON
always includes every delivered frame.
`--output` and `--tools` change rendering only; they do not change whether `run`
starts and attaches to the workflow.

```bash
keel run --output text ./workflow.ts --input '{"n":3}'
keel run --output ndjson ./workflow.ts --input '{"n":3}'
```

`keel output <runId>` defaults to JSON and prints only the terminal workflow
output. `keel output <runId> --output text` prints string outputs directly and
other JSON values compactly.

`keel report <runId>` defaults to JSON and prints a post-run digest derived from
journaled node results, not raw event transcripts. `--output text` prints a
compact per-node status/result summary. `--output ndjson` is invalid for
`report`.

### List Output

`keel list` defaults to `--output text` and prints an aligned, human-oriented
UTC table in `createdAtMs` ascending order (oldest first):

```text
RUN ID     STATUS    WORKFLOW  CREATED                   DURATION
run_...    finished  review    2026-06-14T01:02:03.004Z  12m
```

The table columns are `RUN ID`, `STATUS`, `WORKFLOW`, `CREATED`, and `DURATION`.
`WORKFLOW` shows `(unnamed)` for unnamed runs and may be shortened for terminal
readability; use JSON for exact values. Durations are compact floor-rounded
milliseconds/seconds/minutes/hours/days (`ms`, `s`, `m`, `h`, `d`). Terminal runs
use `finishedAtMs - createdAtMs`; active or waiting runs use the command's
current time minus `createdAtMs`. Empty lists still print the header row.

Use `keel list --output json` for scripts. It returns a CLI envelope while the
RPC method remains a bare `RunSummary[]`:

```json
{"runs":[{"runId":"run_...","status":"finished","workflowName":"review","createdAtMs":1781414349314,"finishedAtMs":1781415069314,"parentRunId":null}]}
```

`--output ndjson` is invalid for `list`.

### Exit Codes

- `0`: command succeeded; attached run reached `finished` or `continued`.
- `1`: attached run reached `failed`, JSON parsing failed, provider execution
  failed, or another runtime error occurred.
- `2`: command usage error.
- `3`: `keel run` reached a parked/non-terminal status such as `waiting-human`.

## Paths, State, And Workspaces

### Daemon State

By default the daemon stores local state under `~/.keel`:

| Setting | Default | Meaning |
|---|---|---|
| `KEEL_DIR` | `~/.keel` | Base directory for default socket and database paths. |
| `KEEL_SOCKET` | `$KEEL_DIR/keel.sock` | Unix socket used by CLI clients. |
| `KEEL_DB` | `$KEEL_DIR/keel.db` | SQLite journal database owned by the daemon. |

The daemon is the single writer for the journal. CLI clients connect over the
socket and do not open the database directly.

### Workflow Source Capture

`keel launch [workflow.ts]` and `keel run [workflow.ts]` use one source-delivery
rule: an optional positional is a file path read by the CLI; omitting it reads
source from stdin. With no positional and a terminal stdin, the CLI fails instead
of waiting forever.

Workflow input is always passed with `--input <json>`. The positional slot is
only source, never input. `--name` is an optional display label; if omitted for
stdin launches, the run is unnamed (`null` in JSON, `(unnamed)` in text output).
Names are not handles and may repeat. Use run ids for follow-up commands.

On launch, the daemon stores an immutable workflow definition snapshot by content
hash and runs from a daemon-owned materialized cache. Resume, retry, rewind,
fork, and crash recovery use the stored definition, never a client path.
`rerun` with a source override snapshots the supplied source as a new definition.
Workflow source is persisted verbatim in the journal database; do not embed
secrets in workflow TypeScript.

Client-captured workflow v1 is single-file only. The only external import a
workflow source may use is the exact SDK import `@kcosr/keel`; relative imports,
SDK subpaths, and arbitrary packages are rejected. `@kcosr/keel` resolves through
the current daemon's workflow SDK bridge, guarded by the workflow SDK ABI stored
in the definition manifest. Compatible Keel upgrades can resume existing
definitions; a daemon that does not support the stored ABI fails the run with a
required-versus-supported ABI error.

### Workspace Root

`KEEL_WORKSPACE_ROOT` points to the git repository root used when an agent sets
`workspaceIsolation: true`:

```bash
KEEL_ADMIN_TOKEN=kc_admin_local \
  KEEL_WORKSPACE_ROOT=/home/kevin/worktrees/keel \
  keel daemon
```

Agents that do not request workspace isolation do not require a workspace root.
An agent with `workspaceIsolation: true` fails closed without one; it does not
fall back to editing the daemon cwd.

When enabled, the agent works in an isolated git worktree at the run's base
commit. Its changes are captured as an `agent.diff` event and are not merged
into the real tree automatically.

### Authorization

Keel uses daemon-enforced bearer capabilities. Launch is open to local callers,
but controlling an existing run requires a run capability or an admin
capability. The daemon stores only token hashes.

By default, commands that create a protected run write a capability file under
`$KEEL_CAP_DIR` or `$KEEL_DIR/caps` and return a `capabilityRef`:

```bash
keel launch --detach ./workflow.ts --input '{"n":3}'
```

```json
{"runId":"run_...","capabilityRef":"/home/me/.keel/caps/run_....cap"}
```

Use the cap file for follow-up commands:

```bash
KEEL_CAP_FILE=/home/me/.keel/caps/run_....cap keel get run_...
KEEL_CAP_FILE=/home/me/.keel/caps/run_....cap keel resume run_...
```

Credential channels:

| Setting | Meaning |
|---|---|
| `KEEL_RUN_CAP` | Raw run bearer capability for one run. |
| `KEEL_CAP_FILE` | JSON cap file containing a `capability` field. |
| `KEEL_ADMIN_TOKEN` | Admin capability bootstrap/use channel. |
| `KEEL_CAP_DIR` | Directory where new cap files are written; files are mode `0600`, directory mode `0700`. |

Start the daemon with `KEEL_ADMIN_TOKEN=kc_admin_...` to bootstrap that token as
an admin capability. Admin is required for daemon-wide `list` and
`approve`/`deny` of `ctx.human` gates. Raw run capabilities are printed only
with explicit `--emit-capability`; avoid this in transcripts unless you intend
to handle the token as a secret.

Socket `authenticate` records the credential for later requests on that
connection. It does not validate by itself; protected daemon methods return the
authorization error if the credential is invalid, revoked, expired, or scoped to
another resource.

### Execute

`keel execute` runs a stateless TypeScript control script outside the workflow
realm. The script receives injected `keel`, `args`, `state`, and `env` variables
and must return a JSON-serializable value. Stdout is always that returned JSON;
runtime/authorization errors are structured JSON on stderr with a nonzero exit.

```bash
keel execute ./control.ts -- root security
keel execute < control.ts
keel execute ./control.ts --entry resume --state state.json --cap-file run.cap
```

Example control script:

```ts
const run = await keel.launch({
  workflow: "./review.workflow.ts",
  input: { root: args[0] },
});

const settled = await keel.wait(run.runId, { timeoutMs: 30_000 });
return {
  runId: run.runId,
  capabilityRef: run.capabilityRef,
  status: settled.status,
};
```

`execute` is not durable orchestration. It can be re-invoked with non-secret
state handles, but durable pauses belong in workflow code via `ctx.human`,
`ctx.signal`, and `ctx.sleep`. Saved workflows/tasks and `ctx.spawn` are
deferred.

### Diagnostics

Set `KEEL_PI_RAW_LOG` to capture raw Pi stdout/stderr diagnostics:

```bash
KEEL_PI_RAW_LOG=/tmp/pi.jsonl keel daemon
```

Treat this file as secret-bearing and delete it after debugging.

## Workflow Authoring

A workflow module default-exports `async (ctx, input) => output`.

```ts
import type { Ctx } from "@kcosr/keel";
import { passthrough } from "@kcosr/keel";

const num = passthrough<number>();

export default async function example(ctx: Ctx, input: { n: number }): Promise<number> {
  return ctx.step("double", num, { n: input.n }, ({ n }) => n * 2);
}
```

Workflow inputs and outputs must be JSON-serializable.

### Determinism Rules

The determinism lint runs before launch/resume and rejects unsupported workflow
code:

- Do not use ambient non-determinism in the workflow body: `Date.now()`,
  `new Date()`, `Math.random()`, `crypto`, `fetch`, `eval`, `new Function`,
  `require`, `Bun.*`, or direct `fs`/`child_process`/`http` imports.
- Workflow code may import the authoring SDK `@kcosr/keel`, but must not import
  operator/control APIs such as `@kcosr/keel/execute`.
- Use `ctx.now()` and `ctx.random()` for journaled time and entropy.
- A `ctx.step` callback must be a pure function of its explicit `inputs`. Do not
  close over enclosing-scope data inside the callback; pass values through
  `inputs`.

Module-level helpers are allowed. Editing helper code participates in step
versioning and can cause affected steps to re-run.

### The `ctx` API

| Member | What It Does |
|---|---|
| `step(key, schema, inputs, fn, opts?)` | Pure, memoized step. Re-runs only if inputs or version change. |
| `agent(spec)` | Journaled LLM agent call. A completed agent effect never re-runs on resume. |
| `agentSession(spec)` | Realm-only logical agent participant with multiple durable `.turn(...)` calls in one backend conversation. |
| `now()` / `random()` | Journaled wall-clock and entropy. Recorded once, replayed thereafter. |
| `sleep(key, ms)` | Durable sleep. Parks the run until the supervisor wakes it. |
| `human(spec)` | Park until a human approval/denial is delivered. |
| `signal(name)` | Park until an external signal payload is delivered. |
| `continueAsNew(input)` | End this run as `continued` and start a fresh run of the same workflow. |
| `stepKey(name, id)` | Build a stable fan-out key from semantic name plus content-derived id. |
| `log(msg, data?)` / `phase(title)` | Advisory narration to the event log. |

Fan-out is plain `Promise.all` over `ctx.agent` or `ctx.step` calls. Keys must be
stable across resumes, so derive fan-out keys from content, not array index:

```ts
ctx.stepKey("verify", `${finding.file}|${finding.title}`);
```

## Agent Calls

```ts
import { jsonSchema } from "@kcosr/keel";

const Finding = jsonSchema<{ title: string; severity: "high" | "low" }>({
  type: "object",
  additionalProperties: false,
  required: ["title", "severity"],
  properties: {
    title: { type: "string" },
    severity: { type: "string", enum: ["high", "low"] },
  },
});

const finding = await ctx.agent({
  key: "review:auth",
  prompt: "Review the auth module for security issues.",
  provider: "pi",
  schema: Finding,
  toolPolicy: "read-only",
  reasoning: "high",
  onFailure: "null",
  lenient: true,
});
```

### AgentSpec Fields

| Field | Meaning |
|---|---|
| `key` | Required stable key for this agent effect. |
| `prompt` | Prompt text sent to the provider. |
| `profile?` | Named preset resolved before identity/versioning. Programmatic only on the bundled daemon. |
| `provider?` | `"pi"`, `"claude"`, or `"mock"`. |
| `schema?` | Structured output schema. If present, replies are validated. |
| `model?` | Provider model name. |
| `reasoning?` | Provider reasoning/thinking effort. Pi supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `toolPolicy?` | `"none"`, `"read-only"`, `"workspace-write"`, or `"unrestricted"`. Defaults to `"read-only"`. |
| `allowTools?` | Provider-native tool additions after policy resolution. |
| `denyTools?` | Provider-native tool removals after policy resolution. |
| `workspaceIsolation?` | Explicit opt-in to isolated worktree execution and `agent.diff` capture. |
| `capabilities?` | Explicit normalized capability declaration used when `toolPolicy` is omitted. |
| `secrets?` | Secret names to inject from the side channel. |
| `onFailure?` | `"throw"` by default, or `"null"` to tolerate terminal failure. |
| `maxRetries?` | In-session structured-output validation retries. Default: `2`. |
| `lenient?` | Opt into tolerant structured-output coercion. Default: strict validation. |
| `timeoutMs?` | Per-attempt stall timeout. Default: `1 hour`. |
| `stallRetries?` | Retries after stalled attempts. Default: `1`. |
| `bump?` / `version?` | Explicit version controls for invalidation. |

### Structured Output

With `schema`, Keel injects the JSON Schema into the prompt and validates the
reply. Validation is strict by default. Set `lenient: true` for tolerant coercion
of common model drift such as lowercase enums, number-to-string values, and
unknown fields.

If validation fails, the provider is re-invoked inside the same agent session up
to `maxRetries`.

### Failure Handling

Terminal agent failures throw by default and fail the run. Use
`onFailure: "null"` only for optional fan-out where partial results are intended:

```ts
const results = await Promise.all(optionalPrompts.map((prompt) =>
  ctx.agent({ key: ctx.stepKey("review", prompt.id), prompt, onFailure: "null" }),
));
const present = results.filter(Boolean);
```

When `onFailure: "null"` is used, the `null` result is journaled as completed; a
later resume replays `null` rather than calling the agent again.

### Session Resume

Pi and Claude session tokens are captured write-ahead. If the daemon dies during
an agent call, resume reconnects to the same provider session when possible
rather than starting a fresh call.

## Agent Sessions

Use `ctx.agentSession` when one logical participant must carry backend
conversation memory across multiple durable turns:

```ts
const primary = ctx.agentSession({
  key: "primary",
  provider: "pi",
  toolPolicy: "read-only",
});

await primary.turn({
  key: "draft",
  prompt: "Remember this code word for the next turn: alpha-123. Return JSON.",
  schema: Ack,
});

const recalled = await primary.turn({
  key: "recall",
  prompt: "What code word did I ask you to remember earlier?",
  schema: Recall,
});
```

The participant key identifies the logical agent. Each turn key identifies one
journaled interaction and is derived internally as `__session.<agent>.<turn>`.
Both keys must match `[A-Za-z0-9_-]+`; ordinary `ctx.step` and `ctx.agent` keys
may not start with `__session.`.

Participant identity is fixed for the run after profiles, tool policy, allowed
tools, denied tools, capabilities, workspace isolation, and secret names are
resolved. Changing the participant identity or reusing a turn key with a changed
prompt/schema/options fails the run instead of starting a fresh backend session.

Session participants require providers that support stable backend sessions
(`pi`/Codex and `claude`). A later turn must resume from the latest completed
session token; if the token is missing or the provider cannot resume, the turn
fails. `workspaceIsolation: true` is not supported for `ctx.agentSession` yet.
If `onFailure: "null"` is set, a tolerated failure can complete as `null` only
after a session token has been captured.

Runs that use `ctx.agentSession` can resume after crashes and can retry failed
turns, but `rerun`, `rewind`, and `fork` reject them. Start a fresh run when you
need to change completed session history.

Crash resume and retry are at-least-once with respect to the backend
conversation: a turn prompt may be delivered again if the prior attempt reached
the provider but did not commit in Keel. Completed turn outputs replay from the
journal on any host, but sending a new turn requires access to the provider's
local session state on the host where that backend conversation lives.

## Capabilities And Secrets

Agents default to read-only provider tools. Use `toolPolicy: "none"` to disable
tools, or declare broader access with `toolPolicy` or explicit `capabilities`.
If both `toolPolicy` and `capabilities` are set, `toolPolicy` controls provider
tools. `toolPolicy: "unrestricted"` cannot be combined with `allowTools` or
`denyTools` until provider-native deny semantics are supported.

```ts
toolPolicy: "read-only";
capabilities: {
  fs: "workspace-write",
  network: "none",
  shell: false,
  secrets: ["DEPLOY_KEY"],
};
allowTools: ["Bash"];
denyTools: ["LS"];
workspaceIsolation: true; // opt into worktree + diff capture
```

Capability enforcement is mapped to provider-specific tool flags in one place,
including Pi and Claude mappings.

Filesystem capability levels:

| Level | Meaning |
|---|---|
| `"none"` | No file tools. |
| `"read"` | Read, grep, and list. |
| `"workspace-write"` | Edit/write in an isolated workspace. |

Secrets named in `secrets` are injected from a side channel keyed by run. They do
not enter the journal. Exact secret values are also redacted from final output,
streamed events, captured diffs, and tolerated-failure errors.
Agents with secrets and write/shell capabilities or provider-native
`allowTools` additions must set `workspaceIsolation: true`.

The bundled `keel daemon` does not yet construct a `SecretStore`; secret
injection requires constructing `RealmKernel` or `KeelDaemon` programmatically
with one. Redaction still runs harmlessly when no values are present.

## Durability Features

### Durable Sleep

```ts
await ctx.sleep("hourly", 3_600_000);
```

The run parks at `waiting-timer` and the daemon supervisor wakes it. The sleep
key is part of the durable identity; changing the key or duration creates a new
timer identity.

### Human Approval

```ts
const decision = await ctx.human({
  key: "approve-deploy",
  prompt: "Approve deployment?",
});
```

Deliver a decision from the CLI:

```bash
keel approve "$RUN" approve-deploy "looks good"
keel deny "$RUN" approve-deploy "needs changes"
```

### Signals

```ts
const payload = await ctx.signal("proceed");
```

Deliver a signal:

```bash
keel signal "$RUN" proceed '{"go":true}'
```

Signals are ordered. The Nth `ctx.signal(name)` consumes the Nth delivered signal
with that name.

### Time Travel

`retry`, `rewind`, and `fork` operate on durable journal state:

- `retry` requires a failed run and drops the failed rows so they re-execute.
- `rewind` truncates the journal after a chosen step, decrements artifact
  refcounts for discarded rows, and clears unresolved waits.
- `fork` copies a terminal run's journal prefix into a new independent run.

### Schedules

Schedules pin the workflow definition hash captured when the schedule is created.
They do not reread a path or automatically adopt later source edits. Existing
path-based schedules from older databases are disabled by migration and should
be recreated from current source. If a pinned definition requires an unsupported
workflow SDK ABI, the daemon disables that schedule and persists the ABI error
instead of retrying it on every supervisor tick.

## API Reference

All clients speak the same `KeelApi` contract. The daemon exposes it over the
Unix socket; tests and embedded callers may use it in-process.

### LaunchRequest

```ts
interface LaunchRequest {
  source: string;
  input: unknown;
  name?: string | null;
  provenance?: { kind: "stdin" } | { kind: "clientPath"; path: string };
}
```

`source` is workflow TypeScript captured by the client. `provenance` is
display-only; the daemon never opens or parses it for execution.

### KeelApi

```ts
interface KeelApi {
  launchRun(req: LaunchRequest): Promise<RunLaunchResult>;
  resumeRun(runId: string): Promise<RunStart>;
  rerunRun(
    runId: string,
    opts?: { source?: string; input?: unknown; name?: string | null; provenance?: LaunchRequest["provenance"] },
  ): Promise<RunStart>;
  retryRun(runId: string): Promise<RunStart>;
  rewindRun(runId: string, toStableKey: string): Promise<RunStart>;
  forkRun(runId: string, opts?: { atStableKey?: string; newRunId?: string }): RunLaunchResult;
  getRun(runId: string): RunProjection | null;
  getBlockage(runId: string): Blockage;
  listRuns(): RunSummary[];
  waitForRun(runId: string): Promise<RunOutcome>;
  getRunOutput(runId: string): Promise<RunOutcome>;
  gcDefinitions(opts?: { ttlMs?: number; cacheMinAgeMs?: number }): Promise<{
    workflowDefinitionsRemoved: number;
    definitionCacheEntriesRemoved: number;
  }>;
  subscribeEvents(
    runId: string,
    afterSeq: number,
    onEvent: (event: EventEnvelope) => void,
  ): () => void;
}

interface RunLaunchResult {
  runId: string;
  capability?: string;
  capabilityId?: string;
}

interface RunSummary {
  runId: string;
  workflowName: string | null;
  status: RunProjection["status"];
  createdAtMs: number;
  finishedAtMs: number | null;
  parentRunId: string | null;
}
```

Lifecycle methods start work in the background and return a `RunStart` or run id.
Use `waitForRun` to wait for terminal status or `subscribeEvents` to stream
events. The daemon returns a raw run capability on launch/fork so clients can
establish authority for follow-up operations. The CLI writes that capability to a
local cap file by default and only prints raw tokens with `--emit-capability`.
`gcDefinitions` is an admin operation.

### EventEnvelope

```ts
type EventEnvelope = DurableEventEnvelope | EphemeralEventEnvelope;

interface DurableEventEnvelope {
  kind: "durable";
  seq: number;
  type: string;
  payload: unknown;
  atMs: number;
}

interface EphemeralEventEnvelope {
  kind: "ephemeral";
  type: string;
  payload: unknown;
  atMs: number;
}
```

Durable `seq` is monotonically increasing per run. `subscribeEvents(runId,
afterSeq, ...)` first backfills durable rows with `seq > afterSeq`, then tails
new durable rows and live ephemeral agent frames pushed by the daemon. Ephemeral
frames are never replayed for late subscribers.

## Development And Operations

### Checks

```bash
bun test
bun run typecheck
bun run lint
```

Live provider tests are gated:

```bash
KEEL_LIVE=1 NODE_TLS_REJECT_UNAUTHORIZED=0 bun test fixtures/review-workload/live.test.ts -t LIVE
```

### Migrations

The journal upgrades older databases in place through the migration ladder in
`src/journal/migrations.ts`. Existing databases should migrate forward at daemon
startup. Runtime code should then operate against the current schema only; do not
add broad fallback branches for old schema shapes.

### Artifact GC

`store.gcArtifacts()` reclaims content-addressed blobs no journal row references.
Refcounts are recomputed from the journal, so GC self-heals after rewind/fork.

### Workflow Definition GC

`keel gc` asks the daemon to prune old unreferenced workflow definition rows and
evict rebuildable materialized cache directories. It requires admin authority.
Rows are kept when any run references their `definition_version` or any enabled
schedule references their pinned hash. Cache directories are not evicted while a
running or parked run uses that definition. `KEEL_DEFINITION_TTL_MS` overrides
the default row TTL of 30 days.

### Multiple Processes

The daemon is the single writer. A run can be launched by one client, watched by
another, and resumed by a third. A heartbeat-based ownership fence prevents two
daemons from driving the same run; after restart, the daemon reclaims orphaned
runs.

## Known Limitations

- Durable wait identity is stable across crash-resume of unchanged code, not
  across edits that rekey a parked wait. Changing a sleep duration, renaming a
  wait key, or inserting a wait before an existing parked site can make the run
  re-park or wait for a new signal.
- Partial `fork` does not copy durable waits. Treat divergent forks of
  wait-heavy workflows with care.
- Saved workflows, saved tasks, durable task pause/re-entry, and durable child
  workflow spawning (`ctx.spawn`) are not implemented in this v1 execute/auth
  pass.
- Workflow definition manifests include runtime/import metadata and a workflow
  SDK ABI for the daemon-provided `@kcosr/keel` bridge. Keel does not vendor
  arbitrary external packages into the journal or provide lockfile-level
  package-store replay in v1.
- SQLite is the only implemented store. Postgres compatibility is a discipline
  enforced by tests, not a working backend.
- Secrets and profiles are programmatic-only on the bundled daemon.
- The full 111-agent workload remains budget/target-repo dependent; shape,
  durability, and crash-resume are covered by mock scale tests and reduced live
  runs.
- OS-level sandbox enforcement is not implemented beneath provider tool flags
  and workspace isolation.
- Capability files protect against accidental cross-agent access through Keel,
  but they do not prevent token theft between unrestricted processes running as
  the same Unix user.
