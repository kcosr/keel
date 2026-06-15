# Reusable Workflows

This directory contains reusable Keel workflows intended for humans and agents to
launch directly. Keep `fixtures/` for tests, examples, and synthetic workloads;
put durable operational workflows here when they have a stable input contract and
documented follow-up behavior.

Workflow files are normal Keel workflows and may import local deterministic
helper modules through relative paths. The only external import is
`@kcosr/keel`, and launch-time source, helper source, and external package
integrity are snapshotted. If you edit a workflow, a helper, or the local SDK
package after launch, start a fresh run unless you are intentionally doing
development-only database surgery.

| Workflow | Use When |
|---|---|
| [`iterative-review/`](./iterative-review/) | An implementer or human owns fixes, while a durable reviewer session waits for follow-up signals. |
| [`implement-review-loop/`](./implement-review-loop/) | Keel should autonomously loop a write-capable implementer with a read-only code reviewer. |
| [`task-review-guidance/code-review.workflow.ts`](./task-review-guidance/) | One-shot read-only code review using shared captured guidance helpers. |
| [`task-review-guidance/plan-review.workflow.ts`](./task-review-guidance/) | One-shot design/spec review using shared guidance, with optional correspondence append. |
| [`spec-review-loop/`](./spec-review-loop/) | A user-facing creator agent owns the spec, while a durable reviewer session appends timestamped correspondence and waits for updates. |
| [`spec-author-review-loop/`](./spec-author-review-loop/) | Keel should autonomously loop a write-capable spec creator with a write-capable correspondence reviewer. |

All workflows are bounded by launch input such as `maxRounds` or `maxReviews`.
Keep those limits small for write-capable workflows.

The task-review-guidance workflows are intended to be packaged through saved
workflow versions such as `task-code-review` and `task-plan-review`. Their
`guidance/*.ts` modules are captured into the immutable saved bundle; editing a
guidance file affects only newly launched path-based runs or newly saved
versions, not existing saved versions.
