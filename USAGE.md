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
and design-history material, not the command/API reference. For the cross-surface
exposure and CLI interaction convention, read
[`docs/control-surfaces.md`](./docs/control-surfaces.md). For source-backed API
orientation, read [`docs/api.md`](./docs/api.md).

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

Keel runs on [Bun](https://bun.sh) 1.3.0 or newer. The repo is self-contained.

### Install The CLI

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /path/to/keel
bun install
bun link
keel help
```

`bun link` creates a live symlink to this repo, so edits take effect without
reinstalling. Without the link, run the CLI directly:

```bash
bun /path/to/keel/src/cli/keel.ts help
```

### Start The Daemon

Run the daemon in a separate terminal:

```bash
keel daemon
```

Leave it running while other terminals use the CLI. For systemd or other local
service setup, use the same daemon environment variables described in
[Daemon State](#daemon-state) and [Development And Operations](#development-and-operations).

### Launch A Workflow

For a copy-paste smoke workflow:

```bash
keel run --input '{"n":3}' <<'TS'
import { jsonSchema, type Ctx } from "@kcosr/keel";

const num = jsonSchema<number>({ type: "number" });

export default async function workflow(ctx: Ctx, input: { n: number }) {
  return ctx.step("double", num, { n: input.n }, ({ n }) => n * 2);
}
TS
```

To launch a workflow file:

```bash
keel launch ./path/to/workflow.ts --input '{"n":3}'
```

The CLI reads `workflow.ts` locally, captures any static local `.ts`/`.tsx`
helper imports reachable from it, and sends that source bundle to the daemon.
The daemon never opens the client path. Omit the file to read a single workflow
source module from stdin:

```bash
cat ./path/to/workflow.ts | keel run --input '{"n":3}'
```

Lifecycle commands watch by default. Attached `launch` streams newline-delimited
JSON frame envelopes by default until the run finishes, fails, parks, or is
interrupted:

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
| `launch [workflow.ts] [--name n] [--input json] [--target dir] [--output json\|text\|ndjson] [--tools] [--detach] [--emit-capability]` | Start a run from client-captured workflow source. Attached launch streams NDJSON by default; detached launch prints JSON. |
| `run [workflow.ts] [--name n] [--input json] [--target dir] [--output json\|text\|ndjson] [--tools]` | Launch a run and print a JSON envelope, text transcript, or NDJSON events. |
| `watch <runId> [--output ndjson\|text] [--from beginning\|now \| --after-seq n \| --tail n] [--tools]` | Stream run events until terminal or parked. |
| `get <runId>` | Print the canonical run projection as JSON. |
| `output <runId> [--output json\|text]` | Print the terminal workflow output. |
| `report <runId> [--output json\|text]` | Print a journaled per-node result digest. |
| `list [--output text\|json]` | List runs as an aligned table or JSON envelope. Requires admin. |
| `workflow save/install/list/show/source/run/disable/enable/...` | Manage saved workflow names and immutable versions, install curated review workflows, and display retained workflow definition source. |
| `schedule put <name> [workflow.ts\|--workflow saved-name] --interval-ms ms [--target dir]` | Create or replace a pinned workflow schedule. Requires admin. |
| `schedule list [--enabled-only] [--output text\|json]` | List pinned workflow schedules. Requires admin. |
| `schedule show <name> [--output text\|json] [--source]` | Show one schedule projection, optionally including retained source. Requires admin. |
| `profiles list/get/set/delete/check ...` | Manage daemon-wide persistent agent profiles. Requires admin. |
| `settings list/get/set/unset/check ...` | Manage typed daemon settings. Requires admin. |
| `workspace list/show/diff/merge/discard/gc ...` | Inspect and manage retained isolated agent/session workspaces by `workspaceId`. |
| `tui [runId] [--status status] [--limit n] [--output text]` | Open an interactive run browser or direct run detail/watch view. Browser mode requires admin. |
| `gc` | Prune unreferenced workflow definition rows and cache entries. Requires admin. |
| `resume [--detach] [--tools] <runId>` | Resume a parked, interrupted, or incomplete run. Watches by default. |
| `interrupt <runId> [reason]` | Stop active work and park a non-terminal run until explicit `resume`. |
| `retry [--detach] [--tools] <runId>` | Re-run a failed run from its failed step. Watches by default. |
| `rewind [--detach] [--tools] <runId> <stepKey>` | Discard everything after a step and re-run. Watches by default. |
| `fork <runId> [atStepKey]` | Copy a terminal run into a new independent run. |
| `execute [file] [--entry name] [--state file] [--cap-file file] [--output json] [--emit-capability] [-- args...]` | Run a stateless TypeScript control script over the daemon API. Omit `file` to read stdin. |
| `approve <runId> <key> [note]` | Approve a `ctx.human` gate and acknowledge delivery/wake start. |
| `deny <runId> <key> [note]` | Deny a `ctx.human` gate and acknowledge delivery/wake start. |
| `signal <runId> <name> [json]` | Deliver a payload to `ctx.signal(name)` and acknowledge delivery/wake start. |

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
run id and status separated by a tab. `interrupt` is always a single lifecycle
mutation and prints `<runId>\tinterrupted`.

`signal`, `approve`, and `deny` are delivery-acknowledgement commands. They
print the immediate acknowledgement status after the input is durable and any
eligible wake has started. They do not stream or wait for resumed workflow work,
and they do not have `--wait`, `--attach`, or `--detach`; use `keel watch <runId>
--output text` to observe progress.

`launch --output json` is only valid with `--detach`; attached launch streams
events, so `--output json` is rejected there. `launch --detach --output ndjson`
is also rejected because detached launch returns a snapshot handle, not a stream.

### Watch Output

Default watch output is newline-delimited JSON frame envelopes. Watch exits when
the run finishes, fails, continues, parks on a durable wait, or is interrupted.
Durable frames have `kind:"durable"` plus a per-run `seq`; live agent delta frames have
`kind:"ephemeral"` and no sequence because they are delivered only to currently
connected watchers. Finalized tool calls/results are durable immediately as
`agent.tool_call`/`agent.tool_result` rows; live text/reasoning remains
`agent.event` and is not backfilled.

```bash
keel watch run_...
keel watch run_... --from now
keel watch run_... --after-seq 123
keel watch run_... --tail 100
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

Watch cursor options select the durable backfill window:

- `--from beginning` is the default and backfills all durable events.
- `--from now` skips existing durable events and tails live frames.
- `--after-seq n` starts after durable sequence `n`.
- `--tail n` backfills at most the last `n` durable events; `--tail 0` skips
  durable backfill.

`--from`, `--after-seq`, and `--tail` are mutually exclusive. If a cursor skips an
already-terminal, parked, or interrupted event, watch still exits from the
daemon's closed stream status after catch-up. See `docs/events.md` for the
shared cursor contract.

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
compact per-node status/result summary. Interrupted runs include an `interrupted`
blockage with the redacted reason, previous status, last phase, and last known
wait metadata when available. `--output ndjson` is invalid for `report`.

### List Output

`keel list` defaults to `--output text` and prints an aligned, human-oriented
UTC table in `createdAtMs` descending order (newest first, with `runId`
descending as the tiebreaker):

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

### Interactive Run Browser TUI

`keel tui` opens a terminal UI in the alternate screen. It requires interactive
stdin and stdout; `--output json` and `--output ndjson` are rejected because the
TUI is not a script output mode.

```bash
keel tui
keel tui --status running --limit 25
keel tui run_...
```

Without a positional run id, the browser calls `listRuns()` and therefore
requires admin credentials (`KEEL_ADMIN_TOKEN` or an admin capability source).
If listing is denied, use `keel tui <runId>` with a run-scoped capability to open
direct detail/watch mode for that run. Direct mode uses the same daemon `get`,
`report`, `output`, lifecycle, signal, and `subscribeEvents` RPC authorization as
the non-interactive CLI.

Browser keys: `j`/`k` or arrow keys move, `g`/`G` jump, `/` filters locally by run
id/workflow/status, `r` refreshes, `Enter` opens detail, `w` opens detail and
attaches watch, `R` resumes, `t` retries, `s` prompts for a signal, and `q`
quits. Browser columns mirror `keel list`: run id, status, workflow, created,
and client-computed duration.

Detail keys: `w` attaches/detaches a local watch subscription, `R` resumes, `t`
retries, `e` prompts for a rewind step key, `s` prompts for `ctx.signal` as
`name [json]`, `o` loads terminal output when finished, `b`/`Esc` returns to the
browser (or quits direct mode), and `q` quits. Approval decisions remain
admin-gated in v1; pressing `a` without known admin credentials reports
`approval requires admin credentials` instead of attempting a run-scoped action.

Watch uses the shared `subscribeEvents({ runId, cursor })` request shape: the
first attach uses `{ kind: "beginning" }`, reattach resumes after the last
durable sequence seen for that run, and local detach/exit only removes the TUI
subscriber. Live
`agent.event` frames are displayed while connected but are not replayable. If the
daemon emits `authorization.failed` or the subscription errors, the TUI detaches
locally and shows the error in the status line.

Successful resume, retry, rewind, signal, or admin approval actions keep the run
in detail view, refresh the projection/report, and attach watch from the last
durable sequence already seen. Daemon rejections for authorization, ownership, or
ineligible status leave the current view intact and are surfaced in the status
line. Terminal state is restored on normal quit, Ctrl-C in raw mode, command
errors, and `SIGINT`.

The PTY smoke strategy for the TUI is dev/test-only: opt-in tests should allocate
a pseudo-terminal with a system wrapper such as `script`/`unbuffer` when
available. The shipped CLI does not add native TUI or PTY runtime dependencies.

### Exit Codes

- `0`: command succeeded; attached run reached `finished` or `continued`.
- `1`: attached run reached `failed`, JSON parsing failed, provider execution
  failed, or another runtime error occurred.
- `2`: command usage error.
- `3`: `keel run` or `keel watch` reached a parked/non-terminal status such as
  `waiting-human` or `interrupted`.

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

For file launches, the CLI captures the complete static local import graph for
relative `.ts` and `.tsx` imports, including side-effect imports and re-exports.
Extensionless local imports resolve to `.ts`, `.tsx`, `index.ts`, or
`index.tsx` when exactly one target exists. The inferred bundle root is the
lowest common ancestor of the captured files, so sibling workflows can share
helpers such as `workflows/shared/review-tasks.ts` without a root flag. The
normalized entry path and every captured helper path/source byte are included in
the definition hash.

Workflow input is always passed with `--input <json>`. The positional slot is
only source, never input. `--name` is an optional display label; if omitted for
stdin launches, the run is unnamed (`null` in JSON, `(unnamed)` in text output).
Names are not handles and may repeat. Use run ids for follow-up commands.
`--target <dir>` overrides the run target (the CLI cwd); the value must be
non-empty. The selected target is stored with the run and is the path used by the
lazy default direct workspace.

On launch, the daemon stores an immutable workflow definition snapshot by content
hash and runs from a daemon-owned materialized cache. Resume, retry, rewind,
fork, schedule fire, and crash recovery use the stored definition, never a client
path. `rerun` with a source override snapshots the supplied source as a new
definition. Workflow source and helper modules are persisted verbatim in the
journal database; do not embed secrets in workflow TypeScript.

Stdin launches are still a single module named `entry.ts`; local relative
imports from stdin are rejected with guidance to launch from a file. The only
external import a workflow source may use is the exact SDK import
`@kcosr/keel`. SDK subpaths, arbitrary packages, Node/Bun builtins, dynamic
imports, unsupported extensions, symlinked source paths, and relative imports
through `node_modules` are rejected. `@kcosr/keel` resolves through the current
daemon's workflow SDK bridge, guarded by the workflow SDK ABI stored in the
definition manifest. Compatible Keel upgrades can resume existing definitions; a
daemon that does not support the stored ABI fails the run with a
required-versus-supported ABI error. The provider-config SDK addition is an ABI 5
boundary: re-register workflow definitions after upgrade, and drain suspended or
non-terminal older-ABI runs first unless Keel gains a real multi-ABI bridge.

### Targets And Run Workspaces

Every CLI/client-created run records a `target`: for `keel launch` and `keel run`
this is the client cwd, or `--target <dir>` when supplied. Raw low-level API
callers must send a non-empty target; the daemon rejects missing or blank targets
rather than substituting its own cwd.

Provider cwd always comes from a resolved run workspace, never daemon cwd. Agents
and sessions resolve workspaces in this order: an explicit `workspace` handle,
the innermost `ctx.withWorkspace`, then the lazy default direct workspace:

```ts
{ key: "__default", mode: "direct", path: ctx.run.target }
```

Direct workspaces use an existing directory and are not owned, diffed, merged,
discarded, or removed by Keel. The run target is first modeled as the lazy
`__default` direct workspace; omitted `path` for `direct`, `copy`, and
`worktree` resolves through that canonical default workspace path. Worktree
workspaces are Keel-owned git worktrees created under `KEEL_WORKSPACE_STORE`
(default: beside the journal under `KEEL_DIR/workspaces`). Worktree `path` may be
a subdirectory; Keel resolves it to the enclosing git repository root. Worktree
`ref` defaults to `HEAD`.

```ts
const workspace = await ctx.workspace({
  key: "implementation",
  mode: "worktree",
  retention: "retain-on-failure",
});
await ctx.agent({ key: "impl", workspace, toolPolicy: "workspace-write", prompt: "..." });
```

Branch-backed worktrees opt into a generated Keel-owned branch while keeping
`mode: "worktree"`:

```ts
const workspace = await ctx.workspace({
  key: "implementation",
  mode: "worktree",
  branch: true,
  retention: "retain",
});
```

`branch` is boolean-only. `branch: true` creates a valid generated ref such as
`keel/<run-hash>/<workspace-slug>-<key-hash>` at the workspace `baseCommit` and
attaches the worktree to it. Omitted or `false` keeps detached worktree behavior.
Keel does not accept user-supplied branch names in this release.

`ctx.withWorkspace(specOrHandle, fn)` binds a scoped default for all agents and
sessions inside `fn`, while explicit per-agent/session `workspace` overrides the
scope. `WorkspaceSpec.key` is required; `__default` is reserved for the run
default workspace.

Workspace modes:

- `direct` points at an existing directory, defaults to `ctx.run.target`, is not
  Keel-owned, and is never diffed, merged, discarded, GC'd, or removed by Keel.
- `worktree` creates a Keel-owned git worktree from a local repository path/ref.
  It is detached by default; `branch: true` attaches it to a generated branch.
  Both variants use final-tree patch diff/merge relative to `baseCommit`, so
  committed, staged, unstaged, untracked, deleted, and mode changes are included.
- `copy` creates a Keel-owned filesystem snapshot of a local directory, including
  dirty files, but excludes `.git` metadata at every level. It does not apply
  `.gitignore`; pass a narrower `path` when large caches, dependencies, build
  output, or virtualenvs should not be copied.
- `clone` creates a Keel-owned git clone from an explicit local path, `file://`
  URL, or remote git URL. It never defaults to `ctx.run.target`; pass
  `repo: ctx.run.target` explicitly for the current repository. Remote clone
  merge is unsupported in this release.

Keel-owned workspace retention controls terminal cleanup:

- `"remove"` (default): remove the filesystem at terminal run cleanup and hide
  the audit row from default listings.
- `"retain-on-failure"`: retain failed/cancelled runs, tolerated agent failures,
  diff errors, abandoned workspaces, or cleanup errors; remove clean successes.
- `"retain"`: retain terminal workspaces for operator review.

For durable `ctx.agentSession` participants that use a Keel-owned workspace,
choose `"retain-on-failure"` or `"retain"` when you expect to retry a terminal
failed run. If terminal cleanup removes the workspace, Keel fails closed rather
than resuming the existing backend conversation in a fresh empty workspace.

Public per-agent `workspaceIsolation`, `workspaceRetention`, and `target` fields
have been removed at the workflow SDK ABI 4 boundary. Drain non-terminal old-ABI
runs before upgrading or expect resume to fail with the unsupported-ABI error.

```bash
keel workspace list <runId> [--all]
keel workspace show <runId> <workspaceId>
keel workspace diff <runId> <workspaceId> [--output json]
keel workspace merge <runId> <workspaceId>
keel workspace discard <runId> <workspaceId>
keel workspace gc [--older-than-ms ms] [--include-pending] [--include-removed]
```

`RunWorkspaceView.workspaceId` is the canonical selector for show/diff/merge/
discard. Views include `mode`, `sourceKind`, display `key`, provider
`workspacePath`, source path/URI/ref/branch/base commit metadata, copy baseline
path, ownership, retention, merge/diff support, latest attempt/turn and active
holder metadata, `failureSeen`, timestamps, and cleanup errors. Default list
output hides idle direct workspaces such as `__default`; `--all` includes removed
audit rows and direct workspace rows.

Merge/discard are explicit operator actions and refuse while the run is
non-terminal, a Keel-owned provider invocation is active, the workspace is
direct, remote clone/local bare clone merge is requested, or the workspace has
already moved to a terminal lifecycle status such as `removed`, `merged`, or
`discarded`. Worktree and local-clone merge apply a final-tree git patch and do
not preserve commits as commits; a true commit-preserving git merge is not part
of this release. Copy merge compares the workspace to its baseline and writes
back only if the original source paths still match that baseline. Durable
`agent.diff` payloads include the
`workspaceId`, `workspacePath`, source metadata, mode/diff kind, bounded
`contentDiff`, and `fileChanges`; changed path arrays are capped with
`omittedPathCounts`/`pathLimit` metadata. Direct workspaces do not produce review
diffs in v1. Diff capture that exceeds Keel's explicit git status or diff buffers
is recorded as `workspace.diff_error`.

Terminal cleanup, `workspace discard`, and `workspace gc` remove generated
branch-backed worktree filesystem state according to retention, but do not delete
the generated branch ref. Workspace views expose `worktreeCheckoutKind`,
`checkoutBranch`, and `worktreeBranchOwned` so operators can inspect, push, or
manually delete generated branches. Branch refs are trusted-local metadata and
are not a sandbox or exfiltration boundary.

Copy and clone workspaces are trusted-local filesystem conveniences, not
sandboxes. Tool-capable providers may still read or write outside the cwd
according to their tool policy and host behavior; remote clone uses the local
user's git credentials, SSH agent, network, and git configuration. Retained
workspaces may contain sensitive files and should be discarded or garbage
collected when no longer needed.

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
KEEL_CAP_FILE=/home/me/.keel/caps/run_....cap keel interrupt run_... "inspect"
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

`keel.signal(runId, name, payload)`, `keel.approve(runId, key, opts)`, and
`keel.deny(runId, key, opts)` follow the daemon delivery-acknowledgement
contract: they return after durable delivery and wake-start handling, not after
the resumed workflow finishes. Call `keel.wait(runId)` afterwards when the script
needs the final status or output.

`keel.events({ runId, cursor })` returns an async iterable of raw event
envelopes. The cursor shape matches `keel watch`: `{ kind: "beginning" }`,
`{ kind: "now" }`, `{ kind: "after-seq", seq }`, or `{ kind: "tail", count }`.
When a cursor skips an already-closed run status, iteration completes after
catch-up instead of waiting for a skipped terminal event.

`execute` can also manage run workspaces without shelling out to the CLI:
`keel.listRunWorkspaces`, `keel.getRunWorkspace`, `keel.getRunWorkspaceDiff`,
`keel.mergeRunWorkspace`, `keel.discardRunWorkspace`, and `keel.gcWorkspaces`.
Per-run capabilities may list/get/diff workspaces for that run; merge, discard,
and GC restore the execute control credential/admin capability.

`execute` can inspect schedules with `keel.listSchedules({ includeDisabled })`
and `keel.getSchedule(name, { includeSource })`. These are daemon-wide schedule
reads, so they restore the execute control credential/admin capability.

`execute` is not durable orchestration. It can be re-invoked with non-secret
state handles, but durable pauses belong in workflow code via `ctx.human`,
`ctx.signal`, and `ctx.sleep`. Saved workflows are implemented as daemon-pinned
workflow definitions; saved tasks, durable task pause/re-entry, and durable child
workflow spawning (`ctx.spawn`) are deferred.

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
| `run.id` / `run.target` | Current run id and daemon-resolvable run target. |
| `workspace(spec)` | Resolve a run-scoped direct or worktree workspace handle. |
| `withWorkspace(specOrHandle, fn)` | Bind a scoped default workspace for agents/sessions in `fn`. |
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
| `profile?` | Named preset resolved before identity/versioning from the run's snapshotted programmatic and persistent daemon profile catalog. |
| `provider?` | `"pi"`, `"claude"`, `"codex"`, or `"mock"`. |
| `providerConfig?` | Provider-keyed JSON object map for provider-owned execution settings. Only the selected provider's entry affects identity and invocation. |
| `schema?` | Structured output schema. If present, replies are validated. |
| `model?` | Provider model name. |
| `reasoning?` | Provider reasoning/thinking effort. Pi supports `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. |
| `toolPolicy?` | `"none"`, `"read-only"`, `"workspace-write"`, or `"unrestricted"`. Defaults to `"read-only"`. |
| `allowTools?` | Provider-native tool additions after policy resolution. |
| `denyTools?` | Provider-native tool removals after policy resolution. |
| `workspace?` | `WorkspaceHandle` from `ctx.workspace`; defaults to the scoped or run default direct workspace. |
| `capabilities?` | Explicit normalized capability declaration used when `toolPolicy` is omitted. |
| `secrets?` | Secret names to inject from the side channel. |
| `onFailure?` | `"throw"` by default, or `"null"` to tolerate terminal failure. |
| `maxRetries?` | In-session structured-output validation retries. Default: `agent.defaultMaxRetries`. |
| `lenient?` | Opt into tolerant structured-output coercion. Default: `agent.defaultLenient`. |
| `timeoutMs?` | Per-attempt stall timeout. Default: `agent.defaultTimeoutMs`. |
| `stallRetries?` | Retries after stalled attempts. Default: `agent.defaultStallRetries`. |
| `bump?` / `version?` | Explicit version controls for invalidation. |

### Persistent Agent Profiles

Operators can store reusable daemon-wide profile defaults and workflows can select them with `profile: "name"`:

```bash
keel profiles list [--source all|catalog|programmatic] [--output text|json]
keel profiles get <name> [--output text|json]
keel profiles set <name> --file <path|-> [--if-generation <n>] [--create] [--update]
keel profiles delete <name> [--if-generation <n>]
keel profiles check <name> [--connect] [--output text|json]
keel profiles check --file <path|-> [--connect] [--output text|json]
```

All profile commands use the daemon connection (`KEEL_SOCKET`/`KEEL_DIR`) and require an admin credential (`KEEL_ADMIN_TOKEN` or an admin capability file). Profile JSON may include provider/model/reasoning, tool policy, allow/deny tools, capabilities, retry/timeout options, and provider-keyed `providerConfig`. It must not include prompt/key/schema/workspace/secret fields or legacy `workspaceIsolation`, `workspaceRetention`, or `target` fields.

The daemon snapshots the complete effective catalog (programmatic plus persisted catalog profiles) when a run is launched or rerun. Resume, retry, rewind, daemon restart, provider retries, and default forks keep the existing snapshot; editing or deleting a profile only affects future launches and reruns.

### Persistent Daemon Settings

Operators can inspect and tune a small typed daemon settings catalog:

```bash
keel settings list [--output text|json]
keel settings get <key> [--output text|json]
keel settings set <key> <json-value> [--if-generation <n>]
keel settings unset <key> [--if-generation <n>]
keel settings check <key> <json-value> [--output text|json]
```

All settings commands require admin authority. Values are parsed as JSON, so use
`true`, `false`, numbers, or quoted JSON strings as appropriate. Unknown keys,
invalid values, generation mismatches, and writes to read-only settings fail
clearly.

Workflow-visible agent defaults are snapshotted onto each run at launch:

```text
explicit workflow spec > named profile value > run settings snapshot
```

The snapshot is terminal at runtime. Resume, retry, rewind, daemon restart, and
fork keep the run's original workflow-visible setting values even if the live
catalog changes. Schedules capture current settings each time they fire a new
run, not when the schedule is created.

Initial workflow-visible settings:

| Key | Type | Default | Settable |
|---|---|---:|---|
| `agent.defaultTimeoutMs` | integer `> 0` | `3600000` | yes |
| `agent.defaultStallRetries` | integer `>= 0` | `1` | yes |
| `agent.defaultMaxRetries` | integer `>= 0` | `2` | yes |
| `agent.defaultLenient` | boolean | `false` | yes |
| `agent.defaultOnFailure` | `"throw"` or `"null"` | `"throw"` | no |

Initial daemon-operational settings:

| Key | Type | Default | Apply timing |
|---|---|---:|---|
| `codex.rpcTimeoutMs` | integer `> 0` | `60000` | next Codex provider construction, normally daemon restart |
| `codex.connectTimeoutMs` | integer `> 0` | `15000` | next Codex provider construction, normally daemon restart |
| `workflowDefinition.gcTtlMs` | integer `>= 0` | `2592000000` | next `gcDefinitions`/`keel gc` call unless explicitly overridden |

Named profiles remain the preferred way to configure reusable agent roles.
Settings are global fallbacks used only after the workflow spec and selected
profile leave a field unset. Settings must not contain secrets, credentials,
tokens, provider environment maps, or arbitrary provider config.

### Provider Config

`providerConfig` is a map from provider name to a plain JSON object:

```ts
await ctx.agent({
  key: "review",
  provider: "pi",
  providerConfig: {
    pi: { providerOwnedOption: true },
    claude: { unusedUnlessClaudeSelected: true },
  },
  prompt: "Review this change.",
});
```

Keel validates every entry in the supplied map as strict JSON before hashing or
calling a provider: no `undefined`, functions, symbols, bigint, non-finite
numbers, sparse arrays, cycles, `Date`, `Map`, class instances, or non-plain
objects. Provider-specific semantic validation is selected-adapter-only. Valid
unselected entries are ignored after generic validation: they are not passed to
adapters and do not affect durable identity. When no selected config exists,
Keel omits the `providerConfig` key from durable identity.

Named profiles may also define `providerConfig`. An explicit config object for
the selected provider replaces the profile's selected config as a unit; Keel does
not deep merge. Use `{}` for the selected provider to clear a profile config.
Adapters receive a deep-cloned, deeply frozen selected config object.

`providerConfig` is replay-visible execution configuration, not a secret store
and not a workspace selector. Keep raw secrets in named `secrets`, and choose
cwd/workspace behavior with `ctx.workspace`, `ctx.withWorkspace`, and
`workspace` handles.

### Codex Provider

`provider: "codex"` drives the Codex app-server JSON-RPC protocol. Codex is not
the default provider. Keel maps Codex tool access by exact resolved capability
shape:

- default / `toolPolicy: "read-only"`: Codex `read-only` sandbox with
  `networkAccess: false`;
- `toolPolicy: "workspace-write"`: Codex `workspace-write` sandbox with the
  resolved cwd as the writable root and `networkAccess: false`;
- `toolPolicy: "unrestricted"`: Codex `danger-full-access`.

`toolPolicy: "none"` is not supported for Codex because app-server has no
verified no-tools mapping. `allowTools` and `denyTools` are also rejected for
Codex until provider-native tool selection has equivalent semantics.

```ts
await ctx.agent({
  key: "edit",
  provider: "codex",
  toolPolicy: "workspace-write",
  providerConfig: {
    codex: { transport: { type: "uds", path: "/tmp/codex.sock" } },
  },
  prompt: "Make the requested change.",
});
```

Transport config is selected only through `providerConfig.codex.transport` (or a
profile that supplies it):

```ts
{ codex: { transport: { type: "stdio" } } }
{ codex: { transport: { type: "ws", url: "ws://127.0.0.1:1455/rpc" } } }
{ codex: { transport: { type: "uds", path: "/tmp/codex.sock" } } }
```

If `providerConfig.codex` is omitted, the runtime default is stdio and Keel
spawns `${KEEL_CODEX_BIN:-codex} app-server` in the resolved workspace cwd.
Omitted config and explicit `{ codex: { transport: { type: "stdio" } } }` are
intentional distinct replay identities; choose one style and keep it stable.
`ws.url` must be an absolute `ws://` or `wss://` URL. `uds.path` must be an
absolute socket path and uses WebSocket over the Unix stream with request URL
`ws://localhost/rpc`.

Remote `ws`/`uds` app-servers are assumed to share the daemon filesystem
namespace. Keel always sends the resolved workspace cwd to Codex and requires it
to be an existing absolute directory. Codex read-only and workspace-write use
Codex's own filesystem/network sandbox; these modes may still execute sandboxed
commands, so do not treat them as a no-shell guarantee. Unrestricted
`danger-full-access` is not sandboxed to the cwd and can access anything its host
runtime can access. Secret env injection is supported only for stdio; remote
transports reject non-empty `secrets` rather than silently dropping them.

Codex app-server thread ids are captured write-ahead as session tokens and are
returned from provider calls so schema retries and `ctx.agentSession` turns reuse
the same thread. On resume, Keel validates the thread id and Codex-reported cwd
before sending new input. If Codex reports the thread as active, Keel scans
recent turns with `thread/turns/list`, interrupts the discovered in-progress turn,
waits for confirmed interruption, and only then starts a fresh Keel-managed turn.
If no active turn id can be discovered, interruption cannot be confirmed, or the
remote turn reaches another terminal state before Keel confirms interruption,
Keel fails closed rather than starting a duplicate turn.

`KEEL_CODEX_BIN` changes only the local stdio binary path. `KEEL_CODEX_RAW_LOG`
enables JSONL protocol diagnostics for transport descriptors, frames, stderr,
and close events; the log can contain prompts, outputs, cwd paths, and secret
values.

Common Codex errors include malformed `providerConfig.codex.transport...`,
unsupported `none` or lossy capability shapes, allow/deny tool edits, remote
transport plus secrets, missing/unusable cwd, JSON-RPC method errors, resumed
cwd/token mismatch, unreconcilable active remote turns, and turn
failure/interruption.

A live smoke should be gated with `KEEL_LIVE=1`: point `providerConfig.codex` at
a real app-server (or use stdio), request a tiny structured JSON response with
an explicit Codex-supported tool policy, assert a session token, and verify a
completed run replays without a second provider invocation.

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

Pi, Claude, and Codex session tokens are captured write-ahead. If the daemon dies
during an agent call, resume reconnects to the same provider session when
possible rather than starting a fresh call.

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

Participant identity is fixed for the run after profiles, selected provider
config, tool policy, allowed tools, denied tools, capabilities, resolved
workspace id, and secret names are resolved. Changing the participant identity or
reusing a turn key with a changed prompt/schema/options fails the run instead of
starting a fresh backend session.

Session participants require providers that support stable backend sessions
(`pi`, `codex`, and `claude`). A later turn must resume from the latest completed
session token; if the token is missing or the provider cannot resume, the turn
fails. A session uses its explicit/scoped/default workspace across all turns and
retries; changing the workspace for an existing participant changes identity and
fails closed. A removed worktree workspace also fails closed for an existing
participant; use worktree retention `"retain-on-failure"` or `"retain"` when a
terminal failed session run should be retryable. If `onFailure: "null"` is set,
a tolerated failure can complete as `null` only after a session token has been
captured.

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
// For reviewable edits, pass a worktree WorkspaceHandle to the agent/session.
```

Capability enforcement is mapped to provider-specific tool flags in one place,
including Pi, Claude, and Codex sandbox mappings for supported capability
shapes.

Filesystem capability levels:

| Level | Meaning |
|---|---|
| `"none"` | No file tools. |
| `"read"` | Read, grep, and list. |
| `"workspace-write"` | Edit/write through provider tools. Use `worktree`, `copy`, or supported local `clone` workspaces when edits should be staged in a Keel-owned workspace and reviewed as a diff before merge. |

Secrets named in `secrets` are resolved from a side channel keyed by run and
injected into the provider invocation environment. Secret names, not raw values,
belong in workflow source and agent options. If an agent prints, streams,
returns, writes, diffs, or errors with a secret value, Keel journals that content
as-is; there is no exact-value agent-secret redaction pass. Secrets do not
require worktree mode; workspace choice is only cwd/lifecycle selection, not a
secret boundary.

The bundled `keel daemon` does not yet construct a `SecretStore`; secret
injection requires constructing `RealmKernel` or `KeelDaemon` programmatically
with one.

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
keel watch "$RUN" --output text
```

`approve` and `deny` print the acknowledgement status and exit after the decision
is durable and any eligible wake has started. They do not wait for the resumed
workflow to finish, fail, or park again.

### Signals

```ts
const payload = await ctx.signal("proceed");
```

Deliver a signal:

```bash
keel signal "$RUN" proceed '{"go":true}'
keel watch "$RUN" --output text
```

Signals are ordered. The Nth `ctx.signal(name)` consumes the Nth delivered signal
with that name. `signal` prints the acknowledgement status and exits after the
payload is durable and any eligible wake has started; it does not watch resumed
workflow progress.

### Run Interruption

```bash
keel interrupt "$RUN" "operator requested inspection"
keel resume "$RUN"
```

`interrupt` changes a non-terminal run to public status `interrupted`, appends a
durable `run.interrupted` event, and best-effort aborts active worker/provider
work. The optional reason is redacted for capability-looking tokens before it is
persisted. Completed journal rows remain committed; incomplete rows stay pending
and re-execute or recover using the same crash semantics on explicit `resume`.
Signals, approvals, timer ticks, daemon restart recovery, `retry`, `rewind`, and
`rerun` do not continue an interrupted run. Delivering a signal or approval while
interrupted records the input but returns `interrupted`; a later `resume` observes
that durable input.

### Time Travel

`retry`, `rewind`, and `fork` operate on durable journal state:

- `retry` requires a failed run and drops the failed rows so they re-execute.
- `rewind` truncates the journal after a chosen step, decrements artifact
  refcounts for discarded rows, and clears unresolved waits.
- `fork` copies a terminal run's journal prefix into a new independent run.

### Schedules

Schedules pin the workflow definition hash and default target captured when the
schedule is created, including any local helper modules captured from a workflow
file. CLI schedule creation defaults the target to the creation cwd and supports
a non-empty `--target <dir>`. Raw schedule API calls must also provide a
non-empty target. Schedules do not reread a path or automatically adopt later
source/helper edits; replace the schedule to capture a new bundle. Existing
path-based schedules from older databases are disabled by migration and should be
recreated from current source. If a pinned definition requires an unsupported
workflow SDK ABI or has an invalid persisted target, the daemon disables that
schedule and persists the error instead of retrying it on every supervisor tick.

Schedules can also be created from a saved workflow:

```bash
keel schedule put hourly-review --workflow review-loop --version 3 --interval-ms 3600000
```

The daemon resolves the saved ref at creation time, stores the resolved
definition hash, and does not track later `latest` versions. Creating or
replacing schedules is admin-only for both source and saved-ref forms.

Schedules are inspectable without reading the journal directly:

```bash
keel schedule list
keel schedule list --enabled-only --output json
keel schedule show hourly-review
keel schedule show hourly-review --source --output json
```

The read projection includes the pinned workflow definition hash, definition
availability, workflow name/kind when the definition is still present, target,
interval, next fire time, last run id/status, input, and persisted disable error.
Disabled schedules remain listed even if definition GC has removed their pinned
workflow definition; those rows report `definitionState: "missing"` and source is
`null` when requested. Invalid persisted schedule error JSON is surfaced as a
`parse-error` state rather than hiding the schedule row.

### Saved Workflows

Saved workflows are a naming layer over immutable workflow definitions. Saving a
workflow captures the same client-side source bundle as `keel run`, writes a new
append-only version, and points that version at the stored `wf_sha256_...`
definition hash.

```bash
keel workflow save review-loop ./review.workflow.ts \
  --title "Review loop" --tag review --default-input '{"n":2}' --default-target "$PWD"
keel workflow list --output json
keel workflow show review-loop --output text
keel workflow source review-loop --all
keel workflow source --run run_123 --output json
keel workflow source --definition wf_sha256_<64-hex-chars> --all
keel workflow run review-loop --input '{"n":3}' --allow-deprecated
keel workflow disable review-loop
keel workflow enable review-loop
keel workflow deprecate review-loop 2 "use v3"
keel workflow delete-version review-loop 1 --yes
```

Multi-file workflow packages are saved the same way. For the reusable task
review guidance package:

```bash
keel workflow install task-review-guidance
keel workflow install task-review-guidance --output json
keel workflow install task-review-guidance --version 2 --allow-duplicate-definition

# Lower-level manual saves remain available:
keel workflow save task-code-review workflows/task-review-guidance/code-review.workflow.ts --version 1
keel workflow save task-plan-review workflows/task-review-guidance/plan-review.workflow.ts --version 1
keel workflow save task-docs-review workflows/task-review-guidance/docs-review.workflow.ts --version 1
keel workflow run task-code-review --version 1 \
  --input '{"repository":".","task":"review the current change"}'
keel workflow run task-docs-review --version 1 \
  --input '{"repository":".","task":"review docs for the current change"}'
keel workflow source task-plan-review --version 1 --all
```

`workflow install task-review-guidance` requires admin authority because it spans
multiple saved workflow names and uses daemon-wide preview/list operations. It
captures the built-in workflow files from `keelPackageRoot()` and fails clearly
if the installed package or checkout does not include the `workflows/` source
tree. Installation is best-effort across package entries. Text output is
table-like; JSON output is stable:

```json
{
  "package": "task-review-guidance",
  "workflows": [
    {
      "name": "task-code-review",
      "version": 1,
      "status": "created",
      "definitionHash": "wf_sha256_..."
    }
  ]
}
```

Statuses are `created`, `unchanged`, `conflict`, or `failed`. Without
`--version`, an unchanged latest saved version reports `unchanged`; changed
source creates the next integer version. With `--version`, an existing matching
version reports `unchanged`, while an existing different definition reports
`conflict`. `--allow-duplicate-definition` preserves the registry behavior for
operators who intentionally want another version pointing at the same captured
definition. Installing a new version reasserts the built-in row title,
description, and tags, while immutable saved version records remain unchanged.

The `workflow source --all` text output lists captured files with one stable
header per file. The entry file appears first, followed by helper paths in
lexical order:

```text
--- plan-review.workflow.ts
...
--- guidance/checklist.ts
...
--- guidance/finding.ts
...
```

For scripts, use `--output json` and read `files`, an array of `{ path, code,
entry }` objects in the same order. Saved workflow source reads the registry
bundle; path-based launch previews and new saves read the current filesystem
capture.

Names must be lowercase identifiers such as `review-loop`; `wf_` and
`wf_sha256...` prefixes are reserved for definition hashes. Omitting a version
resolves to the highest enabled, non-deprecated, non-deleted version. Deprecated
versions require an explicit version or `--allow-deprecated`; disabled or deleted
rows are not launchable.

`workflow source` prints exact stored TypeScript source from retained
`workflow_definitions` rows. It supports exactly one selector:

```bash
keel workflow source <saved-name> [--version N|latest] [--file path|--all] [--output text|json]
keel workflow source --run <runId> [--file path|--all] [--output text|json]
keel workflow source --definition <wf_sha256_hash> [--file path|--all] [--output text|json]
```

Single-file definitions default to the entry file; `--all` prints every captured
module with stable `--- path` headers, entry first and then non-entry files in
lexical order. `--file` selects one exact POSIX bundle path and is mutually
exclusive with `--all`. A bare positional
`wf_sha256_...` is treated as a saved workflow name; direct hash lookup requires
`--definition` and the hash must match `wf_sha256_<64 hex chars>`.

`--output json` for saved-name lookup returns `SavedWorkflowSourceView`. Run and
definition selectors return:

```ts
interface WorkflowDefinitionSourceView {
  kind: "workflow-definition-source";
  lookup:
    | { kind: "run"; runId: string }
    | { kind: "definition"; definitionHash: string };
  definitionHash: string;
  definitionName: string | null;
  createdAtMs: number;
  entry: string;
  files: Array<{ path: string; code: string; entry: boolean }>;
}
```

Source display is a journal view. It never reads the original client path,
branch/worktree paths, managed workspaces, or the materialized definition cache,
and it does not redact source bytes. Keep raw secrets out of workflow source and
helper modules.

Auth: `workflow:save` can save versions and update non-delete lifecycle metadata
for its scoped workflow. `workflow:run` can launch saved workflows. `workflow:read`
can show/source scoped saved workflows. Launch-minted run capabilities include
`run:source` for `--run` source lookup; older run capabilities without
`run:source` fail closed. Direct `--definition` lookup is admin-only because it
is daemon-wide. `workflow list`, `workflow install`, `delete`, `delete-version`,
and all schedule creation remain admin-only in v1.

`previewWorkflowDefinition` is an admin-only support RPC used by
`workflow install` to classify package entries against the exact daemon-computed
definition hash. It accepts only `source`; workflow name and provenance are
recorded by `saveWorkflow` metadata and do not affect the hash.

## API Reference

All clients speak the same daemon operation contract. The exact TypeScript source
of truth is `src/rpc/contract.ts` for `KeelApi` and request/response types,
and `src/rpc/projection.ts` for projections. See
[`docs/api.md`](./docs/api.md) for the source-backed API orientation and
operation-family map.

Lifecycle methods start work in the background and return a `RunStart` or run
id. `interruptRun` persists `status: "interrupted"`, appends
`run.interrupted`, and aborts active in-process work best-effort; only
`resumeRun` leaves that status. Signal delivery and approval decisions
acknowledge durable delivery and wake-start handling; they do not imply the
resumed workflow reached a parked or terminal status. Use `waitForRun`,
`subscribeEvents`, `keel watch`, or the TUI to observe progress. The daemon
returns a raw run capability on launch/fork so clients can establish authority
for follow-up operations. The CLI writes that capability to a local cap file by
default and only prints raw tokens with `--emit-capability`.

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
running or parked run uses that definition. `workflowDefinition.gcTtlMs` is the
default row TTL when the API/CLI call does not supply `ttlMs`; the shipped
default is 30 days. `KEEL_DEFINITION_TTL_MS` is no longer read; set
`workflowDefinition.gcTtlMs` with `keel settings set` instead.

### Multiple Processes

The daemon is the single writer. A run can be launched by one client, watched by
another, and resumed by a third. A heartbeat-based ownership fence prevents two
daemons from driving the same run; after restart, the daemon reclaims orphaned
`running` runs and deliberately skips `interrupted` runs until an explicit
`resume`.

## Known Limitations

- Durable wait identity is stable across crash-resume of unchanged code, not
  across edits that rekey a parked wait. Changing a sleep duration, renaming a
  wait key, or inserting a wait before an existing parked site can make the run
  re-park or wait for a new signal.
- Partial `fork` does not copy durable waits. Treat divergent forks of
  wait-heavy workflows with care.
- Saved tasks, durable task pause/re-entry, and durable child workflow spawning
  (`ctx.spawn`) are not implemented. Saved workflows are implemented through the
  workflow registry.
- Workflow definition manifests include runtime/import metadata and a workflow
  SDK ABI for the daemon-provided `@kcosr/keel` bridge. Keel does not vendor
  arbitrary external packages into the journal or provide lockfile-level
  package-store replay in v1.
- SQLite is the only implemented store. Postgres compatibility is a discipline
  enforced by tests, not a working backend.
- Secrets are trusted-local environment injection through the side channel.
  Persistent agent profiles and daemon settings are available through the CLI and
  daemon APIs.
- The full 111-agent workload remains budget/target-repo dependent; shape,
  durability, and crash-resume are covered by mock scale tests and reduced live
  runs.
- OS-level sandbox enforcement is not implemented beneath provider tool flags
  and workspace isolation.
- Capability files protect against accidental cross-agent access through Keel,
  but they do not prevent token theft between unrestricted processes running as
  the same Unix user.
