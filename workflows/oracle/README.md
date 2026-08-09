# Oracle Workflow

`oracle.workflow.ts` provides an artifact-free consultation with one durable
agent session. It answers an initial question in plain text, parks on a signal,
and resumes the same backend conversation for each follow-up question. The run
target is bound as a direct read-only workspace, so the agent can inspect relevant
local context without requiring a spec, branch, or other named artifact.
The default Claude profile adds Bash for normal code inspection. Keel's Claude
adapter does not OS-sandbox Bash, so the workflow prompt prohibits writes but
the host filesystem does not enforce that prohibition.

Launch a consultation:

```bash
keel workflow launch oracle --detach --emit-capability \
  --target /home/kevin/worktrees/voice-runtime --input '{
  "question": "Which boundary should own PCM normalization, and why?",
  "context": "The provider may emit different PCM byte orders. Downstream clients expect s16le."
}'
```

Watch the run to receive each plain-text answer as it is produced:

```bash
KEEL_RUN_CAP=kc_run_... keel watch <run-id>
```

Ask a follow-up after the workflow parks:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> oracle-question '{
  "question": "What compatibility behavior would you expose at the HTTP boundary?",
  "context": "OpenAI compatibility is the primary interface."
}'
```

Stop without another model turn:

```bash
KEEL_RUN_CAP=kc_run_... keel signal <run-id> oracle-question '{
  "done": true
}'
```

Each answer is emitted as an `oracle.response.<turn>` log entry. When the run is
stopped or reaches its turn limit, its result is a plain-text transcript of all
questions and answers. Set `maxTurns` to `1` for a one-shot consultation that
returns immediately after its first answer.

## Input

| Field | Required | Meaning |
|---|---:|---|
| `question` | yes | Initial question for the Oracle. |
| `context` | no | Background that is useful for the initial answer. No repository or artifact is implied. |
| `profile` | no | Agent profile name. Defaults to `claude-fable-5`. |
| `reasoning` | no | Reasoning effort override. The default profile uses `xhigh`; another selected profile keeps its configured reasoning when this is omitted. |
| `maxTurns` | no | Total answers including the initial answer. Defaults to `10`, capped at `10`. Use `1` for one-shot use. |
| `signalName` | no | Follow-up signal name. Defaults to `oracle-question`. |

The saved workflow's default target is the worktree from which the local seed
was run. Pass `--target` to use a different worktree for a consultation.

The signal payload accepts `question` and optional `context`, or `done: true`.
Malformed payloads are logged and the workflow parks for a replacement signal
without consuming an Oracle turn.
The participant key is `oracle`; turn keys are `question-1`, `question-2`, and
so on.
