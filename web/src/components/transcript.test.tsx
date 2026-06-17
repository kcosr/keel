import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { EventStreamFrame } from "../api/types";
import { Transcript, coalesceTranscript } from "./transcript";

describe("Transcript", () => {
  test("coalesces adjacent live agent text deltas", () => {
    const events: EventStreamFrame[] = [
      live("agent.event", { key: "review", event: { type: "text", data: "The" } }),
      live("agent.event", { key: "review", event: { type: "text", data: " answer" } }),
      durable(3, "phase", { title: "Checking" }),
      live("agent.event", { key: "review", event: { type: "reasoning", data: "Thinking" } }),
    ];

    const rows = coalesceTranscript(events);

    expect(rows.map((row) => [row.actor, row.event, row.message])).toEqual([
      ["review", "text", "The answer"],
      ["system", "phase", "Checking"],
      ["review", "reasoning", "Thinking"],
    ]);
  });

  test("renders coalesced transcript rows", () => {
    render(
      <Transcript
        events={[
          live("agent.event", { key: "draft", event: { type: "text", data: "Hello" } }),
          live("agent.event", { key: "draft", event: { type: "text", data: " world" } }),
        ]}
      />,
    );

    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(screen.getAllByText("text")).toHaveLength(1);
  });
});

function live(type: string, payload: unknown): EventStreamFrame {
  return { kind: "ephemeral", type, payload, atMs: 1 };
}

function durable(seq: number, type: string, payload: unknown): EventStreamFrame {
  return { kind: "durable", seq, type, payload, atMs: seq };
}
