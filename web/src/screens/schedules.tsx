import { useEffect, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { ScheduleErrorProjection, ScheduleSummary, ScheduleView } from "../api/types";
import { CodeViewer } from "../components/code-viewer";
import {
  EmptyState,
  ErrorState,
  JsonBlock,
  KeyValueList,
  LoadingState,
  StatusPill,
  Tabs,
  formatTime,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

type ScheduleTab = "detail" | "source";

export function SchedulesScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const state = useAsync(() => client.listSchedules(), [client, refreshKey]);
  const schedules = state.data ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ScheduleTab>("detail");

  useEffect(() => {
    if (selectedName && schedules.some((schedule) => schedule.name === selectedName)) return;
    setSelectedName(schedules[0]?.name ?? null);
  }, [schedules, selectedName]);

  const selectedSummary = schedules.find((schedule) => schedule.name === selectedName) ?? null;
  const detailState = useAsync(
    () => (selectedName ? client.getSchedule(selectedName) : Promise.resolve(null)),
    [client, selectedName, refreshKey],
  );
  const detail = detailState.data ?? null;
  const selected = detail ?? selectedSummary;

  return (
    <div className="content-split">
      <div className="content-scroll schedule-screen">
        <div className="notice-panel">
          Schedules are read-only in the web UI. Schedule management APIs are not exposed here.
        </div>
        {state.loading ? <LoadingState label="Loading schedules" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error ? (
          <DenseTable
            rows={schedules}
            rowKey={(schedule) => schedule.name}
            selectedKey={selectedName}
            onRowClick={(schedule) => setSelectedName(schedule.name)}
            empty={
              <EmptyState title="No schedules" detail="Schedule reads require admin authority." />
            }
            columns={scheduleColumns()}
          />
        ) : null}

        {selected ? (
          <section className="panel schedule-detail-panel">
            <div className="panel-heading">
              <div>
                <h2>{selected.name}</h2>
                <div className="muted">{selected.workflowName ?? selected.workflowRef}</div>
              </div>
              <StatusPill tone={scheduleTone(selected)}>{scheduleStateLabel(selected)}</StatusPill>
            </div>
            <Tabs<ScheduleTab>
              tabs={[
                { id: "detail", label: "Detail" },
                { id: "source", label: "Source", count: detail?.source?.files.length },
              ]}
              active={activeTab}
              onChange={setActiveTab}
            />
            <div className="tab-panel">
              {detailState.loading ? <LoadingState label="Loading schedule detail" /> : null}
              {detailState.error ? (
                <ErrorState error={detailState.error} onRetry={detailState.reload} />
              ) : null}
              {!detailState.loading && !detailState.error && activeTab === "detail" ? (
                <ScheduleDetail schedule={detail ?? selectedSummary} />
              ) : null}
              {!detailState.loading && !detailState.error && activeTab === "source" ? (
                <CodeViewer
                  source={detail?.source ?? null}
                  emptyDetail="This schedule references a missing workflow definition or source was not returned."
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
      <ScheduleInspector
        schedule={selected}
        loading={detailState.loading}
        error={detailState.error}
      />
    </div>
  );
}

function scheduleColumns(): Array<Column<ScheduleSummary>> {
  return [
    { key: "name", header: "Name", render: (schedule) => <strong>{schedule.name}</strong> },
    {
      key: "enabled",
      header: "State",
      width: "120px",
      render: (schedule) => (
        <StatusPill tone={scheduleTone(schedule)}>{scheduleStateLabel(schedule)}</StatusPill>
      ),
    },
    {
      key: "workflow",
      header: "Workflow",
      render: (schedule) => (
        <div className="cell-stack">
          <strong>{schedule.workflowName ?? schedule.workflowRef}</strong>
          <span>{schedule.workflowKind ?? "unknown"}</span>
        </div>
      ),
    },
    {
      key: "definition",
      header: "Definition",
      width: "120px",
      render: (schedule) => (
        <StatusPill tone={toneForStatus(schedule.definitionState)}>
          {schedule.definitionState}
        </StatusPill>
      ),
    },
    {
      key: "interval",
      header: "Interval",
      width: "110px",
      render: (schedule) => formatInterval(schedule.intervalMs),
    },
    {
      key: "next",
      header: "Next fire",
      width: "190px",
      render: (schedule) => formatTime(schedule.nextFireMs),
    },
    {
      key: "last",
      header: "Last run",
      width: "170px",
      render: (schedule) =>
        schedule.lastRunId ? (
          <div className="cell-stack">
            <a
              className="inline-link mono"
              href={`#/runs/${encodeURIComponent(schedule.lastRunId)}`}
            >
              {schedule.lastRunId}
            </a>
            <span>{schedule.lastRunStatus ?? "-"}</span>
          </div>
        ) : (
          <span className="muted">-</span>
        ),
    },
  ];
}

function ScheduleDetail({ schedule }: { schedule: ScheduleView | ScheduleSummary | null }) {
  if (!schedule) return <EmptyState title="No schedule selected" />;
  const view = "input" in schedule ? schedule : null;
  return (
    <div className="overview-grid">
      <section className="panel">
        <h2>Timing</h2>
        <KeyValueList
          rows={[
            { label: "Interval", value: formatInterval(schedule.intervalMs) },
            { label: "Next fire", value: formatTime(schedule.nextFireMs) },
            { label: "Last failed", value: formatTime(schedule.lastFailedAtMs) },
          ]}
        />
      </section>
      <section className="panel">
        <h2>Workflow</h2>
        <KeyValueList
          rows={[
            { label: "Reference", value: schedule.workflowRef, mono: true },
            { label: "Name", value: schedule.workflowName ?? "-" },
            { label: "Kind", value: schedule.workflowKind ?? "-" },
            { label: "Definition", value: schedule.definitionState },
            { label: "Target", value: schedule.target ?? "-", mono: true },
          ]}
        />
      </section>
      <section className="panel">
        <h2>Last Run</h2>
        <KeyValueList
          rows={[
            {
              label: "Run",
              value: schedule.lastRunId ? (
                <a
                  className="inline-link mono"
                  href={`#/runs/${encodeURIComponent(schedule.lastRunId)}`}
                >
                  {schedule.lastRunId}
                </a>
              ) : (
                "-"
              ),
            },
            { label: "Status", value: schedule.lastRunStatus ?? "-" },
            { label: "Error", value: scheduleErrorText(schedule.lastError) },
          ]}
        />
      </section>
      <section className="panel">
        <h2>Input</h2>
        {view ? <JsonBlock value={view.input} /> : <LoadingState label="Loading input" />}
      </section>
    </div>
  );
}

function ScheduleInspector({
  schedule,
  loading,
  error,
}: {
  schedule: ScheduleView | ScheduleSummary | null;
  loading: boolean;
  error: Error | null;
}) {
  return (
    <Inspector
      title="Schedule"
      subtitle={schedule?.name ?? "No schedule"}
      status={
        schedule ? (
          <StatusPill tone={scheduleTone(schedule)}>{scheduleStateLabel(schedule)}</StatusPill>
        ) : null
      }
    >
      {loading ? <LoadingState label="Loading schedule" /> : null}
      {error ? <ErrorState error={error} /> : null}
      {!loading && !error && schedule ? (
        <>
          <KeyValueList
            rows={[
              { label: "Enabled", value: String(schedule.enabled) },
              { label: "Workflow", value: schedule.workflowName ?? schedule.workflowRef },
              { label: "Next fire", value: formatTime(schedule.nextFireMs) },
              { label: "Last run", value: schedule.lastRunId ?? "-", mono: true },
              { label: "Last error", value: scheduleErrorText(schedule.lastError) },
            ]}
          />
          <JsonBlock value={schedule} />
        </>
      ) : null}
      {!loading && !error && !schedule ? <EmptyState title="No schedule selected" /> : null}
    </Inspector>
  );
}

function scheduleTone(schedule: ScheduleSummary): "success" | "waiting" | "failed" | "neutral" {
  if (!schedule.enabled) return "neutral";
  if (schedule.definitionState === "missing" || schedule.lastError.kind !== "none") return "failed";
  return "success";
}

function scheduleStateLabel(schedule: ScheduleSummary): string {
  if (!schedule.enabled) return "disabled";
  if (schedule.lastError.kind !== "none") return schedule.lastError.kind;
  return "enabled";
}

function scheduleErrorText(error: ScheduleErrorProjection): string {
  if (error.kind === "none") return "-";
  if (error.kind === "parse-error") return error.message;
  return error.error.name ? `${error.error.name}: ${error.error.message}` : error.error.message;
}

function formatInterval(intervalMs: number): string {
  const seconds = Math.round(intervalMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
