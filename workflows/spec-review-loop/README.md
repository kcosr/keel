# Spec Review Loop Workflow

`spec-review-loop.workflow.ts` is creator-driven. A user or invoking agent owns
the main spec content, while this workflow keeps one durable reviewer session
available. The reviewer has write access so it can append timestamped
correspondence to the spec file.

The invoking creator updates the main design content outside the workflow, then
signals this run to resume reviewer continuity.

Launch:

```bash
keel launch --detach workflows/spec-review-loop/spec-review-loop.workflow.ts \
  --name spec-review \
  --emit-capability \
  --input '{
    "specPath": "/home/kevin/worktrees/keel/.specs/new-feature.md",
    "task": "Review this proposed feature design",
    "reviewerIdentity": "Reviewer: pi/default",
    "reviewerProvider": "pi",
    "reviewerReasoning": "xhigh",
    "reviewerToolPolicy": "workspace-write",
    "maxReviews": 3
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

- The reviewer is write-capable and should only append correspondence.
- Pi/Codex is the default reviewer provider because it can write correspondence
  in the normal local workflow setup. If you use Claude for this role, configure
  Claude to permit `Edit`/`Write`; otherwise it may return findings without
  appending to the file.
- Keel does not currently enforce append-only writes to a section; this is prompt
  discipline, not a sandbox boundary.
- Keep `maxReviews` small. The workflow caps it at `20`.

## Input

| Field | Required | Meaning |
|---|---:|---|
| `specPath` | yes | Absolute path to the spec document. |
| `task` | yes | What the reviewer should evaluate. |
| `reviewerIdentity` | no | Header identity string. Defaults from provider/model. |
| `reviewerProvider` | no | Reviewer provider. Defaults to `pi`. |
| `reviewerModel` | no | Reviewer model name. |
| `reviewerReasoning` | no | Reviewer reasoning effort. Defaults to `xhigh`. |
| `reviewerToolPolicy` | no | Defaults to `workspace-write` so correspondence can be appended. |
| `maxReviews` | no | Maximum reviewer turns. Defaults to `3`, capped at `20`. |
| `signalName` | no | Defaults to `spec-review-cycle`. |
| `stopWhenClean` | no | Defaults to `true`. |
