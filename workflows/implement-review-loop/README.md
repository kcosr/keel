# Implement Review Loop Workflow

`implement-review-loop.workflow.ts` runs an autonomous bounded implementation
loop. A write-capable implementer edits the target repository, a read-only
reviewer checks the work, and remaining findings are sent back to the
implementer.

Use this workflow when Keel should drive the implementation loop itself. If a
human or external agent owns the fixes and you want the same reviewer
conversation to park for manual re-invocation, use
[`../iterative-review/`](../iterative-review/) with `stopWhenClean: false` and a
higher `maxRounds` such as `10`.

Launch for autonomous completion:

```bash
keel launch --detach workflows/implement-review-loop/implement-review-loop.workflow.ts \
  --name implement-review \
  --emit-capability \
  --input '{
    "repository": "/home/kevin/worktrees/keel",
    "spec": "/home/kevin/worktrees/keel/.specs/some-feature.md",
    "task": "Implement the feature described by the spec",
    "maxRounds": 3,
    "implementerReasoning": "high",
    "reviewerReasoning": "high",
    "verificationCommand": "bun test src/kernel/realm/agent-session.test.ts"
  }'
```

For agent/orchestrator use, prefer watching the run after launch instead of
ending the turn at the detached run id:

```bash
keel watch <run-id> --output text
```

Use `completionMode: "park-before-complete"` when a human or orchestrator should
make the final call after a clean review. In that mode, the workflow parks on
`implementation-completion` instead of returning immediately. Complete it with:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> implementation-completion '{
  "action": "complete"
}'
```

Or request another implementation/review round with the same implementer and
reviewer sessions:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> implementation-completion '{
  "action": "continue",
  "instructions": "Before completion, add a migration test for retained diff_error rows.",
  "reviewFocus": "Check the new migration test and any touched cleanup paths."
}'
```

## Safety Notes

- The implementer uses the daemon `codex-default` profile and edits the target
  repository directly.
- The reviewer uses the daemon `claude-default` profile with read-only tools and
  is prompted not to modify files.
- If `verificationCommand` is set, the implementer is asked to run it when
  practical; the `codex-default` profile supplies the tool access.
- This workflow uses the run default direct workspace, so do not use it when
  edits must be confined to a disposable worktree.
- Keep `maxRounds` small. The workflow caps it at `10`.
- This workflow does not request Keel secret refs. Do not put raw secret values in
  prompts or input; agent outputs are journaled as-is.

## Input

| Field | Required | Meaning |
|---|---:|---|
| `repository` | yes | Absolute path to the repository to edit and review. |
| `spec` | yes | Absolute path to the implementation spec or design note. |
| `task` | no | Additional task wording for the implementer and reviewer. |
| `maxRounds` | no | Maximum implement/review rounds. Defaults to `3`, capped at `10`. |
| `completionMode` | no | `"auto"` by default. Use `"park-before-complete"` to wait for a final completion/continue signal after a clean review. |
| `completionSignalName` | no | Signal name for parked clean completion. Defaults to `implementation-completion`. |
| `implementerReasoning` | no | Override reasoning effort for the `codex-default` implementer profile. |
| `reviewerReasoning` | no | Override reasoning effort for the `claude-default` reviewer profile. |
| `reviewFocus` | no | Optional focus for the reviewer. |
| `verificationCommand` | no | Optional command the implementer should run when practical. |

The implementer participant key is `implementer`; reviewer participant key is
`reviewer`.
