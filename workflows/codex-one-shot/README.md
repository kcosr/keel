# Codex One-Shot Workflow

`codex-one-shot` runs one Codex agent on one prompt and returns its plain-text
answer. It gives Codex workspace-write access to the explicit launch target.
Edits apply directly to that directory.

Install the workflow and its profiles with `bun run defaults:seed`, then pass
the directory you want Codex to edit with `--target`.

```bash
keel workflow run codex-one-shot --target /path/to/repo --output text \
  --input '{"prompt":"Update the README quickstart and check its commands.","profile":"codex-fast"}'
```

`prompt` is required and must contain non-whitespace text. Choose one of the
seeded Codex profiles to set the model, effort, and service tier.

| Profile | Service tier |
|---|---|
| `codex-default` (default) | Inherit Codex settings |
| `codex-fast` | Request Fast (`priority`) |
| `codex-ultrafast` | Request Ultrafast (`ultrafast`) |

Run the workflow with these seeded local profiles. Codex determines which tiers
the selected model and account can use.
