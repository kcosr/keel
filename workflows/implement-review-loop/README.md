# Implement Review Loop Workflow

`implement-review-loop.workflow.ts` runs an autonomous bounded implementation
loop. A write-capable implementer edits the target repository, a read-only
reviewer checks the work, and remaining findings are sent back to the
implementer.

Launch:

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
    "implementerReasoning": "xhigh",
    "implementerToolPolicy": "workspace-write",
    "reviewerProvider": "claude",
    "reviewerModel": "claude-opus-4-8",
    "reviewerReasoning": "xhigh",
    "reviewerToolPolicy": "read-only",
    "verificationCommand": "bun test src/kernel/realm/agent-session.test.ts"
  }'
```

## Safety Notes

- The implementer is write-capable and edits the target repository directly.
- If `verificationCommand` is set, the implementer receives shell capability
  with workspace write access so it can run that command. Otherwise it uses
  `implementerToolPolicy`, defaulting to `workspace-write` without shell.
- The reviewer is read-only and is prompted not to modify files.
- `ctx.agentSession` does not support `workspaceIsolation: true` yet, so do not
  use this workflow when edits must be confined to a disposable worktree.
- Keep `maxRounds` small. The workflow caps it at `10`.
- Do not pass secrets to this workflow.

## Input

| Field | Required | Meaning |
|---|---:|---|
| `repository` | yes | Absolute path to the repository to edit and review. |
| `spec` | yes | Absolute path to the implementation spec or design note. |
| `task` | no | Additional task wording for the implementer and reviewer. |
| `maxRounds` | no | Maximum implement/review rounds. Defaults to `3`, capped at `10`. |
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
