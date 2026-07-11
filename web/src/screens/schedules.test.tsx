import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelWebClient } from "../api/client";
import type { SavedWorkflowSummary, ScheduleSummary, ScheduleView } from "../api/types";
import { SchedulesScreen } from "./schedules";

afterEach(() => {
  cleanup();
});

describe("SchedulesScreen", () => {
  test("renders a neutral empty state when no schedules are registered", async () => {
    const client = {
      listSchedules: vi.fn(async () => []),
      listSavedWorkflows: vi.fn(async () => []),
      getSchedule: vi.fn(),
    } as unknown as KeelWebClient;

    render(<SchedulesScreen client={client} refreshKey={0} />);

    await screen.findByText("No schedules");
    expect(
      screen.getByText("Create a schedule to run a saved workflow at a fixed interval."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/admin authority/i)).not.toBeInTheDocument();
    expect(client.getSchedule).not.toHaveBeenCalled();
  });

  test("lists schedules and exposes management and source views", async () => {
    const setScheduleEnabled = vi.fn(async () => ({ name: "hourly", enabled: false }));
    const client = {
      listSchedules: vi.fn(async () => [scheduleSummary()]),
      listSavedWorkflows: vi.fn(async () => [workflowSummary()]),
      getSchedule: vi.fn(async () => scheduleDetail()),
      setScheduleEnabled,
    } as unknown as KeelWebClient;

    render(<SchedulesScreen client={client} refreshKey={0} />);

    await screen.findByText("hourly");
    await waitFor(() => expect(client.getSchedule).toHaveBeenCalledWith("hourly"));
    await waitFor(() => expect(document.body.textContent).toContain('"n": 1'));
    fireEvent.click(screen.getByRole("tab", { name: /configure/i }));
    expect(await screen.findByRole("button", { name: /save and enable/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /pause/i }));
    await waitFor(() => expect(setScheduleEnabled).toHaveBeenCalledWith("hourly", false));

    fireEvent.click(screen.getByRole("tab", { name: /source/i }));
    await waitFor(() => expect(document.body.textContent).toContain("export default async"));
  });

  test("creates a schedule for a saved workflow", async () => {
    const putSchedule = vi.fn(async () => ({ ok: true }));
    const client = {
      listSchedules: vi.fn(async () => []),
      listSavedWorkflows: vi.fn(async () => [workflowSummary()]),
      getSchedule: vi.fn(async () => null),
      browseDirectories: vi.fn(async (path: string) =>
        path === "~"
          ? {
              path: "/srv",
              parentPath: "/",
              entries: [{ name: "work", path: "/srv/work" }],
              truncated: false,
            }
          : { path, parentPath: "/srv", entries: [], truncated: false },
      ),
      putSchedule,
    } as unknown as KeelWebClient;

    render(<SchedulesScreen client={client} refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: /new schedule/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "daily" } });
    fireEvent.change(screen.getByLabelText("Interval seconds"), { target: { value: "86400" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse target" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open work" }));
    await waitFor(() => expect(screen.getByText("/srv/work")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("button", { name: /create schedule/i }));

    await waitFor(() =>
      expect(putSchedule).toHaveBeenCalledWith({
        name: "daily",
        workflowName: "hourly-workflow",
        intervalMs: 86_400_000,
        input: {},
        target: "/srv/work",
      }),
    );
  });

  test("requires an explicit workflow choice when a pinned definition has no catalog match", async () => {
    const orphaned = { ...scheduleDetail(), workflowName: "materialized-only" };
    const client = {
      listSchedules: vi.fn(async () => [orphaned]),
      listSavedWorkflows: vi.fn(async () => [workflowSummary()]),
      getSchedule: vi.fn(async () => orphaned),
    } as unknown as KeelWebClient;

    render(<SchedulesScreen client={client} refreshKey={0} />);
    fireEvent.click(await screen.findByRole("tab", { name: /configure/i }));

    expect(await screen.findByLabelText("Saved workflow")).toHaveValue("");
    expect(screen.getByRole("button", { name: /save and enable/i })).toBeDisabled();
  });

  test("pins an explicitly selected workflow version", async () => {
    const putSchedule = vi.fn(async () => ({ ok: true }));
    const workflow = workflowSummary();
    workflow.versions = [workflowVersion(2), workflowVersion(1)];
    const client = {
      listSchedules: vi.fn(async () => []),
      listSavedWorkflows: vi.fn(async () => [workflow]),
      getSchedule: vi.fn(async () => null),
      putSchedule,
    } as unknown as KeelWebClient;

    render(<SchedulesScreen client={client} refreshKey={0} />);
    fireEvent.click(await screen.findByRole("button", { name: /new schedule/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "pinned" } });
    fireEvent.change(screen.getByLabelText("Workflow version"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "/tmp/work" } });
    fireEvent.submit(
      screen.getByRole("button", { name: /create schedule/i }).closest("form") as HTMLFormElement,
    );

    await waitFor(() =>
      expect(putSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "pinned",
          workflowName: "hourly-workflow",
          workflowVersion: 1,
        }),
      ),
    );
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

function workflowSummary(): SavedWorkflowSummary {
  return {
    name: "hourly-workflow",
    title: "Hourly workflow",
    description: null,
    tags: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    disabledAtMs: null,
    deletedAtMs: null,
    latestVersion: 1,
    latestDefinitionHash: "wf_sha256_hourly",
    versions: [],
  };
}

function workflowVersion(version: number): SavedWorkflowSummary["versions"][number] {
  return {
    name: "hourly-workflow",
    version,
    definitionHash: `wf_sha256_hourly_${version}`,
    workflowName: "hourly",
    inputSchema: null,
    inputSchemaSet: false,
    defaultInput: null,
    defaultInputSet: false,
    defaultTarget: "/tmp/work",
    metadata: null,
    sourceProvenance: null,
    createdBy: null,
    createdAtMs: version,
    enabled: true,
    deprecatedAtMs: null,
    deprecationMessage: null,
    deletedAtMs: null,
  };
}
