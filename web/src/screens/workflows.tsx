import { Rocket } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type {
  RunLaunchResult,
  SavedWorkflowSourceView,
  SavedWorkflowSummary,
  SavedWorkflowVersionView,
  SavedWorkflowView,
} from "../api/types";
import { CodeViewer } from "../components/code-viewer";
import {
  Button,
  EmptyState,
  ErrorState,
  JsonBlock,
  KeyValueList,
  LoadingState,
  StatusPill,
  Tabs,
  TextInput,
  formatTime,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

type WorkflowTab = "versions" | "source" | "launch";

export function WorkflowsScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const state = useAsync(() => client.listSavedWorkflows(), [client, refreshKey]);
  const workflows = state.data ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | "latest">("latest");
  const [activeTab, setActiveTab] = useState<WorkflowTab>("versions");

  useEffect(() => {
    if (selectedName && workflows.some((workflow) => workflow.name === selectedName)) return;
    setSelectedName(workflows[0]?.name ?? null);
    setSelectedVersion("latest");
  }, [workflows, selectedName]);

  const selectedSummary = workflows.find((workflow) => workflow.name === selectedName) ?? null;
  const detailState = useAsync(
    () => (selectedName ? client.getSavedWorkflow(selectedName) : Promise.resolve(null)),
    [client, selectedName, refreshKey],
  );
  const detail = detailState.data ?? null;
  const versions = detail?.versions ?? selectedSummary?.versions ?? [];
  const selectedVersionView = useMemo(
    () => resolveVersion(versions, selectedVersion),
    [versions, selectedVersion],
  );
  const sourceVersion = selectedVersionView?.version ?? selectedVersion;
  const sourceState = useAsync(
    () =>
      selectedName
        ? client.getSavedWorkflowSource({ name: selectedName, version: sourceVersion })
        : Promise.resolve(null),
    [client, selectedName, sourceVersion, refreshKey],
  );
  const source = sourceState.data ?? null;

  const selectWorkflow = (workflow: SavedWorkflowSummary) => {
    setSelectedName(workflow.name);
    setSelectedVersion("latest");
  };

  return (
    <div className="content-split">
      <div className="content-scroll workflow-screen">
        {state.loading ? <LoadingState label="Loading workflows" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error ? (
          <DenseTable
            rows={workflows}
            rowKey={(workflow) => workflow.name}
            selectedKey={selectedName}
            onRowClick={selectWorkflow}
            empty={
              <EmptyState
                title="No saved workflows"
                detail="Saved workflows are loaded through daemon RPC."
              />
            }
            columns={workflowColumns()}
          />
        ) : null}

        {selectedName ? (
          <section className="panel workflow-detail-panel">
            <div className="panel-heading">
              <div>
                <h2>{selectedName}</h2>
                <div className="muted">
                  {detail?.title ?? selectedSummary?.title ?? detail?.description ?? "-"}
                </div>
              </div>
              <StatusPill tone={workflowStateTone(detail ?? selectedSummary)}>
                {workflowState(detail ?? selectedSummary)}
              </StatusPill>
            </div>
            <Tabs<WorkflowTab>
              tabs={[
                { id: "versions", label: "Versions", count: versions.length },
                { id: "source", label: "Source", count: source?.files.length },
                { id: "launch", label: "Launch" },
              ]}
              active={activeTab}
              onChange={setActiveTab}
            />
            <div className="tab-panel">
              {activeTab === "versions" ? (
                <WorkflowVersions
                  versions={versions}
                  selectedVersion={selectedVersion}
                  onSelectVersion={(version) => {
                    setSelectedVersion(version);
                    setActiveTab("source");
                  }}
                  loading={detailState.loading}
                  error={detailState.error}
                  onRetry={detailState.reload}
                />
              ) : null}
              {activeTab === "source" ? (
                <WorkflowSource
                  source={source}
                  loading={sourceState.loading}
                  error={sourceState.error}
                  onRetry={sourceState.reload}
                />
              ) : null}
              {activeTab === "launch" ? (
                <WorkflowLaunchForm
                  key={`${selectedName}:${selectedVersionView?.version ?? "latest"}`}
                  client={client}
                  workflow={detail ?? selectedSummary}
                  version={selectedVersionView}
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
      <WorkflowInspector
        workflow={detail ?? selectedSummary}
        loading={detailState.loading}
        error={detailState.error}
        onRetry={detailState.reload}
      />
    </div>
  );
}

function workflowColumns(): Array<Column<SavedWorkflowSummary>> {
  return [
    {
      key: "name",
      header: "Name",
      render: (workflow) => (
        <div className="cell-stack">
          <strong>{workflow.name}</strong>
          <span>{workflow.tags.join(", ") || "-"}</span>
        </div>
      ),
    },
    {
      key: "title",
      header: "Title",
      render: (workflow) => workflow.title ?? workflow.description ?? "-",
    },
    {
      key: "version",
      header: "Latest",
      width: "90px",
      align: "right",
      render: (workflow) => workflow.latestVersion ?? "-",
    },
    {
      key: "definition",
      header: "Definition",
      width: "190px",
      render: (workflow) =>
        workflow.latestDefinitionHash ? (
          <span className="mono text-truncate">{workflow.latestDefinitionHash}</span>
        ) : (
          <span className="muted">-</span>
        ),
    },
    {
      key: "state",
      header: "State",
      width: "120px",
      render: (workflow) => (
        <StatusPill tone={workflowStateTone(workflow)}>{workflowState(workflow)}</StatusPill>
      ),
    },
  ];
}

function WorkflowVersions({
  versions,
  selectedVersion,
  onSelectVersion,
  loading,
  error,
  onRetry,
}: {
  versions: SavedWorkflowVersionView[];
  selectedVersion: number | "latest";
  onSelectVersion(version: number): void;
  loading: boolean;
  error: Error | null;
  onRetry(): void;
}) {
  if (loading) return <LoadingState label="Loading workflow detail" />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  return (
    <DenseTable
      rows={versions}
      rowKey={(version) => String(version.version)}
      selectedKey={
        selectedVersion === "latest"
          ? String(resolveVersion(versions, "latest")?.version ?? "")
          : String(selectedVersion)
      }
      onRowClick={(version) => onSelectVersion(version.version)}
      empty={<EmptyState title="No workflow versions" />}
      columns={[
        {
          key: "version",
          header: "Version",
          width: "90px",
          render: (version) => <strong>{version.version}</strong>,
        },
        {
          key: "state",
          header: "State",
          width: "170px",
          render: (version) => <VersionState version={version} />,
        },
        {
          key: "workflow",
          header: "Workflow",
          render: (version) => version.workflowName ?? "-",
        },
        {
          key: "target",
          header: "Default target",
          render: (version) => (
            <span className="mono text-truncate">{version.defaultTarget ?? "-"}</span>
          ),
        },
        {
          key: "created",
          header: "Created",
          width: "185px",
          render: (version) => formatTime(version.createdAtMs),
        },
      ]}
    />
  );
}

function WorkflowSource({
  source,
  loading,
  error,
  onRetry,
}: {
  source: SavedWorkflowSourceView | null;
  loading: boolean;
  error: Error | null;
  onRetry(): void;
}) {
  if (loading) return <LoadingState label="Loading workflow source" />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  return (
    <div className="workflow-source-pane">
      {source ? (
        <div className="source-summary">
          <StatusPill tone="info">version {source.version}</StatusPill>
          <span className="mono text-truncate">{source.definitionHash}</span>
        </div>
      ) : null}
      <CodeViewer source={source} emptyDetail="The saved workflow source RPC returned no files." />
    </div>
  );
}

function WorkflowLaunchForm({
  client,
  workflow,
  version,
}: {
  client: KeelWebClient;
  workflow: SavedWorkflowView | SavedWorkflowSummary | null;
  version: SavedWorkflowVersionView | null;
}) {
  const [inputText, setInputText] = useState("{}");
  const [target, setTarget] = useState("");
  const [runName, setRunName] = useState("");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [launched, setLaunched] = useState<RunLaunchResult | null>(null);
  const formId = useId();

  useEffect(() => {
    setInputText(JSON.stringify(version?.defaultInputSet ? version.defaultInput : {}, null, 2));
    setTarget(version?.defaultTarget ?? "");
    setRunName("");
    setError(null);
    setLaunched(null);
  }, [version?.defaultTarget, version?.defaultInputSet, version?.defaultInput]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!workflow) return;
    const blocked = workflowLaunchBlockedReason(version);
    if (blocked) {
      setError(new Error(blocked));
      return;
    }
    setLaunching(true);
    setError(null);
    setLaunched(null);
    try {
      const input = inputText.trim() ? JSON.parse(inputText) : undefined;
      const result = await client.launchSavedWorkflow({
        name: workflow.name,
        version: version?.version ?? "latest",
        input,
        target: target.trim() || undefined,
        runName: runName.trim() || null,
      });
      setLaunched(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLaunching(false);
    }
  };

  if (!workflow) return <EmptyState title="No workflow selected" />;
  const launchBlockedReason = workflowLaunchBlockedReason(version);

  return (
    <form className="workflow-launch-form" onSubmit={submit}>
      <div className="notice-panel">
        Browser launch sends input, target, and run name only. Raw run secrets are not accepted from
        the web surface.
      </div>
      {launchBlockedReason ? <div className="form-error">{launchBlockedReason}</div> : null}
      <label className="form-field" htmlFor={`${formId}-target`}>
        <span>Target</span>
        <TextInput
          id={`${formId}-target`}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="/path/to/workspace"
        />
      </label>
      <label className="form-field" htmlFor={`${formId}-run-name`}>
        <span>Run name</span>
        <TextInput
          id={`${formId}-run-name`}
          value={runName}
          onChange={(event) => setRunName(event.target.value)}
          placeholder={version?.workflowName ?? workflow.name}
        />
      </label>
      <label className="form-field form-field-wide" htmlFor={`${formId}-input`}>
        <span>Input JSON</span>
        <textarea
          id={`${formId}-input`}
          className="field-textarea workflow-input-json"
          value={inputText}
          onChange={(event) => setInputText(event.target.value)}
        />
      </label>
      {error ? <div className="form-error">{error.message}</div> : null}
      {launched ? (
        <div className="form-success">
          Launched <a href={`#/runs/${encodeURIComponent(launched.runId)}`}>{launched.runId}</a>
        </div>
      ) : null}
      <div className="btn-row">
        <Button
          icon={Rocket}
          variant="primary"
          disabled={launching || launchBlockedReason !== null}
          type="submit"
        >
          {launching ? "Launching" : "Launch"}
        </Button>
      </div>
    </form>
  );
}

function WorkflowInspector({
  workflow,
  loading,
  error,
  onRetry,
}: {
  workflow: SavedWorkflowView | SavedWorkflowSummary | null;
  loading: boolean;
  error: Error | null;
  onRetry(): void;
}) {
  return (
    <Inspector
      title="Workflow"
      subtitle={workflow?.name ?? "No workflow"}
      status={
        workflow ? (
          <StatusPill tone={workflowStateTone(workflow)}>{workflowState(workflow)}</StatusPill>
        ) : null
      }
    >
      {loading ? <LoadingState label="Loading workflow" /> : null}
      {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
      {!loading && !error && workflow ? (
        <>
          <KeyValueList
            rows={[
              { label: "Title", value: workflow.title ?? "-" },
              { label: "Description", value: workflow.description ?? "-" },
              { label: "Tags", value: workflow.tags.join(", ") || "-" },
              { label: "Created", value: formatTime(workflow.createdAtMs) },
              { label: "Updated", value: formatTime(workflow.updatedAtMs) },
              { label: "Versions", value: workflow.versions.length },
            ]}
          />
          <JsonBlock value={workflow} />
        </>
      ) : null}
      {!loading && !error && !workflow ? <EmptyState title="No workflow selected" /> : null}
    </Inspector>
  );
}

function workflowLaunchBlockedReason(version: SavedWorkflowVersionView | null): string | null {
  if (!version) return "No launchable workflow version is selected.";
  if (version.deletedAtMs !== null) return "Deleted workflow versions cannot be launched.";
  if (!version.enabled) return "Disabled workflow versions cannot be launched.";
  if (version.deprecatedAtMs !== null) return "Deprecated workflow versions cannot be launched.";
  return null;
}

function VersionState({ version }: { version: SavedWorkflowVersionView }) {
  if (version.deletedAtMs !== null) return <StatusPill tone="failed">deleted</StatusPill>;
  if (!version.enabled) return <StatusPill tone="neutral">disabled</StatusPill>;
  if (version.deprecatedAtMs !== null) return <StatusPill tone="waiting">deprecated</StatusPill>;
  return <StatusPill tone="success">enabled</StatusPill>;
}

function workflowState(workflow: SavedWorkflowView | SavedWorkflowSummary | null): string {
  if (!workflow) return "unknown";
  if (workflow.deletedAtMs !== null) return "deleted";
  if (workflow.disabledAtMs !== null) return "disabled";
  return "enabled";
}

function workflowStateTone(workflow: SavedWorkflowView | SavedWorkflowSummary | null) {
  const state = workflowState(workflow);
  if (state === "enabled") return "success";
  if (state === "deleted") return "failed";
  return "neutral";
}

function resolveVersion(
  versions: SavedWorkflowVersionView[],
  version: number | "latest",
): SavedWorkflowVersionView | null {
  if (version !== "latest") {
    return versions.find((candidate) => candidate.version === version) ?? null;
  }
  return (
    latestVersion(
      versions.filter(
        (candidate) =>
          candidate.deletedAtMs === null && candidate.enabled && candidate.deprecatedAtMs === null,
      ),
    ) ??
    latestVersion(versions.filter((candidate) => candidate.deletedAtMs === null)) ??
    latestVersion(versions)
  );
}

function latestVersion(versions: SavedWorkflowVersionView[]): SavedWorkflowVersionView | null {
  return versions.reduce<SavedWorkflowVersionView | null>(
    (latest, candidate) => (!latest || candidate.version > latest.version ? candidate : latest),
    null,
  );
}
