import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "../rpc/contract.ts";
import {
  createTextWatchFormatter,
  formatNdjsonWatchEvent,
  formatWatchEvent,
} from "./watch-format.ts";

function durable(seq: number, type: string, payload: unknown = {}): EventEnvelope {
  return { kind: "durable", seq, type, payload, atMs: seq };
}

function live(type: string, payload: unknown = {}): EventEnvelope {
  return { kind: "ephemeral", type, payload, atMs: 1 };
}

function agentEvent(
  key: string,
  type: string,
  data: unknown,
  kind: "ephemeral" | "durable" = "ephemeral",
  seq = 1,
): EventEnvelope {
  const payload = { key, event: { type, data } };
  return kind === "durable" ? durable(seq, "agent.event", payload) : live("agent.event", payload);
}

function render(events: EventEnvelope[], opts?: { tools?: boolean }): string {
  const formatter = createTextWatchFormatter(opts);
  return [...events.flatMap((event) => formatter.push(event)), ...formatter.flush()].join("");
}

describe("watch text formatter", () => {
  test("coalesces adjacent text deltas with one prefix", () => {
    const text = render([
      agentEvent("review", "text", "The"),
      agentEvent("review", "text", " answer"),
      agentEvent("review", "text", " is 42"),
    ]);

    expect(text).toBe("[live] agent review text: The answer is 42\n");
    expect(text.match(/\[live\]/g)?.length).toBe(1);
  });

  test("flushes when reasoning and text channels change", () => {
    expect(
      render([
        agentEvent("review", "reasoning", "Thinking"),
        agentEvent("review", "text", "Answer"),
      ]),
    ).toBe("[live] agent review reasoning: Thinking\n[live] agent review text: Answer\n");
  });

  test("flushes and re-headers when the agent key changes", () => {
    expect(render([agentEvent("review", "text", "A"), agentEvent("draft", "text", "B")])).toBe(
      "[live] agent review text: A\n[live] agent draft text: B\n",
    );
  });

  test("ignores chunks that are empty after sanitization without opening or flushing", () => {
    expect(render([agentEvent("review", "text", "\r\u001b[31m\u001b[0m")])).toBe("");
    expect(
      render([
        agentEvent("review", "text", "Hello"),
        agentEvent("other", "reasoning", "\r\u001b[31m\u001b[0m"),
        agentEvent("review", "text", " world"),
      ]),
    ).toBe("[live] agent review text: Hello world\n");
  });

  test("flushes active streams before non-stream events", () => {
    expect(
      render([agentEvent("review", "text", "Hi"), durable(2, "phase", { title: "Build" })]),
    ).toBe("[live] agent review text: Hi\n[2] phase: Build\n");
  });

  test("uses durable sequence prefixes and preserves inline newlines for durable text rows", () => {
    expect(
      render([
        agentEvent("review", "text", "A\n", "durable", 123),
        agentEvent("review", "text", "B", "durable", 124),
      ]),
    ).toBe("[123] agent review text: A\nB\n");
  });

  test("prints durable final messages after flushing live streams", () => {
    expect(
      render([
        agentEvent("review", "text", "Hello"),
        durable(3, "agent.message", { key: "review", text: "Hello" }),
      ]),
    ).toBe("[live] agent review text: Hello\n[3] agent review message: Hello\n");
  });

  test("renders command started and completed events", () => {
    expect(
      render([
        durable(4, "command.started", { key: "verify", cwd: "." }),
        durable(5, "command.completed", {
          key: "verify",
          status: "exited",
          exitCode: 0,
          signal: null,
          durationMs: 1800,
          stdout: { byteLength: 42 },
          stderr: { byteLength: 0 },
        }),
        durable(6, "command.completed", {
          key: "verify",
          status: "exited",
          exitCode: 1,
          signal: null,
          durationMs: 12_400,
          failureKind: "nonzero-exit",
          stdout: { byteLength: 0 },
          stderr: { byteLength: 8192 },
        }),
      ]),
    ).toBe(
      "[4] command verify started cwd=.\n[5] command verify exited exit=0 1.8s stdout=42B stderr=0B\n[6] command verify nonzero-exit exit=1 12.4s stdout=0B stderr=8KB\n",
    );
  });

  test("does not coalesce non-string text or reasoning payloads", () => {
    expect(
      render([agentEvent("review", "text", "A"), agentEvent("review", "text", { bad: true })]),
    ).toBe('[live] agent review text: A\n[live] agent review text: {"bad":true}\n');
  });

  test("hides tool traces by default without breaking the visible text stream", () => {
    expect(
      render([
        agentEvent("review", "text", "A"),
        agentEvent("review", "tool_call", { name: "Read" }),
        durable(4, "agent.tool_result", { key: "review", data: { output: "ok" } }),
        agentEvent("review", "text", "B"),
      ]),
    ).toBe("[live] agent review text: AB\n");
  });

  test("shows tool traces with --tools after flushing active streams", () => {
    expect(
      render(
        [
          agentEvent("review", "text", "A"),
          agentEvent("review", "tool_call", { name: "Read" }),
          durable(4, "agent.tool_result", { key: "review", data: { output: "ok" } }),
        ],
        { tools: true },
      ),
    ).toBe(
      '[live] agent review text: A\n[live] agent review tool_call: {"name":"Read"}\n[4] agent review tool_result: {"output":"ok"}\n',
    );
  });

  test("keeps unexpected and missing agent event payloads visible", () => {
    expect(
      formatWatchEvent(durable(236, "agent.event", { provider: "future", detail: "new shape" })),
    ).toBe('[236] agent: {"provider":"future","detail":"new shape"}\n');
    expect(
      formatWatchEvent({
        kind: "durable",
        seq: 237,
        type: "agent.event",
        payload: undefined,
        atMs: 237,
      }),
    ).toBe("[237] agent: undefined\n");
  });

  test("flushes partial streams before terminal and authorization events", () => {
    expect(render([agentEvent("review", "text", "partial"), durable(10, "run.finished")])).toBe(
      "[live] agent review text: partial\n[10] run.finished\n",
    );
    expect(render([agentEvent("review", "text", "partial"), live("run.continued")])).toBe(
      "[live] agent review text: partial\n[live] run.continued\n",
    );
    expect(
      render([
        agentEvent("review", "text", "partial"),
        live("authorization.failed", { message: "no" }),
      ]),
    ).toBe('[live] agent review text: partial\n[live] authorization.failed {"message":"no"}\n');
  });

  test("strips inline terminal controls while preserving newlines and tabs", () => {
    expect(
      render([agentEvent("review", "text", "A\u001b[31mB\u001b[0m\rC\u0000D\u0085E\nF\tG")]),
    ).toBe("[live] agent review text: ABCDE\nF\tG\n");
  });

  test("redacts capability tokens before inline sanitization", () => {
    const text = render([agentEvent("review", "text", "token kc_run_secretValue\r")]);
    expect(text).toBe("[live] agent review text: token «redacted-capability»\n");
    expect(text).not.toContain("kc_run_secretValue");
  });
});

