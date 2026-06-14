# Reusable Workflows

This directory contains reusable Keel workflows intended for humans and agents to
launch directly. Keep `fixtures/` for tests, examples, and synthetic workloads;
put durable operational workflows here when they have a stable input contract and
documented follow-up behavior.

Workflow files are normal single-file Keel workflows. They must import only
`@kcosr/keel`, and their launch-time source plus external package integrity are
snapshotted. If you edit a workflow or the local SDK package after launch, start a
fresh run unless you are intentionally doing development-only database surgery.

| Workflow | Use When |
|---|---|
| [`iterative-review/`](./iterative-review/) | An implementer or human owns fixes, while a durable reviewer session waits for follow-up signals. |
| [`implement-review-loop/`](./implement-review-loop/) | Keel should autonomously loop a write-capable implementer with a read-only code reviewer. |
| [`spec-review-loop/`](./spec-review-loop/) | A user-facing creator agent owns the spec, while a durable reviewer session appends timestamped correspondence and waits for updates. |
| [`spec-author-review-loop/`](./spec-author-review-loop/) | Keel should autonomously loop a write-capable spec creator with a write-capable correspondence reviewer. |

All workflows are bounded by launch input such as `maxRounds` or `maxReviews`.
Keep those limits small for write-capable workflows.
