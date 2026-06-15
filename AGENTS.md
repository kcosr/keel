# Keel Agent Notes

For normal agent use, assume the Keel daemon is already running and the `keel`
CLI is configured to reach it through the environment (`KEEL_SOCKET` or
`KEEL_DIR`). Do not start, restart, or inspect the systemd service unless the
user explicitly asks for daemon operations.

## Project Rules

- Keep changes narrowly scoped. Do not refactor unrelated modules while fixing a
  feature or bug.
- Prefer explicit failures over silent fallbacks. If input, configuration,
  provider output, or persisted state is invalid, report the error clearly rather
  than guessing.
- Do not add backwards-compatibility shims for old CLI/API/workflow shapes unless
  the project explicitly decides to support that compatibility boundary.
- Keep behavioral defaults in named constants instead of repeating literals,
  especially for agent retries, timeouts, provider options, and daemon
  supervisor timing.
- Respect a dirty worktree. Treat unrelated local changes as owned by another
  agent or the user.

## Migrations

The journal database is durable state. Any persistent schema change must include
a forward migration, but runtime code should not carry unnecessary fallback paths
for old schemas.

When changing tables, columns, indexes, or persisted record shapes in the journal
database:

- Bump `SCHEMA_VERSION` in `src/journal/schema.ts`.
- Update the base schema DDL in `src/journal/schema.ts`.
- Add an `applyMigration` case in `src/journal/migrations.ts`.
- Update the migration history comment in `src/journal/migrations.ts`.
- Add or update migration coverage in `src/journal/migration.test.ts`.
- Keep old databases migrating forward. Do not add ad hoc code branches that
  tolerate pre-migration shapes after startup.

The migration boundary is the compatibility boundary. After migration has run,
the rest of the code should operate against the current schema only.

## Workflow SDK ABI

`WORKFLOW_SDK_ABI_VERSION` is the resume compatibility boundary for workflow
source that imports `@kcosr/keel`. Bump it when a change can alter the
workflow-facing contract or replay-visible behavior, including:

- exported SDK names or call shapes in `src/sdk.ts`;
- `ctx.*` method signatures, durable wait semantics, or replay-visible behavior;
- worker/host protocol expectations required by compiled workflow source;
- schema helper behavior or structural hashing visible to workflow authors;
- workflow definition manifest/runtime fields used during materialization.

Do not bump the ABI for internal implementation changes that preserve the
workflow-facing contract. If a future daemon claims support for more than one
workflow SDK ABI, materialization must route older ABIs to an actual versioned
bridge or compatibility shim; accepting multiple numbers while linking every
definition to the current `src/sdk.ts` is not sufficient.

## Capabilities

Agent permissions should fail closed.

- Agent tools default to read-only. Use `toolPolicy: "none"` for no provider
  tools, and require explicit policy/capability declarations for broader access.
- Route capability/tool-policy changes through the central capability resolution
  and provider mapping code.
- Include capability-affecting options in agent identity/versioning, because
  they change what an agent can observe or do.
- Do not let shell/write-capable agents run against the daemon cwd as a fallback.
  They need an explicit workspace root or an intentional, tested equivalent.
- Secrets are trusted-local env injection through the side channel. They do not
  require worktree mode, and Keel does not redact exact secret values from
  agent outputs, events, errors, or diffs.
- Network capability is advisory until a real network sandbox/backstop exists;
  do not describe workspace isolation or output handling as preventing network
  exfiltration.
- Keep raw secret values out of workflow source and persistent configuration.
  Assume any secret an agent prints, writes, or returns can be journaled.

## Documentation

Documentation is part of the change.

- Maintain `CHANGELOG.md` under `[Unreleased]` for user-visible behavior,
  commands, API changes, defaults, migrations, and notable docs/convention
  changes.
- Update `USAGE.md` when CLI commands, command output, environment variables,
  daemon operation, API/RPC behavior, or workflow execution semantics change.
- Update `SKILL.md` when agent-facing workflow authoring guidance changes.
- Update `DESIGN.md` when durable architecture, execution model, liveness,
  isolation, or replay semantics change.
