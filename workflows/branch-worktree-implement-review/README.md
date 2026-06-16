# Branch Worktree Implement Review Workflow

`branch-worktree-implement-review.workflow.ts` runs the same autonomous
implement/review loop as `implement-review-loop`, but first creates a Keel-owned
git worktree on a generated branch.

Use this workflow when implementation should be isolated from the launch target
while still producing a real branch for inspection, commits, and later manual
merge or cherry-pick.

Launch:

```bash
keel launch --detach workflows/branch-worktree-implement-review/branch-worktree-implement-review.workflow.ts \
  --name branch-worktree-implement-review \
  --target /home/kevin/worktrees/keel \
  --emit-capability \
  --input '{
    "spec": "/home/kevin/worktrees/keel/.specs/some-feature.md",
    "task": "Implement the feature described by the spec",
    "maxRounds": 3,
    "completionMode": "park-before-complete",
    "implementerReasoning": "high",
    "reviewerReasoning": "high",
    "verificationCommand": "bun test src/agents/capabilities.test.ts && bun run typecheck"
  }'
```

The workflow creates:

```ts
await ctx.workspace({
  key: "implementation",
  mode: "worktree",
  path: input.repository ?? ctx.run.target,
  ref: input.ref ?? "HEAD",
  branch: true,
  retention: input.retention ?? "retain",
});
```

`branch: true` creates a generated branch such as
`keel/<run-hash>/<workspace-slug>-<key-hash>`. Keel does not accept
user-supplied branch names in this workflow. The default `retention` is
`"retain"` so a clean run leaves the worktree and branch available for manual
inspection.

The workflow binds the branch worktree with `ctx.withWorkspace(workspace, ...)`.
The implementer and reviewer both run in that same worktree, so the reviewer
sees the implementer's uncommitted and committed changes. Prompts instruct both
agents to use the current working directory rather than the source repository
path.

After launch, inspect the retained workspace with:

```bash
keel workspace list
keel workspace show <run-id> implementation
keel workspace diff <run-id> implementation
```

Use `completionMode: "park-before-complete"` when a human or orchestrator should
make the final call after a clean review. Complete it with:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> implementation-completion '{
  "action": "complete"
}'
```

Or request another implementation/review round:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> implementation-completion '{
  "action": "continue",
  "instructions": "Add a regression test for the workspace identity edge case.",
  "reviewFocus": "Check tests and branch worktree cleanup behavior."
}'
```

## Input

| Field | Required | Meaning |
|---|---:|---|
| `repository` | no | Source repository for the worktree. Defaults to the run target. |
| `ref` | no | Source ref for the worktree. Defaults to `HEAD`. |
| `retention` | no | `"retain"` by default; also accepts `"remove"` or `"retain-on-failure"`. |
| `spec` | yes | Absolute path to the implementation spec or design note. |
| `task` | no | Additional task wording for the implementer and reviewer. |
| `maxRounds` | no | Maximum implement/review rounds. Defaults to `3`, capped at `10`. |
| `completionMode` | no | `"auto"` by default. Use `"park-before-complete"` to wait for completion/follow-up. |
| `completionSignalName` | no | Signal name for parked clean completion. Defaults to `implementation-completion`. |
| `implementerReasoning` | no | Override reasoning effort for the `codex-default` implementer profile. |
| `reviewerReasoning` | no | Override reasoning effort for the `claude-default` reviewer profile. |
| `reviewFocus` | no | Optional focus for the reviewer. |
| `verificationCommand` | no | Optional command the implementer should run when practical. |

The implementer participant key is `implementer`; reviewer participant key is
`reviewer`; workspace key is `implementation`.
