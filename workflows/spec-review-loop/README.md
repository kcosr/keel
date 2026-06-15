# Spec Review Loop Workflow

`spec-review-loop.workflow.ts` is creator-driven. A user or invoking agent owns
the main spec content, while this workflow keeps one durable reviewer session
available. The reviewer has write access so it can append timestamped
correspondence to the spec file.

The invoking creator updates the main design content outside the workflow, then
signals this run to resume reviewer continuity.

Launch for manual back-and-forth:

```bash
keel launch --detach workflows/spec-review-loop/spec-review-loop.workflow.ts \
  --name spec-review \
  --emit-capability \
  --input '{
    "specPath": "/home/kevin/worktrees/keel/.specs/new-feature.md",
    "task": "Review this proposed feature design",
    "reviewerReasoning": "xhigh",
    "maxReviews": 10,
    "stopWhenClean": false
  }'
```

For iterative spec work, prefer `stopWhenClean: false` with a higher
`maxReviews` such as `10`. That keeps the durable reviewer session parked after a
clean review so the creator can make follow-up changes and re-invoke the same
reviewer conversation. Stop the run explicitly when no further review is needed.

For agent/orchestrator use, prefer watching the run after launch instead of
ending the turn at the detached run id:

```bash
keel watch <run-id> --output text
```

Use `completionMode: "park-before-complete"` with the default
`stopWhenClean: true` when the reviewer should stop at a clean review but the
creator should decide whether to complete or ask for one more pass. In that mode,
the workflow parks on `spec-review-completion` after a clean review. Complete it
with:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> spec-review-completion '{
  "action": "complete"
}'
```

Or ask the same reviewer session for another review:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> spec-review-completion '{
  "action": "continue",
  "summary": "I updated the acceptance criteria after the clean review; please re-check them."
}'
```

Signal after the creator updates the spec:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> spec-review-cycle '{
  "summary": "Updated the main design to address the reviewer correspondence."
}'
```

Stop a parked review:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> spec-review-cycle '{
  "summary": "No further review requested.",
  "done": true
}'
```

## Correspondence Format

The workflow supplies an ISO timestamp from `ctx.now()` and instructs the reviewer
to append under `## Correspondence` using:

```md
### 2026-06-13T23:00:00.000Z - Reviewer: claude/claude-opus-4-8
```

No round label is required; the timestamp and identity preserve history.

## Safety Notes

- The reviewer uses the daemon `claude-default` profile with workspace-write
  tools so it can append correspondence.
- The reviewer is write-capable and should only append correspondence.
- Keel does not currently enforce append-only writes to a section; this is prompt
  discipline, not a sandbox boundary.
- Keep `maxReviews` bounded. For manual back-and-forth spec work, `10` is a good
  default; the workflow caps it at `20`.

## Input

| Field | Required | Meaning |
|---|---:|---|
| `specPath` | yes | Absolute path to the spec document. |
| `task` | yes | What the reviewer should evaluate. |
| `reviewerIdentity` | no | Header identity string. Defaults to `Reviewer: claude-default`. |
| `reviewerReasoning` | no | Override reasoning effort for the `claude-default` reviewer profile. |
| `maxReviews` | no | Maximum reviewer turns. Defaults to `3`, capped at `20`. |
| `signalName` | no | Defaults to `spec-review-cycle`. |
| `completionMode` | no | `"auto"` by default. Use `"park-before-complete"` to wait for a final completion/continue signal after a clean review. |
| `completionSignalName` | no | Signal name for parked clean completion. Defaults to `spec-review-completion`. |
| `stopWhenClean` | no | Defaults to `true`. |
