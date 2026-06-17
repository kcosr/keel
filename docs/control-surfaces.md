# Control Surfaces

## Purpose

Keel exposes operator behavior through several surfaces:

- daemon RPC/API contracts;
- CLI commands;
- `keel execute` control scripts;
- TUI;
- local web API and React UI;
- planned MCP tools;
- SDK/workflow authoring APIs when behavior is durable and replay-visible.

The daemon RPC/API is the canonical operation boundary. CLI, execute, TUI, web,
and MCP surfaces should be thin adapters over shared daemon operations and
projections rather than independent implementations.

## Exposure Status

Use this vocabulary in feature specs and implementation reviews:

| Status | Meaning |
|---|---|
| `required` | The feature must be exposed on the surface in the same implementation branch. |
| `implemented` | The surface supports the feature at the current baseline. |
| `deferred` | Useful or expected, but deliberately out of scope for this branch. |
| `not-applicable` | The surface does not make sense for this feature. |
| `internal` | No public surface; daemon/kernel behavior only. |
| `partial` | Descriptive repo-wide matrix only: a row spans multiple verbs and only some are implemented. |

Prefer splitting operation rows over using `partial` in per-feature specs.

## Feature Checklist

Every feature spec that adds or changes an operator-visible capability should
include a control-surface decision:

| Surface | Status | Notes |
|---|---|---|
| Daemon RPC/API | `required`/`implemented`/`deferred`/`not-applicable`/`internal` | Canonical operation boundary. |
| CLI | `required`/`implemented`/`deferred`/`not-applicable`/`internal` | Human and script shell surface. |
| Execute API | `required`/`implemented`/`deferred`/`not-applicable`/`internal` | Programmatic control scripts. |
| Web API/UI | `required`/`implemented`/`deferred`/`not-applicable`/`internal` | Browser projection or mutation surface. |
| TUI | `required`/`implemented`/`deferred`/`not-applicable`/`internal` | Interactive terminal surface. |
| MCP | `required`/`implemented`/`deferred`/`not-applicable`/`internal` | Agent-facing tools. |
| SDK/workflow API | `required`/`implemented`/`deferred`/`not-applicable`/`internal` | Workflow authoring and replay-visible behavior. |

Also state the authority, output contract, docs touched, and tests covering each
implemented boundary.

## Authority Vocabulary

Use the real capability model in `src/auth/capabilities.ts`. Do not invent a
parallel authorization taxonomy.

Current resources are `run`, `workflow`, and `daemon`. Current
actions include `run:read`, `run:source`, `run:watch`, `run:events`,
`run:output`, `run:resume`, `run:interrupt`, `run:retry`, `run:rewind`,
`run:fork`, `run:signal`, `run:cancel`, `workflow:read`, `workflow:run`,
`workflow:save`, and `admin`.

Approval decisions are admin operations at this baseline. Keel does not expose
approval-scoped capability resources or saved-task capability actions until
those product surfaces ship.

`run:cancel` is currently only a defined capability action; no public RPC, CLI,
or execute operation is wired to it. Mark a cancel surface `implemented` only
after an actual operation exists.

Use `open` only for operations that intentionally require no credential on the
current local transport. If a future remote or web transport narrows an open
local-socket operation, call that out in surface notes.

## Surface Guidance

Add or change daemon RPC/API when durable daemon state, shared behavior,
authorization, or automation-stable output is involved.

Add or change CLI when an operator should perform the action directly, scripts
need a stable shell command, or an existing command family owns the resource.

Add execute methods when control scripts need to compose daemon operations
without shelling out. Execute must wrap daemon behavior, not invent behavior
missing from RPC.

Add web routes or views when the data benefits from visual inspection, live
refresh, graph/table layout, or browser-side interaction. Browser mutations must
use explicit bearer authorization through the daemon gateway; remote exposure,
TLS, CORS, browser sessions, and CSRF posture require a separate design.

Add TUI exposure when the operation belongs in an interactive terminal workflow
and can reuse CLI/RPC contracts.

Add MCP exposure when agents should inspect or operate on Keel state through
structured tools rather than parsing CLI transcripts. MCP is planned and should
usually be `deferred` or `not-applicable` at this baseline.

