# Keel

**Keel** (working codename) is a durable agent-workflow orchestrator: workflows
are plain `async (ctx, input) => output` TypeScript functions; every `ctx.*`
effect is journaled to SQLite by a single-writer Bun daemon; resume re-runs the
body with a memoizing `ctx` so completed work replays instantly and a crash
costs at most the one in-flight agent call. The daemon owns agent provider
subprocesses for Pi and Claude, with a deterministic mock provider for tests.

**Using it?** Start with **`USAGE.md`** — the operational reference for install,
CLI commands, paths, workflow APIs, agents, capabilities, scheduling, HITL, time
travel, and daemon behavior.

## Documentation map

| Need | Start here |
|---|---|
| Use Keel, run workflows, inspect commands/API, understand paths and daemon state | `USAGE.md` |
| Write workflows as an agent or human author | `SKILL.md` |
| Launch reusable workflow files with documented inputs and signals | `workflows/README.md` |
| Work in this repo safely: migrations, changelog, compatibility, capability rules | `AGENTS.md` |
| Understand architecture, tradeoffs, historical design decisions, and acceptance workload | `DESIGN.md` |
| See user-visible changes over time | `CHANGELOG.md` |

`DESIGN.md` is no longer the day-to-day usage reference. Treat it as the
architecture and design-history record: useful for why the system has this shape,
but not the authoritative command/API lookup.

## Repo map

| Path | What it is |
|---|---|
| `USAGE.md` | Operational reference for users, operators, and API callers. |
| `SKILL.md` | Compact workflow-authoring guide for agents and humans. |
| `AGENTS.md` | Project conventions for agents working in this repo. |
| `DESIGN.md` | Architecture/design-history record and acceptance workload context. |
| `workflows/` | Reusable operational workflows with documented inputs and signals. |
| `fixtures/review-workload/` | Active large fan-out review workload fixture and live rehearsal target. |

## Status

**Complete: all 19 phases of the DESIGN.md §15 pipeline are built**, one commit
each, every commit green (`bun test` + `tsc` + biome), with two rounds of external
monitoring review incorporated and adversarially verified. 167 tests pass; 3
`KEEL_LIVE`-gated live tests against the real Pi-driven LLM are skipped by default.

The kernel is a working durable orchestrator end to end: SQLite-WAL journal,
memoized re-execution, the write-ahead crash protocol (proven under real
`kill -9`), the deterministic Bun-Worker realm + determinism lint, structural
versioning, value-hash invalidation with early cutoff, `ctx.agent` with live
providers and a deterministic mock, the two-tier artifact store, the large
fan-out review workload run live as a budget-scaled rehearsal, the frozen RPC
contract + RunProjection, the out-of-process
daemon + thin CLI with CAS-fenced recovery, liveness (stall-retry/timeouts/
blockage), write-capable agents (fail-closed capabilities, worktree isolation,
durable diff gate, secrets), durable `ctx.sleep` + supervisor + cron, full HITL
(`ctx.human`/`ctx.signal`), time travel (retry/rewind/fork), and ops (GC,
`continueAsNew`, scoped-token auth, schema migrations, named agent profiles). See
`DESIGN.md` for the architecture record and `USAGE.md` for known limitations.

Run the suite: `export PATH="$HOME/.bun/bin:$PATH"; bun test` (live Pi tests gated
behind `KEEL_LIVE=1 NODE_TLS_REJECT_UNAUTHORIZED=0`). Usage: see `USAGE.md`.
