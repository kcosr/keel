import { Pause, Play, Plus, Save, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type {
  SavedWorkflowSummary,
  ScheduleErrorProjection,
  ScheduleSummary,
  ScheduleView,
} from "../api/types";
import { CodeViewer } from "../components/code-viewer";
import { ConfirmDialog } from "../components/confirm-dialog";
import {
  Button,
  EmptyState,
  ErrorState,
  JsonBlock,
  KeyValueList,
  LoadingState,
  Select,
  StatusPill,
  Tabs,
  TextInput,
  formatTime,
  statusLabel,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { DirectoryPickerField } from "../components/directory-picker";
import { useAsync } from "../hooks/use-async";

type ScheduleTab = "detail" | "configure" | "source";

export function SchedulesScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const [mutationKey, setMutationKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const state = useAsync(() => client.listSchedules(), [client, refreshKey, mutationKey]);
  const workflowsState = useAsync(
    () => client.listSavedWorkflows(),
    [client, refreshKey, mutationKey],
  );
  const schedules = state.data ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ScheduleTab>("detail");

  useEffect(() => {
    if (creating) return;
    if (selectedName && schedules.some((schedule) => schedule.name === selectedName)) return;
    setSelectedName(schedules[0]?.name ?? null);
  }, [creating, schedules, selectedName]);

  const selectedSummary = schedules.find((schedule) => schedule.name === selectedName) ?? null;
  const detailState = useAsync(
    () => (selectedName ? client.getSchedule(selectedName) : Promise.resolve(null)),
    [client, selectedName, refreshKey, mutationKey],
  );
  const detail = detailState.data ?? null;
  const selected = detail ?? selectedSummary;
  const mutated = (name?: string) => {
    setCreating(false);
    if (name) setSelectedName(name);
    setMutationKey((value) => value + 1);
  };

  return (
    <div className="content-scroll schedule-screen resource-screen">
      <div className="toolbar">
        <div className="toolbar-left">
          <StatusPill tone="success">
            {schedules.filter((schedule) => schedule.enabled).length} active
          </StatusPill>
          <StatusPill tone="neutral">
            {schedules.filter((schedule) => !schedule.enabled).length} paused
          </StatusPill>
        </div>
        <Button
          icon={Plus}
          variant="primary"
          onClick={() => {
            setCreating(true);
            setSelectedName(null);
          }}
        >
          New schedule
        </Button>
      </div>
      {state.loading ? <LoadingState label="Loading schedules" /> : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error ? (
        <DenseTable
          rows={schedules}
          rowKey={(schedule) => schedule.name}
          selectedKey={selectedName}
          onRowClick={(schedule) => {
            setCreating(false);
            setSelectedName(schedule.name);
            setActiveTab("detail");
          }}
          empty={
            <EmptyState
              title="No schedules"
              detail="Create a schedule to run a saved workflow at a fixed interval."
            />
          }
          columns={scheduleColumns()}
        />
      ) : null}

      {creating ? (
        <ScheduleEditor
          client={client}
          workflows={workflowsState.data ?? []}
          loadingWorkflows={workflowsState.loading}
          onCancel={() => setCreating(false)}
          onMutated={mutated}
        />
      ) : selected ? (
        <section className="resource-detail-panel">
          <div className="panel-heading">
            <div>
              <h2>{selected.name}</h2>
              <div className="muted">{selected.workflowName ?? selected.workflowRef}</div>
            </div>
            <StatusPill tone={scheduleTone(selected)}>{scheduleStateLabel(selected)}</StatusPill>
          </div>
          <Tabs<ScheduleTab>
            tabs={[
              { id: "detail", label: "Overview" },
              { id: "configure", label: "Configure" },
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
            {!detailState.loading && !detailState.error && activeTab === "configure" ? (
              <ScheduleEditor
                key={`${selected.name}:${mutationKey}`}
                client={client}
                schedule={detail ?? undefined}
                workflows={workflowsState.data ?? []}
                loadingWorkflows={workflowsState.loading}
                onMutated={mutated}
              />
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
  );
}

function ScheduleEditor({
  client,
  schedule,
  workflows,
  loadingWorkflows,
  onCancel,
  onMutated,
}: {
  client: KeelWebClient;
  schedule?: ScheduleView;
  workflows: SavedWorkflowSummary[];
  loadingWorkflows: boolean;
  onCancel?(): void;
  onMutated(name?: string): void;
}) {
  const inferredWorkflow =
    workflows.find((workflow) => workflow.name === schedule?.workflowName)?.name ?? "";
  const [name, setName] = useState(schedule?.name ?? "");
  const [workflowName, setWorkflowName] = useState(
    schedule ? inferredWorkflow : workflows[0]?.name || "",
  );
  const [workflowVersion, setWorkflowVersion] = useState<"latest" | string>("latest");
  const [intervalSeconds, setIntervalSeconds] = useState(
    String((schedule?.intervalMs ?? 3_600_000) / 1000),
  );
  const [target, setTarget] = useState(schedule?.target ?? "");
  const [inputText, setInputText] = useState(() => JSON.stringify(schedule?.input ?? {}, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const formId = useId();

  useEffect(() => {
    if (!schedule && !workflowName && workflows[0]) setWorkflowName(workflows[0].name);
  }, [schedule, workflowName, workflows]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const seconds = Number(intervalSeconds);
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new Error("Interval must be greater than zero seconds.");
      const input = JSON.parse(inputText);
      await client.putSchedule({
        name: name.trim(),
        workflowName,
        ...(workflowVersion === "latest" ? {} : { workflowVersion: Number(workflowVersion) }),
        intervalMs: seconds * 1000,
        input,
        target: target.trim() || undefined,
      });
      onMutated(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (!schedule) return;
    setBusy(true);
    setError(null);
    try {
      await client.setScheduleEnabled(schedule.name, !schedule.enabled);
      onMutated(schedule.name);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!schedule) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.deleteSchedule(schedule.name);
      if (!result.deleted) throw new Error(`Schedule ${schedule.name} no longer exists.`);
      setDeleteOpen(false);
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`panel resource-editor ${schedule ? "" : "resource-create-panel"}`}>
      <div className="panel-heading">
        <h2>{schedule ? "Schedule configuration" : "Create schedule"}</h2>
        {schedule ? (
          <StatusPill tone={scheduleTone(schedule)}>{scheduleStateLabel(schedule)}</StatusPill>
        ) : null}
      </div>
      {schedule && !inferredWorkflow ? (
        <div className="notice-panel">
          Select a saved workflow before saving. The current schedule references a materialized
          definition that is not mapped back to a catalog name.
        </div>
      ) : null}
      <form onSubmit={save} className="resource-form-grid">
        <label className="form-field" htmlFor={`${formId}-name`}>
          <span>Name</span>
          <TextInput
            id={`${formId}-name`}
            value={name}
            disabled={Boolean(schedule)}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="form-field" htmlFor={`${formId}-workflow`}>
          <span>Saved workflow</span>
          <Select
            id={`${formId}-workflow`}
            value={workflowName}
            required
            disabled={loadingWorkflows}
            onChange={(event) => {
              setWorkflowName(event.target.value);
              setWorkflowVersion("latest");
            }}
          >
            <option value="">Select workflow</option>
            {workflows.map((workflow) => (
              <option value={workflow.name} key={workflow.name}>
                {workflow.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="form-field" htmlFor={`${formId}-version`}>
          <span>Workflow version</span>
          <Select
            id={`${formId}-version`}
            value={workflowVersion}
            disabled={!workflowName}
            onChange={(event) => setWorkflowVersion(event.target.value)}
          >
            <option value="latest">Latest enabled</option>
            {workflowVersions(workflows, workflowName).map((version) => (
              <option value={String(version)} key={version}>
                Version {version}
              </option>
            ))}
          </Select>
        </label>
        <label className="form-field" htmlFor={`${formId}-interval`}>
          <span>Interval seconds</span>
          <TextInput
            id={`${formId}-interval`}
            type="number"
            min="1"
            step="1"
            value={intervalSeconds}
            required
            onChange={(event) => setIntervalSeconds(event.target.value)}
          />
        </label>
        <DirectoryPickerField
          client={client}
          id={`${formId}-target`}
          label="Target"
          value={target}
          onChange={setTarget}
          placeholder="Use workflow default"
        />
        <label className="form-field form-field-wide">
          <span>Input JSON</span>
          <textarea
            className="field-textarea resource-json-editor"
            value={inputText}
            spellCheck={false}
            onChange={(event) => setInputText(event.target.value)}
          />
        </label>
        {error ? (
          <div className="form-error form-field-wide" role="alert">
            {error.message}
          </div>
        ) : null}
        <div className="form-actions form-field-wide">
          <Button
            icon={Save}
            type="submit"
            variant="primary"
            disabled={busy || !name.trim() || !workflowName}
          >
            {schedule ? "Save and enable" : "Create schedule"}
          </Button>
          {onCancel ? (
            <Button disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {schedule ? (
            <Button
              icon={schedule.enabled ? Pause : Play}
              disabled={busy}
              onClick={() => void toggle()}
            >
              {schedule.enabled ? "Pause" : "Resume"}
            </Button>
          ) : null}
          {schedule ? (
            <Button
              icon={Trash2}
              variant="danger"
              disabled={busy}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </form>
      <ConfirmDialog
        open={deleteOpen}
        title="Delete schedule?"
        detail={`Delete ${schedule?.name ?? ""}. Existing runs are not affected.`}
        confirmLabel="Delete schedule"
        busy={busy}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void remove()}
      />
    </section>
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
          {statusLabel(schedule.definitionState)}
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
      render: (schedule) => (schedule.enabled ? formatTime(schedule.nextFireMs) : "-"),
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
            <span>{statusLabel(schedule.lastRunStatus)}</span>
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
            {
              label: "Next fire",
              value: schedule.enabled ? formatTime(schedule.nextFireMs) : "Paused",
            },
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
            { label: "Definition", value: statusLabel(schedule.definitionState) },
            { label: "Target", value: schedule.target ?? "-", mono: true },
          ]}
        />
      </section>
      <section className="panel">
        <h2>Last run</h2>
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
            {
              label: "Status",
              value: schedule.lastRunStatus ? statusLabel(schedule.lastRunStatus) : "-",
            },
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

function workflowVersions(workflows: SavedWorkflowSummary[], name: string): number[] {
  const workflow = workflows.find((candidate) => candidate.name === name);
  if (!workflow) return [];
  return workflow.versions
    .filter(
      (version) =>
        version.enabled && version.deprecatedAtMs === null && version.deletedAtMs === null,
    )
    .map((version) => version.version)
    .sort((a, b) => b - a);
}

function scheduleTone(schedule: ScheduleSummary): "success" | "waiting" | "failed" | "neutral" {
  if (!schedule.enabled) return "neutral";
  if (schedule.definitionState === "missing" || schedule.lastError.kind !== "none") return "failed";
  return "success";
}
function scheduleStateLabel(schedule: ScheduleSummary): string {
  if (!schedule.enabled) return "paused";
  if (schedule.lastError.kind !== "none") return statusLabel(schedule.lastError.kind);
  return "active";
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