Track SDK/workflow API exposure only for workflow authoring or durable
replay-visible behavior, such as new `ctx.*` methods, exported SDK names, or
workflow source capture semantics. If SDK exposure is `required`, also evaluate
`WORKFLOW_SDK_ABI_VERSION`.

## Current Web API

`keel web` serves a local HTTP/SSE API transport. It is an adapter over the
daemon gateway, not a second operation dispatcher:

- `POST /rpc` forwards unary daemon operation names and shapes, preserving
  structured gateway errors.
- `GET /runs/:runId/events` translates the shared event cursor contract into SSE
  frames with `snapshot`, raw `event`, adapter-level `caught-up`, `closed`,
  `authorization.failed`, and heartbeat frames.
- Projection routes currently cover runs, run detail, approvals, workspaces, and
  system status. The runs list projection is intentionally bounded before
  per-run enrichment through the daemon `listRunsPage` RPC, defaults to the
  latest 100 runs, rejects limits above 500, and returns page metadata for
  honest truncation copy. Run projections hide diagnostic `running` blockage and
  only surface actionable waits, agent concurrency queues, interruptions, or
  stale owner-heartbeat stalls.
- Captured-source `launchRun` is admin-only through the web surface even though
  it remains open on the trusted local Unix socket.

The React UI foundation lives under `web/` and is served by `keel web` from the
`web/dist` bundle when present. It is a browser client over this same API, not a
new operation boundary. Current UI coverage includes runs, run detail, approval
decisions, workspace diff/review controls, saved workflow list/detail/source/run,
read-only schedule list/detail/source, profile and setting list/get/check
inspection, and system views. Browser mutations remain disabled or deferred
unless a screen explicitly wires the operation through bearer-authorized `/rpc`
calls. Wired mutation controls show the required authority and copyable CLI
equivalent; disabled controls explain the missing authority or unsupported
resource state. The current workspace browser projection fans out over per-run
workspace RPCs instead of a daemon-native aggregate. The system view uses only
`/health` and `/api/system`; daemon internals such as journal paths, schema
versions, systemd state, logs, and restart controls are not inferred.

## Current Matrix

| Operation | RPC | CLI | Execute | Web | TUI | MCP | SDK | Authority |
|---|---|---|---|---|---|---|---|---|
| run launch from captured source | implemented | implemented | implemented | implemented | not-applicable | deferred | not-applicable | open on local socket; admin on web; follow-up uses minted run capability |
| run list | implemented | implemented | deferred | implemented | implemented | deferred | not-applicable | `admin` |
| run get/report/output/blockage | implemented | implemented | implemented | implemented | implemented | deferred | not-applicable | `run:read`, `run:output` |
| run watch/events/wait | implemented | implemented | implemented | implemented | partial | deferred | not-applicable | `run:watch`, `run:events` |
| resume/retry | implemented | implemented | implemented | implemented | implemented | deferred | not-applicable | `run:resume`, `run:retry` |
| rewind/fork | implemented | implemented | implemented | implemented | partial | deferred | not-applicable | `run:rewind`, `run:fork` |
| rerun/source override | implemented | deferred | deferred | implemented | deferred | deferred | not-applicable | `run:retry` |
| interrupt run | implemented | implemented | implemented | implemented | not-applicable | deferred | not-applicable | `run:interrupt` |
| signal delivery | implemented | implemented | implemented | implemented | implemented | deferred | `ctx.signal` implemented | `run:signal` |
| approval decision | implemented | implemented | implemented | implemented | implemented | deferred | `ctx.human` implemented | `admin` |
| schedule put | implemented | implemented | deferred | deferred | not-applicable | deferred | not-applicable | `admin` |
| schedule list/show | implemented | implemented | implemented | implemented | not-applicable | deferred | not-applicable | `admin` |
| saved workflow save/install | implemented | implemented | deferred | deferred | not-applicable | deferred | not-applicable | `admin`, `workflow:save` |
| saved workflow list/show/source | implemented | implemented | deferred | implemented | not-applicable | deferred | not-applicable | `admin`, `workflow:read` |
| saved workflow run | implemented | implemented | deferred | implemented | not-applicable | deferred | not-applicable | `workflow:run`; follow-up uses minted run capability |
| saved workflow enable/disable/deprecate/delete | implemented | implemented | deferred | deferred | not-applicable | deferred | not-applicable | `admin`, `workflow:save` for scoped non-delete metadata |
| workflow definition preview/source | implemented | implemented | deferred | deferred | not-applicable | deferred | not-applicable | `admin`, `run:source` depending selector |
| workflow definition GC | implemented | implemented | deferred | deferred | not-applicable | deferred | not-applicable | `admin` |
| profile catalog list/get/check | implemented | implemented | deferred | implemented | not-applicable | deferred | `profile` field consumes snapshots | `admin` |
| profile catalog set/delete | implemented | implemented | deferred | deferred | not-applicable | deferred | not-applicable | `admin` |
| settings catalog list/get/check | implemented | implemented | deferred | implemented | not-applicable | deferred | workflow-visible settings snapshot; daemon-operational agent concurrency limits are not SDK-visible | `admin` |
| settings catalog set/unset | implemented | implemented | deferred | deferred | not-applicable | deferred | not-applicable | `admin` |
| workspace list/show/diff | implemented | implemented | implemented | implemented | deferred | deferred | not-applicable | `run:read` |
| workspace merge/discard/gc | implemented | implemented | implemented | implemented | deferred | deferred | not-applicable | `admin` |

