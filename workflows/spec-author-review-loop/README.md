# Spec Author Review Loop Workflow

`spec-author-review-loop.workflow.ts` is fully orchestrated. A write-capable spec
creator drafts or revises the main spec, then a write-capable reviewer appends
timestamped correspondence. Findings are fed back to the creator until the spec is
clean, the creator is blocked, or `maxRounds` is reached.

Launch:

```bash
keel launch --detach workflows/spec-author-review-loop/spec-author-review-loop.workflow.ts \
  --name spec-author-review \
  --emit-capability \
  --input '{
    "specPath": "/home/kevin/worktrees/keel/.specs/new-feature.md",
    "request": "Design a durable feature and preserve reviewer correspondence",
    "creatorIdentity": "Creator: pi/openai-codex/gpt-5.5",
    "reviewerIdentity": "Reviewer: pi/default",
    "creatorProvider": "pi",
    "creatorModel": "openai-codex/gpt-5.5",
    "creatorReasoning": "xhigh",
    "creatorToolPolicy": "workspace-write",
    "reviewerProvider": "pi",
    "reviewerReasoning": "xhigh",
    "reviewerToolPolicy": "workspace-write",
    "maxRounds": 3
  }'
```

## Correspondence Format

Both agents receive an ISO timestamp from `ctx.now()` and are instructed to append
under `## Correspondence` with headers like:

```md
### 2026-06-13T23:00:00.000Z - Creator: pi/default
### 2026-06-13T23:01:00.000Z - Reviewer: claude/claude-opus-4-8
```

No round label is required; the timestamp and identity preserve history.

## Safety Notes

- Both creator and reviewer are write-capable.
- Keel does not currently enforce that the reviewer only appends correspondence.
- Pi/Codex is the default writer/reviewer provider because it can write
  correspondence in the normal local workflow setup. Prefer
  `creatorModel: "openai-codex/gpt-5.5"` for Pi-authored specs unless a task has
  a reason to use the provider default. If you use Claude for either role,
  configure Claude to permit `Edit`/`Write`; otherwise it may return findings
  without appending to the file.
- `ctx.agentSession` does not support `workspaceIsolation: true` yet, so this
  workflow edits the target spec directly.
- Keep `maxRounds` small. The workflow caps it at `10`.
- This workflow does not request Keel secret refs. Do not put raw secret values in
  prompts or input; agent outputs are journaled as-is.

## Input

| Field | Required | Meaning |
|---|---:|---|
| `specPath` | yes | Absolute path to the spec document to create or revise. |
| `request` | yes | High-level user request for the spec. |
| `creatorIdentity` | no | Header identity string for creator correspondence. |
| `reviewerIdentity` | no | Header identity string for reviewer correspondence. |
| `creatorProvider` | no | Creator provider. Defaults to `pi`. |
| `creatorModel` | no | Creator model name. |
| `creatorReasoning` | no | Creator reasoning effort. Defaults to `xhigh`. |
| `creatorToolPolicy` | no | Defaults to `workspace-write`. |
| `reviewerProvider` | no | Reviewer provider. Defaults to `pi`. |
| `reviewerModel` | no | Reviewer model name. |
| `reviewerReasoning` | no | Reviewer reasoning effort. Defaults to `xhigh`. |
| `reviewerToolPolicy` | no | Defaults to `workspace-write`. |
| `maxRounds` | no | Maximum creator/reviewer rounds. Defaults to `3`, capped at `10`. |
