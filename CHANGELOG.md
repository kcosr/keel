# Changelog

## [Unreleased]

### Added
- `keel execute` runs stateless TypeScript control scripts outside the workflow
  realm with injected `keel`, `args`, `state`, and `env`; stdout is always the
  returned JSON value and runtime failures are structured JSON on stderr.
- Immutable workflow definition snapshots are stored by content hash and
  materialized from the journal for run execution and resume.
- Daemon-enforced bearer capabilities for run control, including launch-minted
  run capabilities, admin capabilities, and client-side capability files.

### Changed
- `keel launch --detach` now returns JSON containing `runId` and
  `capabilityRef` by default. Raw run capabilities require `--emit-capability`.
- Run lifecycle operations are capability-gated by the daemon. Run id alone is
  no longer authority to inspect or mutate a run.
- Resume/retry/rewind/fork execute the run's stored workflow definition snapshot;
  rerun/adopt-latest creates a fresh snapshot.
- `KEEL_TOKENS`/`KEEL_TOKEN` read-write auth has been replaced by
  `KEEL_ADMIN_TOKEN`, `KEEL_RUN_CAP`, `KEEL_CAP_FILE`, and cap files under
  `KEEL_CAP_DIR`.

### Fixed
- Workflow determinism checks now reject `Bun.*` ambient APIs and workflow imports
  of the operator-side `@kcosr/keel/execute` surface.
