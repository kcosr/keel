# Iterative Review Workflow

`iterative-review.workflow.ts` runs one logical reviewer agent across multiple
review/fix cycles using `ctx.agentSession`. The workflow performs an initial
review, parks on a signal, then resumes the same backend conversation for each
follow-up review.

Launch:

```bash
keel launch --detach workflows/iterative-review/iterative-review.workflow.ts \
  --name iterative-review \
  --emit-capability \
  --input '{
    "repository": "/home/kevin/worktrees/keel",
    "task": "Review the durable agent sessions implementation",
    "spec": "/home/kevin/worktrees/keel/.specs/durable-agent-sessions.md",
    "provider": "claude",
    "model": "claude-opus-4-8",
    "reasoning": "xhigh",
    "toolPolicy": "read-only",
    "maxRounds": 3
  }'
```

Signal after applying fixes:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> review-cycle '{
  "summary": "Fixed the issues from the prior review and ran focused tests.",
  "instructions": "Re-check the changed files and any adjacent replay behavior."
}'
```

Stop a parked review without another model turn:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> review-cycle '{
  "summary": "No further review requested.",
  "done": true
}'
```

## Input

| Field | Required | Meaning |
|---|---:|---|
| `repository` | yes | Absolute path to the repository or workspace to review. |
| `task` | yes | The concrete implementation, design, or change to review. |
| `spec` | no | Optional absolute path to a spec, design note, or acceptance criteria. |
| `focus` | no | Optional review focus such as security, replay semantics, or docs. |
| `provider` | no | Agent provider. Defaults to `claude`. |
| `model` | no | Provider model name. |
| `reasoning` | no | Reasoning effort. Defaults to `xhigh`. |
| `toolPolicy` | no | Tool policy. Defaults to `read-only`. |
| `maxRounds` | no | Maximum follow-up review turns. Defaults to `3`, capped at `20`. |
| `signalName` | no | Signal name for follow-up payloads. Defaults to `review-cycle`. |
| `stopWhenClean` | no | Defaults to `true`. Set `false` to keep parking for more cycles even after a clean review. |

The reviewer participant key is `reviewer`; turn keys are `initial`,
`followup-1`, `followup-2`, and so on.
