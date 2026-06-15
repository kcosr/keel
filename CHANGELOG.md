# Changelog

## [Unreleased]

### Added
- Persistent daemon-owned agent profile catalog with admin RPC/CLI management (`keel profiles ...`), validation/check diagnostics, programmatic-profile coexistence, and frozen per-run profile snapshots for deterministic replay.
- Journal schema v16 stores catalog profiles plus immutable run profile snapshot sets; migrating older journals backfills explicit empty snapshots and warning events for non-terminal pre-v16 runs.
- First-cut `codex` app-server agent provider with stdio, WebSocket, and WebSocket-over-Unix-socket transports via `providerConfig.codex.transport`. Codex requires explicit unrestricted tools (`toolPolicy: "unrestricted"`), uses Keel's resolved workspace cwd, captures app-server thread ids as session tokens, and supports opt-in raw protocol logging with `KEEL_CODEX_RAW_LOG`.
- Provider-keyed `providerConfig` for `ctx.agent`, `ctx.agentSession`, and agent profiles. Keel validates the full map as strict JSON, includes only the selected provider's config in replay identity, and passes only that immutable selected config to provider adapters.
- Workflow-scoped `ctx.workspace`/`ctx.withWorkspace` with direct and git-worktree modes, `WorkspaceHandle` sharing across agents/sessions, and a lazy `__default` direct workspace at `ctx.run.target`.
- Workspace lifecycle metadata now distinguishes `mode`, `ownerKind`, source path, provider cwd, ownership, retention, and active worktree holders in RPC/CLI/execute views.
- `keel execute` control scripts can list/get/diff/merge/discard/GC run workspaces through the daemon client.
- Run/schedule targets via `--target`; the run target feeds the default workspace instead of acting as a per-agent cwd override.
- Top-level `workflows/` directory for reusable operational workflows, starting
  with `iterative-review.workflow.ts`, a signal-driven multi-turn review loop,
  and `implement-review-loop.workflow.ts`, a bounded write-capable
  implementer/read-only reviewer loop backed by `ctx.agentSession`.
- Reusable spec-authoring workflows: a creator-driven `spec-review-loop` that
  preserves reviewer correspondence while the invoking agent owns the main spec,
  and a fully orchestrated `spec-author-review-loop` that loops a spec creator
  with a correspondence reviewer.
- `ctx.agentSession({ key, ... }).turn({ key, prompt, ... })` for realm
  workflows that need one logical Pi/Codex or Claude backend conversation across
  multiple durable turns in the same run. Session runs fail closed for
  rerun/rewind/fork, reject participant or turn identity drift, and include
  `KEEL_LIVE=1` backend-continuity smokes for Claude and the Pi/Codex adapter.
- `keel execute` runs stateless TypeScript control scripts outside the workflow
  realm with injected `keel`, `args`, `state`, and `env`; stdout is always the
  returned JSON value and runtime failures are structured JSON on stderr.
- `keel run [workflow.ts] [--input json] [--output json|text|ndjson]` launches a
  workflow and prints a JSON envelope by default, or a text transcript / NDJSON
  event stream when requested.
- `keel output <runId>` prints the terminal workflow output as JSON.
- `keel report <runId> [--output json|text]` prints a journaled per-node result
  digest, and execute control scripts can call `keel.report(runId)`.
- `keel list [--output text|json]` now has an explicit JSON envelope for scripts
  and includes created/finished/parent run metadata in run summaries.
- `keel tui [runId] [--status status] [--limit n]` opens an interactive terminal
  run browser/detail/watch UI with local filtering, `subscribeEvents` backfill,
  conservative lifecycle controls, and terminal restore guards.
- `keel gc` prunes old unreferenced workflow definition rows and rebuildable
  materialized definition cache directories.
- Immutable workflow definition snapshots are stored by content hash and
  materialized from the journal for run execution and resume.
- Daemon-enforced bearer capabilities for run control, including launch-minted
  run capabilities, admin capabilities, and client-side capability files.
- `keel interrupt <runId> [reason]` and `interruptRun` park non-terminal runs in
  public status `interrupted` until an explicit `resume`, with durable
  `run.interrupted` audit events and best-effort active worker/provider abort.