describe("watch event one-shot helpers", () => {
  test("renders one event in text mode with stream flushing", () => {
    expect(formatWatchEvent(agentEvent("run-date", "text", "RESULT 50\n", "durable", 234))).toBe(
      "[234] agent run-date text: RESULT 50\n",
    );
  });

  test("supports NDJSON event lines without coalescing", () => {
    const event = agentEvent("run-date", "tool_call", { command: "date" }, "durable", 235);
    expect(formatNdjsonWatchEvent(event)).toBe(`${JSON.stringify(event)}\n`);
    expect(formatWatchEvent(event, { output: "ndjson" })).toBe(`${JSON.stringify(event)}\n`);
  });

  test("redacts capability-looking strings in text and NDJSON output", () => {
    const event = durable(238, "log", {
      message: "cap kc_run_secretValue and kc_admin_secretValue",
    });
    expect(formatWatchEvent(event)).toContain("«redacted-capability»");
    expect(formatWatchEvent(event, { output: "ndjson" })).not.toContain("kc_run_secretValue");
    expect(formatWatchEvent(event, { output: "ndjson" })).not.toContain("kc_admin_secretValue");
  });

  test("renders run.interrupted as a parked lifecycle event", () => {
    const event = durable(239, "run.interrupted", {
      previousStatus: "running",
      reason: "inspect kc_run_secretValue",
    });
    expect(formatWatchEvent(event)).toBe("[239] run.interrupted: inspect «redacted-capability»\n");
    expect(formatWatchEvent(event, { output: "ndjson" })).not.toContain("kc_run_secretValue");
  });
});