Keep this table descriptive until the API stabilizes enough to justify generated
surface documentation.

Run-secret delivery is part of existing launch/restart surfaces, not a separate
operation. RPC accepts `runSecrets` on `launchRun`, `launchSavedWorkflow`,
`retryRun`, `rewindRun`, and `rerunRun`; CLI exposes `--secret`/`--secret-env`
on `launch`, `run`, `workflow run`, `retry`, and `rewind`; execute exposes
`runSecrets` on `keel.launch`, `keel.retry`, and `keel.rewind`. The web
transport rejects raw `runSecrets` until a browser-specific local secret
authorization model exists.

## CLI Interaction Behavior

This table distinguishes command exposure from attach, stream, wait, and
acknowledgement behavior.

| Command | Starts work | Blocks until | Streams | Detach flag | Default output | Exit basis |
|---|---|---|---|---|---|---|
| `launch` | yes | terminal/parked/interrupted by default; start acknowledgement with `--detach` | yes when attached | yes | attached NDJSON; detached JSON | attached run outcome, or launch success/failure when detached |
| `run` | yes | terminal/parked/interrupted | yes with `--output text` | no | JSON envelope | run outcome |
| `resume` | yes | terminal/parked/interrupted by default; start acknowledgement with `--detach` | yes when attached | yes | text watch when attached; `<runId>\t<status>` when detached | attached run outcome, or resume success/failure when detached |
| `retry` | yes | terminal/parked/interrupted by default; start acknowledgement with `--detach` | yes when attached | yes | text watch when attached; `<runId>\t<status>` when detached | attached run outcome, or retry success/failure when detached |
| `rewind` | yes | terminal/parked/interrupted by default; start acknowledgement with `--detach` | yes when attached | yes | text watch when attached; `<runId>\t<status>` when detached | attached run outcome, or rewind success/failure when detached |
| `watch` | no | terminal/parked/interrupted event or closed stream status after catch-up | yes | no | NDJSON | observed run status |
| `tui` | no by itself | user exits | live view | no | interactive terminal UI | user exit or startup failure |
| `interrupt` | stops active work | interruption persistence | no | no | `<runId>\tinterrupted` | interruption success/failure |
| `signal` | maybe starts wake | delivery and wake-start acknowledgement | no | no | status line | delivery success/failure |
| `approve`/`deny` | maybe starts wake | delivery and wake-start acknowledgement | no | no | status line | delivery success/failure |

`signal`, `approve`, and `deny` are delivery-acknowledgement commands. They
return after the input is durable and any eligible wake has been accepted and
started. They do not wait for resumed workflow work to finish, fail, or park
again. Use `keel watch <runId> --output text` or the TUI to observe progress.

## Implementation Convention

When implementing a new feature:

1. Add or update daemon RPC/API first unless the feature is truly internal.
2. Add a control-surface exposure note/table to the feature spec.
3. Implement required surfaces in the same branch or explicitly mark them
   deferred with follow-up work.
4. Add tests at each implemented boundary.
5. Update `USAGE.md` and `CHANGELOG.md`.