### Changed
- Reusable implementation/review workflows now resolve `input.repository` to a
  direct workspace, defaulting to the run target when omitted, so prompts and
  agent cwd stay aligned while still supporting manually-created git worktrees
  passed with `--target`.
- Codex app-server turns now use Keel's long-running agent timeout for
  `turn/completed` instead of the short setup RPC timeout, and provider-side
  failures interrupt an active remote turn best-effort before closing the
  transport. Resume/retry of an active Codex thread now discovers the in-progress
  turn through `thread/turns/list`, interrupts it, and fails closed unless
  interruption is confirmed.
- `keel list` and the TUI run browser now show newest runs first by default, and
  the browser keeps the selected row visible while moving through long lists.
- The TUI detail view keeps live watch output visible in constrained terminals and
  ignores unrecognized escape/CSI input sequences without leaking their bytes into
  prompts or navigation.
- Terminal text rendering for list/report/watch/TUI now uses shared sanitization,
  avoids unbounded table width argument spreads, and bounds retained TUI watch row
  text for long coalesced streams.
- Agent provider `cwd` is now always the resolved workspace path: explicit
  handle, scoped workspace, or the default direct workspace at the run target.
  Worktree mode resolves the supplied path to an enclosing git repository root.
  Raw daemon/RPC launch and schedule calls reject missing or blank targets, while
  CLI/client wrappers still capture their own cwd as the default target. The
  supervisor disables persisted schedules with invalid targets instead of letting
  one bad schedule break a tick.
- Workflow SDK ABI bumped to 5 for workflow-visible provider-specific agent config. Pre-bump workflow definitions must be re-registered, and suspended/non-terminal runs pinned to older SDK ABIs must be drained before upgrade or will fail resume with the existing unsupported-ABI error. The journal schema is unchanged for this provider-config change.
- Workflow SDK ABI bumped to 4 and journal schema to v15 for the workflow workspace API; non-terminal runs captured with older SDK ABIs must be drained before upgrade or will fail resume with the existing unsupported-ABI error.
- Public `workspaceIsolation`, `workspaceRetention`, and per-agent/profile `target` options were removed. Use `ctx.workspace({ key, mode: "worktree", retention })` and pass the returned handle to agents/sessions.
- Worktree retention names are now `"remove"`, `"retain-on-failure"`, and `"retain"`; retention applies only to Keel-owned worktrees, never direct workspaces.
- Durable agent sessions fail closed if a referenced worktree was removed by terminal cleanup; use `"retain-on-failure"` or `"retain"` for retryable failed session runs.
- Agent/session `agent.diff` and `workspace.diff_error` event payloads include the durable `workspaceId` and workspace source/cwd metadata for RPC/CLI selectors.
- Durable workspace diff payloads now cap `agent.diff.contentDiff` and changed
  path arrays with retained-workspace truncation/omission metadata, and
  oversized `git status`/`git diff` output crosses explicit buffer limits into
  `workspace.diff_error` instead of relying on Node's default `maxBuffer`.
- Agent secrets are trusted-local env injection only: secrets do not require
  worktree mode, and exact secret values emitted by agents are not redacted from
  outputs, events, tolerated failures, or workspace diffs.
- Attached CLI text transcripts now coalesce adjacent live agent text/reasoning
  chunks under one header for human-readable streaming output, while NDJSON
  event streams remain full-fidelity envelopes.
- `keel watch` no longer uses durable per-token `agent.event` rows as its live
  stream. Agent deltas are pushed as ephemeral live frames, finalized tool
  calls/results are persisted immediately as `agent.tool_call`/`agent.tool_result`
  rows with `attempt` and optional `toolCallId`, and successful turns persist at
  most one non-empty final-answer `agent.message` row.
- Workflow launch is now client-captured source only. `keel launch ./wf.ts`,
  `keel run ./wf.ts`, and `keel execute ./control.ts` read files in the client;
  omitting the file reads source from stdin. The daemon no longer reads client
  workflow paths.
- Workflow input for `launch` and `run` is now `--input <json>`; the positional
  argument is source only. Stdin launches may be unnamed, and JSON projections
  represent unnamed runs as `null`.
- Workflow sources are v1 single-file only and may import only the exact
  `@kcosr/keel` SDK specifier.