- Keep this file focused on repository conventions and local operating notes.
- Avoid brittle section-number references in code comments and docs. Prefer
  stable file names, API names, or concept names unless a numbered section is the
  actual subject being discussed.
- Use `.specs/` for untracked draft designs, plans, and working notes. It is
  intentionally gitignored; promote durable decisions into tracked docs before
  implementation handoff.

## CLI And API Reference

`USAGE.md` is the detailed reference for humans and agents using Keel.

When adding or changing a CLI command, document:

- Syntax and positional arguments.
- Default attach/watch behavior and the flag for the opposite mode.
- Output shape that scripts or agents may consume.
- Relevant environment variables.
- How errors are reported.

When changing RPC/API contracts, update the contract code, the relevant tests,
and the API notes in `USAGE.md` in the same change.

## Verification

- Run focused tests for the touched behavior.
- Tests should assert the intended current behavior directly. Do not add
  backwards-looking assertions that old behavior, labels, or values do not
  reappear unless that absence is itself a product requirement.
- Run `bun run typecheck` and `bun run lint` before handing off implementation
  changes when practical.
- Run `bun test` when shared kernel, journal, daemon, CLI, or provider behavior
  changes.
- For docs-only changes, a focused formatter/linter check is enough.
- For TUI changes, keep terminal-independent state/view/event/input coverage in
  `src/tui`; any PTY smoke must be opt-in, dev/test-only, and must not add a
  native runtime dependency to the shipped CLI.

### Provider Testing

Provider changes need tests at the boundary they affect. Do not rely on a live
LLM test to cover deterministic protocol behavior; live tests are smoke tests,
not the primary regression suite.

- For every new provider, add deterministic adapter tests with a fake executable
  or fake transport. Cover argv/env construction, streamed event parsing,
  terminal success and failure, session-token capture, resume flags, tool-policy
  mapping, abort/stall cleanup, and diagnostic logging behavior.
- For every new provider, add a `KEEL_LIVE=1` provider smoke that uses the real
  backend through the provider's normal binary resolution. Use the provider's
  documented binary override when testing an alternate implementation. The smoke
  should make a tiny structured-output request, validate the parsed value, and
  assert a session token when the provider supports one.
- For every new provider, add a `KEEL_LIVE=1` daemon or realm smoke that runs a
  tiny workflow through `ctx.agent`, validates the final output, then resumes the
  completed run and asserts the agent step replays from the journal without a
  second provider invocation.
- Use daemon-level smoke when the change touches daemon-owned provider wiring,
  CLI daemon defaults, socket/RPC launch behavior, journal identity, replay, or
  provider registration. A provider-only smoke is enough only for adapter-local
  parsing/argv changes.
- When changing capability or tool-policy mapping, test both layers: direct
  resolver/provider-arg tests and a cross-boundary path where resolved kernel
  capabilities reach the adapter. This prevents lossy internal labels from
  broadening or dropping capabilities.
- When changing workspace isolation, secret injection, session resume, or crash
  behavior, include realm or daemon tests because those behaviors live at the
  host/journal boundary.
- Keep live tests gated behind `KEEL_LIVE=1`, keep prompts cheap and deterministic
  ("return only this JSON"), and avoid relying on repository-specific state unless
  the test creates that state itself.
- If a live backend requires insecure local development settings, pass those only
  in the test command or provider `env` for that test. Do not bake insecure
  environment defaults into production provider code.

## Systemd

These commands are for explicit human-requested daemon operations only. Agents
running workflows should use the configured `keel` CLI and should not touch
systemd by default.

Check the daemon status:

```bash
systemctl --user status keel-daemon.service
```

Restart the daemon after local changes:

```bash
systemctl --user restart keel-daemon.service
```

View recent daemon logs:

```bash
journalctl --user -u keel-daemon.service --no-pager --lines=80
```

## Usage

For Keel usage instructions, read [`USAGE.md`](./USAGE.md). For agent-facing
workflow authoring details, read [`SKILL.md`](./SKILL.md).
