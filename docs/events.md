# Event Streams

Keel event streams expose raw run events for daemon RPC, CLI watch, TUI attach,
execute scripts, and future web transports. Human renderers such as
`keel watch --output text` may coalesce display, but the stream itself delivers
raw frames.

## Event Envelopes

Durable events have `kind: "durable"`, a per-run monotonic `seq`, `type`,
`payload`, and `atMs`. They are replayable and are the only frames that advance
a durable cursor.

Ephemeral events have `kind: "ephemeral"`, `type`, `payload`, and `atMs`. They
are delivered only to currently connected subscribers. Live agent delta frames
are ephemeral; finalized tool calls, tool results, and assistant messages are
durable transcript rows.

## Cursors

Subscription APIs use a request object:

```ts
subscribeEvents({ runId, cursor }, onEvent)
```

`cursor` defaults to `{ kind: "beginning" }` and may be:

- `{ kind: "beginning" }`: backfill all durable events, then tail live frames.
- `{ kind: "after-seq", seq }`: backfill durable events with `seq` greater than
  the supplied value.
- `{ kind: "tail", count }`: backfill at most the last `count` durable events,
  then tail live frames. `count: 0` skips durable backfill.
- `{ kind: "now" }`: skip existing durable history and tail from the durable
  high-water mark observed during subscription setup.

The resolved output cursor is `{ kind: "after-seq", runId, seq }`. Reconnecting
with that cursor resumes after the last durable sequence represented by the
stream boundary.

Cursor validation fails closed: sequence and tail counts must be finite
non-negative integers, tail count is bounded by `MAX_EVENT_TAIL_COUNT`, and
unknown cursor shapes are rejected.

## Stream Boundaries

Backfill completes before the local daemon client reports `onCaughtUp`. The
caught-up result includes the resolved durable cursor and a `closedStatus` when
the run was already closed at cursor resolution time. In-process subscribers can
also receive control frames through the control callback.

Closed status lets `keel watch --from now`, `--tail 0`, and execute event
iteration terminate deterministically when the requested cursor skips an existing
terminal, parked, or interrupted event.

## Authorization

Event subscriptions require `run:events`. Long-lived daemon subscriptions keep
the credential snapshot used at subscription time and continue to fail closed on
revocation. Existing socket clients receive authorization revocation as an
ephemeral `authorization.failed` event with a redacted `{ message }` payload.

All streamed event and control payloads that cross daemon, CLI, execute, or
future web boundaries must pass through capability-token redaction.

## CLI

`keel watch <runId>` defaults to `{ kind: "beginning" }`.

```bash
keel watch run_...
keel watch run_... --from beginning
keel watch run_... --from now
keel watch run_... --after-seq 123
keel watch run_... --tail 100
```

`--from beginning|now`, `--after-seq`, and `--tail` are mutually exclusive.
