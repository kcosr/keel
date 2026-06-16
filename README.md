# Keel

**Keel** is a durable agent-workflow orchestrator: workflows are plain
`async (ctx, input) => output` TypeScript functions; every `ctx.*` effect is
journaled to SQLite by a single-writer Bun daemon; resume re-runs the body with a
memoizing `ctx` so completed work replays instantly and a crash costs at most
the one in-flight effect.

**Using it?** Start with **`USAGE.md`** — the operational reference for install,
CLI commands, paths, workflow APIs, agents, capabilities, scheduling, HITL, time
travel, and daemon behavior.

## Where To Go

| Need | Start here |
|---|---|
| Use Keel, run workflows, inspect commands/API, understand paths and daemon state | [`USAGE.md`](./USAGE.md) |
| Write your first workflow or author workflows as an agent | [`SKILL.md`](./SKILL.md) |
| Launch reusable operational workflows | [`workflows/README.md`](./workflows/README.md) |
| Work in this repo safely: migrations, changelog, compatibility, capability rules | [`AGENTS.md`](./AGENTS.md) |
| Decide which docs to update when behavior changes | [`docs/documentation.md`](./docs/documentation.md) |
| Track operation exposure across CLI, execute, TUI, API, and planned surfaces | [`docs/control-surfaces.md`](./docs/control-surfaces.md) |
| Understand architecture, tradeoffs, historical design decisions, and acceptance workload | [`DESIGN.md`](./DESIGN.md) |
| See user-visible changes over time | [`CHANGELOG.md`](./CHANGELOG.md) |

`DESIGN.md` is no longer the day-to-day usage reference. Treat it as the
architecture and design-history record: useful for why the system has this shape,
but not the authoritative command/API lookup.

## Status

Keel is active local-first infrastructure for durable agent workflows. It has a
working daemon, CLI, workflow SDK, journal, replay model, durable waits,
agent-provider integrations, reusable workflow registry, run workspaces, and
operator controls. Some planned surfaces, especially web and MCP, remain
deferred; see [`USAGE.md`](./USAGE.md#known-limitations) and
[`docs/control-surfaces.md`](./docs/control-surfaces.md).

Run the local checks:

```bash
bun install
bun test
bun run typecheck
bun run lint
```

Live backend smokes are gated behind `KEEL_LIVE=1`; see `USAGE.md` for provider
setup and operational details.
