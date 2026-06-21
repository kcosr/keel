# Reusable Workflows

This directory contains reusable Keel workflows intended for humans and agents to
launch directly. Keep `fixtures/` for tests, examples, and synthetic workloads;
put durable operational workflows here when they have a stable input contract and
documented follow-up behavior.

Workflow files are normal Keel workflows and may import local deterministic
helper modules through relative paths. The only external import is
`@kcosr/keel`; launch-time entry source, helper source, SDK ABI metadata, and
import metadata are snapshotted. If you edit a workflow, a helper, or the local
SDK package after launch, start a fresh run unless you are intentionally doing
development-only database surgery.

| Workflow | Use When |
|---|---|
| [`fixtures/`](./fixtures/) | Small runnable examples, tests, and synthetic workloads that should not be treated as stable operational workflows. |
| [`iterative-review/`](./iterative-review/) | An implementer or human owns fixes, while a durable reviewer session waits for follow-up signals. |
| [`implement-review-loop/`](./implement-review-loop/) | Keel should autonomously loop a write-capable implementer with a read-only code reviewer. |
| [`branch-worktree-implement-review/`](./branch-worktree-implement-review/) | Keel should create a generated-branch worktree, then autonomously loop a write-capable implementer with a read-only code reviewer in that shared worktree. |
| [`model-routing/`](./model-routing/) | Workflow authors want captured helper code for bounded static or read-only-agent routing of profile/reasoning choices. |
| [`task-review-guidance/code-review.workflow.ts`](./task-review-guidance/) | One-shot read-only code review using shared captured guidance helpers. |
| [`task-review-guidance/plan-review.workflow.ts`](./task-review-guidance/) | One-shot design/spec review using shared guidance, with optional correspondence append. |
| [`task-review-guidance/docs-review.workflow.ts`](./task-review-guidance/) | One-shot read-only documentation review against the repository's public surface. |
| [`spec-review-loop/`](./spec-review-loop/) | A user-facing creator agent owns the spec, while a durable reviewer session appends timestamped correspondence and waits for updates. |
| [`spec-author-review-loop/`](./spec-author-review-loop/) | Keel should autonomously loop a write-capable spec creator with a write-capable correspondence reviewer. |

All workflows are bounded by launch input such as `maxRounds` or `maxReviews`.
Keep those limits small for write-capable workflows.

Reusable workflows that use `ctx.agentSession` preserve backend session
continuity across turns and resume/retry paths. They do not support rerun,
rewind, or fork of runs that used durable agent sessions; changing participant
identity or turn prompts fails closed. See `USAGE.md` Agent Sessions for the full
operator caveats.

Install the curated task-review-guidance package with:

```bash
keel workflow install task-review-guidance
```

This saves `task-code-review`, `task-plan-review`, and `task-docs-review` as
ordinary immutable saved workflow versions. Their `guidance/*.ts` modules are
captured into the immutable saved bundle; editing a guidance file affects only
newly launched path-based runs or newly saved versions, not existing saved
versions.

Seed the local default reusable review workflows with:

```bash
bun run workflows:seed-defaults
```

This saves or refreshes `iterative-review`, `implement-review-loop`,
`branch-worktree-implement-review`, `spec-review-loop`, and
`spec-author-review-loop` as saved workflow versions. Use `bun run
defaults:seed` to seed both these workflows and the conventional local agent
profiles.
