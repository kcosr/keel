# Spec Author Review Loop Workflow

`spec-author-review-loop.workflow.ts` is fully orchestrated. A write-capable spec
creator drafts or revises the main spec, then a write-capable reviewer appends
timestamped correspondence. Findings are fed back to the creator until the spec
is clean, the creator is blocked, or `maxRounds` is reached. By default, a clean
review parks for a human complete/continue decision before the workflow returns.

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
    "maxRounds": 10
  }'
```

By default, `completionMode` is `"park-before-complete"` so a human or
orchestrator can make the final call after a clean review. Complete it with:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> spec-author-completion '{
  "action": "complete"
}'
```

Or request another creator/reviewer round:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> spec-author-completion '{
  "action": "continue",
  "instructions": "Before completion, add rollout and rollback details."
}'
```

## Correspondence Format

Both agents receive an ISO timestamp from `ctx.now()` and are instructed to append
under `## Correspondence` with headers like:

```md
### 2026-06-13T23:00:00.000Z - Creator: codex-default
### 2026-06-13T23:01:00.000Z - Reviewer: claude-default
```

No round label is required; the timestamp and identity preserve history.

## Safety Notes

- The creator uses the daemon `codex-default` profile, and the reviewer uses the
  daemon `claude-default` profile with workspace-write tools.
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
| `creatorProfile` | no | Creator profile name. Defaults to `codex-default`. |
| `reviewerProfile` | no | Reviewer profile name. Defaults to `claude-default`. |
| `creatorReasoning` | no | Override reasoning effort for the selected creator profile. |
| `reviewerReasoning` | no | Override reasoning effort for the selected reviewer profile. |
| `maxRounds` | no | Maximum creator/reviewer rounds. Defaults to `10`, capped at `10`. |
| `completionMode` | no | `"park-before-complete"` by default. Set `"auto"` to complete immediately after a clean review. |
| `completionSignalName` | no | Signal name for parked clean completion. Defaults to `spec-author-completion`. |
