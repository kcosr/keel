import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../rpc/contract.ts";
import { createTuiWatchFormatter, formatTuiWatchEvent } from "./events.ts";

function live(type: string, payload: unknown = {}): EventEnvelope {
  return { kind: "ephemeral", type, payload, atMs: 1 };
}

function durable(seq: number, type: string, payload: unknown = {}): EventEnvelope {
  return { kind: "durable", seq, type, payload, atMs: seq };
}

function agentText(data: string): EventEnvelope {
  return live("agent.event", { key: "review", event: { type: "text", data } });
}

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

  test("coalesces same-agent text deltas as display row continuations", () => {
    const formatter = createTuiWatchFormatter();

    expect(formatter.push(agentText("Hel"))).toEqual({
      lines: ["[live] agent review text: Hel"],
      authorizationFailedMessage: undefined,
    });
    expect(formatter.push(agentText("lo"))).toEqual({
      appendToLastLine: "lo",
      lines: [],
      authorizationFailedMessage: undefined,
    });
  });

  test("terminates active display streams before non-stream events", () => {
    const formatter = createTuiWatchFormatter();

    formatter.push(agentText("partial"));

    expect(formatter.push(durable(2, "phase", { title: "Build" }))).toEqual({
      lines: ["[2] phase: Build"],
      authorizationFailedMessage: undefined,
    });
    expect(formatter.push(agentText("next"))).toEqual({
      lines: ["[live] agent review text: next"],
      authorizationFailedMessage: undefined,
    });
  });
});
