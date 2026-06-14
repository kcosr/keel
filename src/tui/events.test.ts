import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../rpc/contract.ts";
import { formatTuiWatchEvent } from "./events.ts";

describe("tui events", () => {
  test("formats watch events through shared redaction semantics", () => {
    const event: EventEnvelope = {
      kind: "durable",
      seq: 3,
      type: "log",
      payload: { message: "token kc_run_secretValue" },
      atMs: 1_000,
    };

    const formatted = formatTuiWatchEvent(event);
    expect(formatted.lines.join("\n")).toContain("«redacted-capability»");
    expect(formatted.lines.join("\n")).not.toContain("kc_run_secretValue");
  });

  test("extracts authorization failure messages for local detach", () => {
    const event: EventEnvelope = {
      kind: "ephemeral",
      type: "authorization.failed",
      payload: { message: "capability has expired" },
      atMs: 1_000,
    };

    expect(formatTuiWatchEvent(event)).toEqual({
      lines: ['[live] authorization.failed {"message":"capability has expired"}'],
      authorizationFailedMessage: "watch authorization failed: capability has expired",
    });
  });
});