- Schedules now pin the captured workflow definition hash at creation time.
  Existing path-based schedules are disabled by migration.
- `keel launch --detach` now returns JSON containing `runId` and
  `capabilityRef` by default. Raw run capabilities require `--emit-capability`.
- CLI output selection now uses shared `--output json|text|ndjson` rendering
  flags. `--json` has been removed, `watch` and attached `launch` default to
  NDJSON event streams, and human transcripts require `--output text`.
- `keel list` now defaults to a headered, aligned text table instead of raw
  tab-separated rows; scripts should use `keel list --output json`.
- `getRun`/`getRunReport` projections include `createdAtMs` and `finishedAtMs`
  so direct run detail views can render the same timestamps and durations as
  `keel list`.
- Compact text transcripts hide agent tool calls/results by default. Add
  `--tools` to attached text commands to include them.
- Run lifecycle operations are capability-gated by the daemon. Run id alone is
  no longer authority to inspect or mutate a run.
- Interrupted runs are skipped by daemon restart recovery, timer supervisor wake,
  signal delivery, and approval delivery; interruption reasons are redacted
  before durable persistence and appear in blockage/report output.
- Resume/retry/rewind/fork execute the run's stored workflow definition snapshot;
  rerun with a source override creates a fresh snapshot.
- Workflow resume across compatible Keel upgrades now uses an explicit workflow
  SDK ABI for `@kcosr/keel` instead of pinning the full package tree.
- Reusable implement/review and spec-review workflows can now park after a clean
  review with `completionMode: "park-before-complete"`, allowing an orchestrator
  to request another round or explicitly signal final completion.
- Reusable review/spec/implementation workflows now default to the
  `codex-default` and `claude-default` agent profiles, exposing only reasoning
  overrides for normal launches.
- Long-lived waits/event streams re-check capability validity and fail when a
  presented capability is revoked or expires; each wait/subscription is bound to
  the credential presented when it was started.
- `KEEL_TOKENS`/`KEEL_TOKEN` read-write auth has been replaced by
  `KEEL_ADMIN_TOKEN`, `KEEL_RUN_CAP`, `KEEL_CAP_FILE`, and cap files under
  `KEEL_CAP_DIR`.

### Fixed
- Codex remote app-server transports now accept Desktop app-server response and
  notification frames that omit the optional `jsonrpc: "2.0"` marker while still
  rejecting malformed frames.
- `keel watch` and attached lifecycle commands no longer exit on stale
  historical parked/terminal events when replaying a run that later resumed.
- The live review workload fixture now uses a valid repository target when
  exercising workspace isolation.
- Provider session tokens are no longer persisted as `agent.event` payloads.
- Workflow snapshotting resolves the `@kcosr/keel` SDK package root from the
  repository (env override, source location, then runtime paths) instead of
  `import.meta.url` alone, which resolved to the filesystem root in the compiled
  standalone binary and triggered a recursive scan from `/` (surfacing as
  `EACCES … /etc/.pwd.lock`). The root is resolved lazily and the daemon asserts
  it at startup, failing fast with an actionable message if it cannot be found.
- CLI commands no longer hang after a daemon-side error. Every daemon client
  opened during a command is closed by the dispatcher, so a rejected RPC (auth,
  lint, not-found, precondition) prints the error and exits instead of leaking the
  socket and stalling on the open handle.
- CLI exit handling no longer uses `process.exit(code)` after writes, avoiding
  truncated piped JSON output.
- `run.finished` events include small terminal outputs and omit large outputs
  with byte metadata; `keel output` and `waitForRun` return the full value.
- Workflow determinism checks now reject `Bun.*`, process/module/dynamic-code
  escape paths, Node builtins, and workflow imports of the operator-side
  `@kcosr/keel/execute` surface.
- Capability-looking tokens are redacted from CLI/daemon diagnostic output.
- Bootstrap admin capability setup no longer re-enables a revoked bootstrap token
  on daemon restart.
- Workflow snapshots now fail closed when persisted definitions require an
  unsupported workflow SDK ABI, and automatic timer/orphan/schedule drive paths
  persist that deterministic failure instead of retrying silently.
- `@kcosr/keel` workflow snapshot materialization now links to the package root
  instead of its parent directory.
