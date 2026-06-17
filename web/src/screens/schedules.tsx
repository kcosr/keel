import { useEffect, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { ScheduleSummary } from "../api/types";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  StatusPill,
  formatTime,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

export function SchedulesScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const state = useAsync(() => client.listSchedules(), [client, refreshKey]);
  const schedules = state.data ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  useEffect(() => {
    if (selectedName && schedules.some((schedule) => schedule.name === selectedName)) return;
    setSelectedName(schedules[0]?.name ?? null);
  }, [schedules, selectedName]);
  const selected = schedules.find((schedule) => schedule.name === selectedName) ?? null;

  return (
    <div className="content-split">
      <div className="content-scroll">
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
      </div>
      <Inspector title="Schedule" subtitle={selected?.name ?? "No schedule"}>
        {selected ? (
          <dl className="kv-list">
            <div className="kv-row">
              <dt>Workflow</dt>
              <dd>{selected.workflowName ?? selected.workflowRef}</dd>
            </div>
            <div className="kv-row">
              <dt>Target</dt>
              <dd className="mono">{selected.target ?? "-"}</dd>
            </div>
            <div className="kv-row">
              <dt>Interval</dt>
              <dd>{Math.round(selected.intervalMs / 1000)}s</dd>
            </div>
            <div className="kv-row">
              <dt>Next fire</dt>
              <dd>{formatTime(selected.nextFireMs)}</dd>
            </div>
            <div className="kv-row">
              <dt>Last error</dt>
              <dd>{selected.lastError.kind}</dd>
            </div>
          </dl>
        ) : (
          <EmptyState title="No schedule selected" />
        )}
      </Inspector>
    </div>
  );
}

function scheduleColumns(): Array<Column<ScheduleSummary>> {
  return [
    { key: "name", header: "Name", render: (schedule) => <strong>{schedule.name}</strong> },
    {
      key: "enabled",
      header: "State",
      width: "110px",
      render: (schedule) => (
        <StatusPill tone={schedule.enabled ? "success" : "neutral"}>
          {schedule.enabled ? "enabled" : "disabled"}
        </StatusPill>
      ),
    },
    {
      key: "workflow",
      header: "Workflow",
      render: (schedule) => schedule.workflowName ?? schedule.workflowRef,
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
      key: "next",
      header: "Next fire",
      width: "190px",
      render: (schedule) => formatTime(schedule.nextFireMs),
    },
    {
      key: "last",
      header: "Last run",
      width: "150px",
      render: (schedule) =>
        schedule.lastRunId ? (
          <span className="mono">{schedule.lastRunId}</span>
        ) : (
          <span className="muted">-</span>
        ),
    },
  ];
}
