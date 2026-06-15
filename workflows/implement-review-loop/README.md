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
    "implementerProvider": "pi",
    "implementerModel": "openai-codex/gpt-5.5",
    "implementerReasoning": "xhigh",
    "implementerToolPolicy": "workspace-write",
    "reviewerProvider": "claude",
    "reviewerModel": "claude-opus-4-8",
    "reviewerReasoning": "xhigh",
    "reviewerToolPolicy": "read-only",
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

- The implementer is write-capable and edits the target repository directly.
- Prefer `implementerModel: "openai-codex/gpt-5.5"` for Pi implementers unless
  a task has a reason to use the provider default.
- If `verificationCommand` is set, the implementer receives shell capability
  with workspace write access so it can run that command. Otherwise it uses
  `implementerToolPolicy`, defaulting to `workspace-write` without shell.
- The reviewer is read-only and is prompted not to modify files.
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
| `implementerProvider` | no | Implementer provider. Defaults to `pi`. |
| `implementerModel` | no | Implementer model name. |
| `implementerReasoning` | no | Implementer reasoning effort. Defaults to `xhigh`. |
| `implementerToolPolicy` | no | Implementer tool policy when `verificationCommand` is absent. Defaults to `workspace-write`. |
| `reviewerProvider` | no | Reviewer provider. Defaults to `claude`. |
| `reviewerModel` | no | Reviewer model name. |
| `reviewerReasoning` | no | Reviewer reasoning effort. Defaults to `xhigh`. |
| `reviewerToolPolicy` | no | Reviewer tool policy. Defaults to `read-only`. |
| `reviewFocus` | no | Optional focus for the reviewer. |
| `verificationCommand` | no | Optional command the implementer should run when practical. |

The implementer participant key is `implementer`; reviewer participant key is
`reviewer`.
