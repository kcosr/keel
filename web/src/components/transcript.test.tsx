import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EventStreamFrame } from "../api/types";
import { resetWebDebugCacheForTest } from "../lib/debug";
import { Transcript, coalesceTranscript } from "./transcript";

describe("Transcript", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    resetWebDebugCacheForTest();
  });

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

  test("limits visible rows after coalescing stream deltas", () => {
    render(
      <Transcript
        compact
        maxRows={1}
        events={[
          durable(1, "phase", { title: "Earlier" }),
          live("agent.event", { key: "review", event: { type: "reasoning", data: "Alpha" } }),
          live("agent.event", { key: "review", event: { type: "reasoning", data: " beta" } }),
          live("agent.event", { key: "review", event: { type: "reasoning", data: " gamma" } }),
        ]}
      />,
    );

    expect(screen.queryByText("Earlier")).not.toBeInTheDocument();
    expect(screen.getByText("Alpha beta gamma")).toBeInTheDocument();
    expect(screen.getAllByText("reasoning")).toHaveLength(1);
  });

  test("renders no transcript rows when maxRows is zero", () => {
    render(<Transcript compact maxRows={0} events={[durable(1, "phase", { title: "Hidden" })]} />);

    expect(screen.getByText("No transcript events in the current tail.")).toBeInTheDocument();
    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("phase")).not.toBeInTheDocument();
    expect(screen.queryByText("Time")).not.toBeInTheDocument();
  });

  test("debug summaries omit raw transcript text", () => {
    const marker = "raw-transcript-debug-marker";
    localStorage.setItem("keelDebug", "transcript");
    resetWebDebugCacheForTest();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    render(
      <Transcript
        events={[
          live("agent.event", {
            key: "review",
            event: { type: "reasoning", data: marker },
          }),
        ]}
      />,
    );

    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).not.toContain(marker);
    expect(logged).toContain(`"messageLength":${marker.length}`);
  });

  test("coalesces one shared event array once across multiple transcript views", () => {
    const events = [
      live("agent.event", { key: "review", event: { type: "text", data: "Hello" } }),
      live("agent.event", { key: "review", event: { type: "text", data: " world" } }),
    ];
    localStorage.setItem("keelDebug", "transcript");
    resetWebDebugCacheForTest();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    render(
      <>
        <Transcript compact maxRows={1} events={events} />
        <Transcript compact maxRows={1} events={events} />
        <Transcript events={events} />
      </>,
    );

    expect(
      debug.mock.calls.filter((call) => call[0] === "[keel web:transcript] coalesced"),
    ).toHaveLength(1);
    expect(screen.getAllByText("Hello world")).toHaveLength(3);
  });
});

function live(type: string, payload: unknown): EventStreamFrame {
  return { kind: "ephemeral", type, payload, atMs: 1 };
}

function durable(seq: number, type: string, payload: unknown): EventStreamFrame {
  return { kind: "durable", seq, type, payload, atMs: seq };
}
