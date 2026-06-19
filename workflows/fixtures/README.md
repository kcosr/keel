# Fixture Workflows

These workflows are runnable examples and test fixtures. They are intentionally
small and are not curated operational workflows.

## Command And Completion Checks

[`command-completion.fixture.workflow.ts`](./command-completion.fixture.workflow.ts)
demonstrates a direct workspace, a durable `ctx.command(...)`, and durable
`ctx.completionCheck(...)` calls in one workflow.

Run it against a local directory:

```bash
keel run workflows/fixtures/command-completion.fixture.workflow.ts \
  --target "$PWD" \
  --input "{\"workspace\":\"$PWD\"}"
```

Override the default check with git-oriented completion checks:

```bash
keel run workflows/fixtures/command-completion.fixture.workflow.ts \
  --target "$PWD" \
  --input '{
    "workspace": "'"$PWD"'",
    "completionChecks": [
      { "key": "clean", "type": "git-clean" },
      { "key": "tests", "type": "command", "command": "bun", "args": ["test", "src/kernel/realm"] }
    ]
  }'
```
