import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelWebClient, WatchRunEventsOptions } from "../api/client";
import type { EventStreamFrame, RunDetailResponse } from "../api/types";
import type { RawEventFrame } from "../components/transcript";
import { RunDetailScreen, mergeEventFrames, mergeRawFrames } from "./run-detail";

describe("RunDetailScreen", () => {
  afterEach(cleanup);

  test("deduplicates replayed durable events and keeps durable rows ordered", () => {
    const merged = mergeEventFrames(
      [durable(3, "phase"), durable(5, "agent.message")],
      [durable(1, "run.started"), durable(3, "phase.replayed"), durable(6, "run.finished")],
    );

    expect(
      merged.map((event) => (event.kind === "durable" ? `${event.seq}:${event.type}` : event.type)),
    ).toEqual(["1:run.started", "3:phase.replayed", "5:agent.message", "6:run.finished"]);
  });

  test("keeps live ephemeral chunks in stream position when merging around durables", () => {
    const merged = mergeEventFrames(
      [durable(5, "phase")],
      [ephemeral("agent.event"), durable(6, "agent.message")],
    );

    expect(
      merged.map((event) => (event.kind === "durable" ? `${event.seq}:${event.type}` : event.type)),
    ).toEqual(["5:phase", "agent.event", "6:agent.message"]);
  });

  test("deduplicates replayed raw durable rows and keeps raw rows ordered", () => {
    const merged = mergeRawFrames(
      [raw(durable(3, "phase"), "tail"), raw(durable(5, "agent.message"), "tail")],
      [raw(durable(3, "phase.replayed"), "live"), raw(durable(6, "run.finished"), "live")],
    );

    expect(merged.map(rawSummary)).toEqual([
      "3:phase.replayed:live",
      "5:agent.message:tail",
      "6:run.finished:live",
    ]);
  });

  test("keeps live ephemeral raw rows in stream position when merging around durables", () => {
    const merged = mergeRawFrames(
      [raw(durable(5, "phase"), "tail")],
      [raw(ephemeral("agent.event"), "live"), raw(durable(6, "agent.message"), "live")],
    );

    expect(merged.map(rawSummary)).toEqual([
      "5:phase:tail",
      "agent.event:live",
      "6:agent.message:live",
    ]);
  });

  test("starts live watch from the detail cursor and renders coalesced live text", async () => {
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: async () => detail(),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        opts.onFrame({
          event: "event",
          data: {
            kind: "ephemeral",
            type: "agent.event",
            payload: { key: "review", event: { type: "text", data: "Hello" } },
            atMs: 10,
          },
          raw: "event: event",
        });
        opts.onFrame({
          event: "event",
          data: {
            kind: "ephemeral",
            type: "agent.event",
            payload: { key: "review", event: { type: "text", data: " live" } },
            atMs: 11,
          },
          raw: "event: event",
        });
        opts.onStatus?.({ state: "caught-up", cursor: { kind: "after-seq", seq: 5 } });
        return vi.fn();
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "Watch live" }));
    const transcriptTab = screen.getAllByRole("button", { name: /transcript/i })[0];
    expect(transcriptTab).toBeDefined();
    fireEvent.click(transcriptTab as HTMLElement);

    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));
    expect(watched[0]?.cursor).toEqual({ kind: "after-seq", seq: 5 });
    expect((await screen.findAllByText("Hello live")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("caught up").length).toBeGreaterThan(0);
  });

  test("uses the latest loaded detail cursor after manual refresh", async () => {
    let seq = 5;
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: vi.fn(async () => detail(seq)),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        return vi.fn();
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    await screen.findByText("cursor 5");
    seq = 9;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("cursor 9");

    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));

    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));
    expect(watched[0]?.cursor).toEqual({ kind: "after-seq", seq: 9 });
  });
});

function detail(seq = 5): RunDetailResponse {
  return {
    run: {
      runId: "run_1",
      workflowName: "wf",
      status: "running",
      definitionVersion: "wf_sha",
      runTarget: "target",
      parentRunId: null,
      createdAtMs: 1,
      finishedAtMs: null,
      nodes: [
        {
          stableKey: "step_a",
          effectType: "pure",
          status: "completed",
          attempt: 1,
          startedAtMs: 1,
          dependsOn: [],
          artifactBacked: false,
        },
        {
          stableKey: "step_b",
          effectType: "effectful",
          status: "pending",
          attempt: 1,
          startedAtMs: 2,
          dependsOn: ["step_a"],
          artifactBacked: false,
        },
      ],
      phase: "Running",
      error: null,
      stats: { steps: 1, agents: 1, artifacts: 0 },
    },
    report: null,
    blockage: null,
    workspaces: [],
    source: null,
    events: [],
    eventCursor: { kind: "after-seq", runId: "run_1", seq },
    rawEvents: { href: "/runs/run_1/events" },
    availableCommands: [{ name: "watchEvents", requiredAuthority: "run:events" }],
  };
}

function durable(seq: number, type: string): EventStreamFrame {
  return { kind: "durable", seq, type, payload: {}, atMs: seq };
}

function ephemeral(type: string): EventStreamFrame {
  return { kind: "ephemeral", type, payload: {}, atMs: 1 };
}

function raw(data: EventStreamFrame, source: RawEventFrame["source"]): RawEventFrame {
  return { event: "event", data, raw: JSON.stringify(data), source, receivedAtMs: 1 };
}

function rawSummary(frame: RawEventFrame): string {
  const data = frame.data as EventStreamFrame;
  return data.kind === "durable"
    ? `${data.seq}:${data.type}:${frame.source}`
    : `${data.type}:${frame.source}`;
}
