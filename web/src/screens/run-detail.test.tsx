import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { KeelWebClient, WatchRunEventsOptions } from "../api/client";
import type { RunDetailResponse } from "../api/types";
import { RunDetailScreen } from "./run-detail";

describe("RunDetailScreen", () => {
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
});

function detail(): RunDetailResponse {
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
    eventCursor: { kind: "after-seq", runId: "run_1", seq: 5 },
    rawEvents: { href: "/runs/run_1/events" },
    availableCommands: [{ name: "watchEvents", requiredAuthority: "run:events" }],
  };
}
