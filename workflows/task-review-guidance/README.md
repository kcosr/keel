# Task Review Guidance

This package provides one-shot review workflows backed by shared deterministic
TypeScript guidance helpers.

Use `code-review.workflow.ts` for independent read-only code review of a
repository or explicit target path. Use `plan-review.workflow.ts` for one-shot
review of a design or spec document. Use `docs-review.workflow.ts` for
read-only documentation review against the repository's actual public surface.
Keep using `spec-review-loop`,
`spec-author-review-loop`, `iterative-review`, or `implement-review-loop` when
the work needs a durable multi-turn loop with signals or implementation cycles.

Path launch examples:

```bash
keel run workflows/task-review-guidance/code-review.workflow.ts \
  --input '{"repository":".","task":"review the current change","focus":["capabilities","tests"]}'

keel run workflows/task-review-guidance/plan-review.workflow.ts \
  --input '{"specPath":".specs/example.md","request":"review for implementation gaps"}'

keel run workflows/task-review-guidance/docs-review.workflow.ts \
  --input '{"repository":".","task":"review docs for the current change"}'
```

Saved workflow packaging:

```bash
keel workflow install task-review-guidance

# Lower-level equivalent when installing manually:
keel workflow save task-code-review workflows/task-review-guidance/code-review.workflow.ts --version 1
keel workflow save task-plan-review workflows/task-review-guidance/plan-review.workflow.ts --version 1
keel workflow save task-docs-review workflows/task-review-guidance/docs-review.workflow.ts --version 1

keel workflow run task-code-review --version 1 \
  --input '{"repository":".","task":"review the current change"}'
keel workflow run task-plan-review --version 1 \
  --input '{"specPath":".specs/example.md","request":"review the plan"}'
keel workflow run task-docs-review --version 1 \
  --input '{"repository":".","task":"review docs for the current change"}'
keel workflow source task-plan-review --version 1 --all
```

All three workflows return:

```ts
{
  status: "clean" | "changes-requested";
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    file?: string;
    line?: number;
    title: string;
    evidence: string;
    recommendation: string;
  }>;
  summary: string;
}
```

`plan-review.workflow.ts` also returns `appended: boolean`. When
`appendCorrespondence` is true, pass an exact `correspondenceHeader`; the
workflow uses a direct workspace-write reviewer to append only under
`## Correspondence`, then a read-only confirmation agent verifies the header.

The shared guidance lives in `guidance/*.ts` as pure workflow source helpers. Do
not add YAML manifests, mutable task state, task-note commands, or external
runtime guidance imports. Prompt text, checklist content, severity rules, output
contracts, and workflow input/output contract changes require saving a new
workflow version. Editing these helper files does not mutate already saved
versions; inspect the pinned helper source with `keel workflow source <name>
--version N --all`.

`keel workflow install task-review-guidance` is explicit and repeatable. It
previews each captured definition through the daemon, reports per-workflow
`created`, `unchanged`, `conflict`, or `failed`, and exits nonzero only after all
entries have been attempted if any entry failed or conflicted. The command
requires admin authority because it spans multiple saved workflow names and uses
daemon-wide preview/list operations.
