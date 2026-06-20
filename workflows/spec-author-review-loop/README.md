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
    "creatorReasoning": "high",
    "reviewerReasoning": "xhigh",
    "maxRounds": 3
  }'
```

## Correspondence Format

Both agents receive an ISO timestamp from `ctx.now()` and are instructed to append
under `## Correspondence` with headers like:

```md
### 2026-06-13T23:00:00.000Z - Creator: codex/gpt-5.5
### 2026-06-13T23:01:00.000Z - Reviewer: claude/claude-opus-4-8
```

No round label is required; the timestamp and identity preserve history.

## Safety Notes

- The creator uses Codex `gpt-5.5`, and the reviewer uses Claude
  `claude-opus-4-8` with workspace-write tools. Both default to `xhigh`
  reasoning.
- Both creator and reviewer are write-capable.
- Keel does not currently enforce that the reviewer only appends correspondence.
- This workflow uses the run default direct workspace, so it edits the target
  spec directly.
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
| `creatorReasoning` | no | Override reasoning effort for the Codex creator. Defaults to `xhigh`. |
| `reviewerReasoning` | no | Override reasoning effort for the Claude reviewer. Defaults to `xhigh`. |
| `maxRounds` | no | Maximum creator/reviewer rounds. Defaults to `3`, capped at `10`. |
