import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelWebClient } from "../api/client";
import type { ScheduleSummary, ScheduleView } from "../api/types";
import { SchedulesScreen } from "./schedules";

afterEach(() => {
  cleanup();
});

describe("SchedulesScreen", () => {
  test("renders a neutral empty state when no schedules are registered", async () => {
    const client = {
      listSchedules: vi.fn(async () => []),
      getSchedule: vi.fn(),
    } as unknown as KeelWebClient;

    render(<SchedulesScreen client={client} refreshKey={0} />);

    await screen.findByText("No schedules");
    expect(
      screen.getByText("No saved schedules are currently registered with the daemon."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/admin authority/i)).not.toBeInTheDocument();
    expect(client.getSchedule).not.toHaveBeenCalled();
  });

  test("lists schedules and loads read-only detail/source through getSchedule", async () => {
    const client = {
      listSchedules: vi.fn(async () => [scheduleSummary()]),
      getSchedule: vi.fn(async () => scheduleDetail()),
    } as unknown as KeelWebClient;

    render(<SchedulesScreen client={client} refreshKey={0} />);

    await screen.findByText("hourly");
    await waitFor(() => expect(client.getSchedule).toHaveBeenCalledWith("hourly"));
    expect(
      screen.getByText(
        "Schedules are read-only in the web UI. Schedule management APIs are not exposed here.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(document.body.textContent).toContain('"n": 1'));

    fireEvent.click(screen.getByRole("button", { name: /source/i }));
    await waitFor(() => expect(document.body.textContent).toContain("export default async"));
  });
});

function scheduleSummary(): ScheduleSummary {
  return {
    name: "hourly",
    enabled: true,
    workflowRef: "wf_sha256_hourly",
    definitionState: "available",
    workflowName: "hourly-workflow",
    workflowKind: "source",
    target: "/tmp/work",
    intervalMs: 3_600_000,
    nextFireMs: 2,
    lastRunId: "run_last",
    lastRunStatus: "finished",
    lastFailedAtMs: null,
    lastError: { kind: "none" },
  };
}

function scheduleDetail(): ScheduleView {
  return {
    ...scheduleSummary(),
    input: { n: 1 },
    inputJson: '{"n":1}',
    source: {
      kind: "workflow-definition-source",
      lookup: { kind: "definition", definitionHash: "wf_sha256_hourly" },
      definitionHash: "wf_sha256_hourly",
      definitionName: "hourly-workflow",
      createdAtMs: 1,
      entry: "entry.ts",
      files: [{ path: "entry.ts", code: "export default async () => 1;\n", entry: true }],
    },
  };
}
