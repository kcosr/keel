# Web UI Product Loop Workflow

`web-ui-product-loop.workflow.ts` coordinates a long-running implementation of
the production Keel web UI. It creates a retained generated-branch worktree,
keeps Codex implementer and Claude reviewer sessions alive within each
milestone, and parks after accepted milestones for orchestrator inspection.

Launch:

```bash
keel launch --detach workflows/web-ui-product-loop/web-ui-product-loop.workflow.ts \
  --name web-ui-product-loop \
  --target /home/kevin/worktrees/keel \
  --emit-capability \
  --input '{
    "spec": "/home/kevin/worktrees/keel/.specs/web-ui-end-state-implementation.md",
    "mockupsDir": "/home/kevin/worktrees/keel/.specs/web-ui-mockups",
    "prototypeDir": "/home/kevin/worktrees/keel/.specs/web-ui-mockups/prototype",
    "implementerReasoning": "xhigh",
    "reviewerReasoning": "xhigh",
    "maxRoundsPerMilestone": 10
  }'
```

The workflow creates:

```ts
await ctx.workspace({
  key: "web-ui-product",
  mode: "worktree",
  path: input.repository ?? ctx.run.target,
  ref: input.ref ?? "HEAD",
  branch: true,
  retention: "retain",
});
```

Both agents run inside the same branch-backed worktree, so Claude reviews the
actual Codex changes. The branch and worktree are retained for manual
inspection and final PR creation.

The default `spec`, `mockupsDir`, and `prototypeDir` resolve relative to the
source repository, not the generated worktree. That is intentional: `.specs/`
is ignored and treated as read-only planning/reference material, while all code,
tests, screenshots, and commits happen in the generated worktree.

## Milestones

Default milestones:

1. Frontend foundation
2. Runs inbox and live detail
3. Approvals and workspaces
4. Workflow, schedule, profile, settings, and system surfaces
5. Polish and production readiness

Each milestone runs implement/review rounds until there are no blocking
findings, a block is reported, or `maxRoundsPerMilestone` is reached. Low
findings are advisory by default. If max rounds are reached with blocking
findings, the workflow parks on the control signal instead of terminating.

## Control Signal

Default signal name: `web-ui-control`.

Proceed to the next milestone:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> web-ui-control '{
  "action": "next",
  "instructions": "Proceed; keep the visual density close to the prototype."
}'
```

Request another implementation/review round for the current milestone:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> web-ui-control '{
  "action": "rework",
  "instructions": "Add browser screenshots for the run detail route.",
  "reviewFocus": "Verify screenshot coverage and responsive layout."
}'
```

Finish the workflow after the accepted milestone or intentionally stop the loop:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> web-ui-control '{
  "action": "complete"
}'
```

Use one signal with an `action` field because the workflow SDK does not provide
a wait-any primitive across multiple signal names.

## Input

| Field | Required | Meaning |
|---|---:|---|
| `repository` | no | Source repository for the branch worktree. Defaults to run target. |
| `ref` | no | Source ref. Defaults to `HEAD`. |
| `spec` | no | Web UI implementation spec. Defaults to `.specs/web-ui-end-state-implementation.md`. |
| `prototypeDir` | no | Visual prototype path. Defaults to `.specs/web-ui-mockups/prototype`. |
| `mockupsDir` | no | Mockup image directory. Defaults to `.specs/web-ui-mockups`. |
| `milestones` | no | Override milestone list. |
| `maxRoundsPerMilestone` | no | Defaults to `4`, capped at `10`. |
| `implementerReasoning` | no | Defaults to `xhigh`. |
| `reviewerReasoning` | no | Defaults to `xhigh`. |
| `controlSignalName` | no | Defaults to `web-ui-control`. |
| `verificationCommand` | no | Additional verification instruction for the implementer. |

## Orchestrator Responsibilities

This workflow is a collaboration loop, not an automatic merge.

The orchestrator should:

- inspect the retained worktree after each clean milestone;
- run local tests and browser smoke when practical;
- view or capture screenshots;
- decide whether to signal `next`, `rework`, or `complete`;
- create and merge the final PR intentionally.

The default branch model is one generated branch for the whole web product loop,
with commits separating milestones. For independently mergeable milestone PRs,
launch separate workflow runs or rebase/cherry-pick milestone commits manually.

For pre-merge browser smoke, build the worktree frontend and point the web
server at that worktree's assets:

```bash
bun run web:build
keel web --assets /path/to/generated/worktree/web/dist --port 3000
```
