# Documentation Guide

## Purpose

Keel's documentation is split by audience and source of truth. Keep each change
close to the behavior it describes, and avoid copying exact API, schema, or
projection shapes unless the same branch updates those copies when the source
changes.

## Ownership

| File | Owns | Does Not Own |
|---|---|---|
| `README.md` | Project orientation, quick routing, broad maturity/status, checks. | Full command syntax, volatile test counts, detailed architecture. |
| `USAGE.md` | Human/operator reference: install, daemon operation, CLI syntax, API notes, paths, workspaces, providers, limits. | Historical rationale or spec-only future plans. |
| `SKILL.md` | Workflow authoring guide for agents and humans, including deterministic workflow rules and compact examples. | Daemon operations, exhaustive CLI/API reference. |
| `docs/api.md` | Source-backed daemon API orientation, operation families, authority notes, and event-delivery contract. | Exact copied TypeScript contract definitions that can drift from source. |
| `workflows/README.md` | Catalog and conventions for reusable workflow files. | Per-workflow runbooks beyond catalog-level notes. |
| `workflows/*/README.md` | One workflow's inputs, launch examples, safety notes, signals, outputs, and retention/cleanup behavior. | Global workflow SDK reference. |
| `docs/documentation.md` | Documentation ownership map, update checklist, and durable documentation debt categories. | Product behavior, API syntax, or implementation plans that belong in other docs or `.specs/`. |
| `docs/control-surfaces.md` | Cross-surface exposure matrix, attach/detach/streaming conventions, authority vocabulary. | Full command examples or release notes. |
| `DESIGN.md` | Durable architecture, execution model, replay/liveness/security rationale, and historical decisions. | Current CLI syntax and generated API/schema reference. |
| `CHANGELOG.md` | User-visible release deltas under `[Unreleased]`. | Durable reference documentation or repeated command manuals. |
| `AGENTS.md` | Repository rules for agents and contributors. | Product documentation for end users. |
| `CLAUDE.md` | Claude-facing local notes when needed. | A separate source of truth for repository rules. Keep it synchronized with `AGENTS.md` or point to `AGENTS.md`. |
| `.specs/` | Untracked drafts, audits, plans, and review correspondence. | Durable decisions required by an implementation handoff. |

## Update Checklist

When a change affects users or operators, update the durable docs in the same
branch:

- CLI syntax, output shape, exit behavior, env vars, attach/watch behavior, or
  command defaults: update `USAGE.md`, `docs/control-surfaces.md`, tests, and
  `CHANGELOG.md`.
- Daemon RPC/API contracts or execute methods: update contract tests,
  `docs/api.md`, `USAGE.md` API notes, `docs/control-surfaces.md`, and
  `CHANGELOG.md`.
- Workflow SDK authoring behavior, `ctx.*` semantics, source capture, or replay
  visible behavior: update `SKILL.md`; update `DESIGN.md` if the architecture or
  durable semantics changed; evaluate `WORKFLOW_SDK_ABI_VERSION`.
- Reusable workflow inputs, signals, output shape, retention, or review-loop
  behavior: update the workflow's README and `workflows/README.md` if the
  catalog entry or global convention changed.
- Provider configuration, tool-policy mapping, live smoke setup, or capability
  behavior: update `USAGE.md`, `DESIGN.md` for durable model changes,
  `docs/control-surfaces.md` when operation exposure changes, and
  `CHANGELOG.md`.
- Workspaces, retention, merge/discard/GC, target handling, or isolation modes:
  update `USAGE.md`, `SKILL.md` if workflow authors are affected,
  `DESIGN.md` for architecture changes, and `docs/control-surfaces.md`.
- Migrations, schema changes, settings/profile persistence, or durable state
  formats: update `USAGE.md`, `DESIGN.md` when architecture changes, migration
  tests, and `CHANGELOG.md`.
- New or changed planned surface exposure, including web, TUI, MCP, CLI,
  execute, or SDK: update `docs/control-surfaces.md`.

## Documentation Debt Categories

Use these categories to classify follow-up documentation work. Keep detailed
plans, review correspondence, and task breakdowns in `.specs/`; promote only the
durable ownership rule or completed reference content into tracked docs.

- API/RPC reference source of truth.
- Control-surface matrix granularity.
- Current architecture versus historical design narrative.
- Exact copied API, projection, and schema snippets.
- Long-form `USAGE.md` topic ownership and extraction.
- Reusable workflow input, target, signal, and output runbooks.
- Agent-specific repository instruction drift.
