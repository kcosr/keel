# Changelog

## [Unreleased]

### Added
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
- `keel gc` prunes old unreferenced workflow definition rows and rebuildable
  materialized definition cache directories.
- Immutable workflow definition snapshots are stored by content hash and
  materialized from the journal for run execution and resume.
- Daemon-enforced bearer capabilities for run control, including launch-minted
  run capabilities, admin capabilities, and client-side capability files.

### Changed
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
- Run lifecycle operations are capability-gated by the daemon. Run id alone is
  no longer authority to inspect or mutate a run.
- Resume/retry/rewind/fork execute the run's stored workflow definition snapshot;
  rerun with a source override creates a fresh snapshot.
- Long-lived waits/event streams re-check capability validity and fail when a
  presented capability is revoked or expires; each wait/subscription is bound to
  the credential presented when it was started.
- `KEEL_TOKENS`/`KEEL_TOKEN` read-write auth has been replaced by
  `KEEL_ADMIN_TOKEN`, `KEEL_RUN_CAP`, `KEEL_CAP_FILE`, and cap files under
  `KEEL_CAP_DIR`.

### Fixed
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
- Workflow snapshots now fail closed when pinned external package bytes drift.
- `@kcosr/keel` workflow snapshot materialization now links to the package root
  instead of its parent directory.
