# Iterative Review Workflow

`iterative-review.workflow.ts` runs one logical reviewer agent across multiple
review/fix cycles using `ctx.agentSession`. The workflow performs an initial
review, parks on a signal, then resumes the same backend conversation for each
follow-up review.

Launch:

```bash
keel launch --detach workflows/iterative-review/iterative-review.workflow.ts \
  --name iterative-review \
  --target /home/kevin/worktrees/keel \
  --emit-capability \
  --input '{
    "task": "Review the durable agent sessions implementation",
    "spec": "/home/kevin/worktrees/keel/.specs/durable-agent-sessions.md",
    "reasoning": "high",
    "maxRounds": 10,
    "stopWhenClean": false
}'
```

The workflow resolves its review workspace from `input.repository` when provided,
otherwise from `ctx.run.target` (`--target`, or the CLI cwd if `--target` is
omitted). It binds that path with `ctx.withWorkspace({ mode: "direct" })`, so
the reviewer cwd matches the repository named in prompts. To review a
manually-created git worktree, pass that worktree path as `--target`;
`repository` may be omitted unless you need to override it intentionally.

For manual code review cycles, prefer `stopWhenClean: false` with a higher
`maxRounds` such as `10`. That keeps the durable reviewer session parked after a
clean review so a human or implementing agent can make more changes and
re-invoke the same reviewer conversation. Stop the run explicitly when review is
complete.

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
| `repository` | no | Absolute path to the repository or workspace to review. Defaults to the run target. |
| `task` | yes | The concrete implementation, design, or change to review. |
| `spec` | no | Optional absolute path to a spec, design note, or acceptance criteria. |
| `focus` | no | Optional review focus such as security, replay semantics, or docs. |
| `reasoning` | no | Override reasoning effort for the `claude-default` reviewer profile. |
| `maxRounds` | no | Maximum follow-up review turns. Defaults to `3`, capped at `20`. |
| `signalName` | no | Signal name for follow-up payloads. Defaults to `review-cycle`. |
| `stopWhenClean` | no | Defaults to `true`. Set `false` to keep parking for more cycles even after a clean review. |

The reviewer participant key is `reviewer`; turn keys are `initial`,
`followup-1`, `followup-2`, and so on. The reviewer uses the daemon
`claude-default` profile with read-only tools.
