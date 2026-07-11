import { RotateCcw, Save } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { SettingCheckResult, SettingView, SettingsDiagnostic } from "../api/types";
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
  formatTime,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { useAsync } from "../hooks/use-async";

type SettingClassFilter = "all" | SettingView["class"];

export function SettingsScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const [mutationKey, setMutationKey] = useState(0);
  const state = useAsync(() => client.listSettings(), [client, refreshKey, mutationKey]);
  const settings = state.data ?? [];
  const [classFilter, setClassFilter] = useState<SettingClassFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const filtered = useMemo(
    () =>
      classFilter === "all"
        ? settings
        : settings.filter((setting) => setting.class === classFilter),
    [settings, classFilter],
  );

  useEffect(() => {
    if (selectedKey && filtered.some((setting) => setting.key === selectedKey)) return;
    setSelectedKey(filtered[0]?.key ?? null);
  }, [filtered, selectedKey]);

  const selectedSummary = filtered.find((setting) => setting.key === selectedKey) ?? null;
  const detailState = useAsync(
    () => (selectedKey ? client.getSetting(selectedKey) : Promise.resolve(null)),
    [client, selectedKey, refreshKey, mutationKey],
  );
  const detail = detailState.data ?? selectedSummary;
  const checkState = useAsync(
    () =>
      detail && !detail.readOnly
        ? client.checkSetting(detail.key, detail.value)
        : Promise.resolve(null),
    [client, detail?.key, detail?.value, detail?.readOnly, refreshKey, mutationKey],
  );
  const counts = useMemo(() => settingCounts(settings), [settings]);

  return (
    <div className="content-scroll setting-screen resource-screen">
      <div className="toolbar">
        <div className="toolbar-left">
          <Select
            value={classFilter}
            onChange={(event) => setClassFilter(event.target.value as SettingClassFilter)}
            aria-label="Setting class"
          >
            <option value="all">All classes</option>
            <option value="workflow-visible">Workflow visible</option>
            <option value="daemon-operational">Daemon operational</option>
          </Select>
          <StatusPill tone="info">{counts.defaultCount} defaults</StatusPill>
          <StatusPill tone="success">{counts.catalogCount} overrides</StatusPill>
          <StatusPill tone="neutral">{counts.readOnlyCount} read-only</StatusPill>
        </div>
      </div>
      {state.loading ? <LoadingState label="Loading settings" /> : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error ? (
        <DenseTable
          rows={filtered}
          rowKey={(setting) => setting.key}
          selectedKey={selectedKey}
          onRowClick={(setting) => setSelectedKey(setting.key)}
          empty={<EmptyState title="No settings returned" />}
          columns={settingColumns()}
        />
      ) : null}

      {detail ? (
        <section className="resource-detail-panel">
          <div className="panel-heading">
            <div>
              <h2>{detail.key}</h2>
              <div className="muted">{detail.description}</div>
            </div>
            <StatusPill tone={detail.isDefault ? "neutral" : "success"}>
              {detail.isDefault ? "default" : "override"}
            </StatusPill>
          </div>
          {detailState.loading ? <LoadingState label="Loading setting" /> : null}
          {detailState.error ? (
            <ErrorState error={detailState.error} onRetry={detailState.reload} />
          ) : null}
          {!detailState.loading && !detailState.error ? (
            <div className="resource-editor-grid">
              <SettingEditor
                key={`${detail.key}:${detail.generation}:${mutationKey}`}
                client={client}
                setting={detail}
                onMutated={() => setMutationKey((value) => value + 1)}
              />
              <div className="resource-side-stack">
                <section className="panel">
                  <h2>Metadata</h2>
                  <KeyValueList
                    rows={[
                      { label: "Class", value: detail.class },
                      { label: "Read-only", value: detail.readOnly ? "yes" : "no" },
                      { label: "Generation", value: detail.generation ?? "-" },
                      { label: "Updated", value: formatTime(detail.updatedAtMs) },
                    ]}
                  />
                </section>
                <section className="panel">
                  <h2>Default value</h2>
                  <JsonBlock value={detail.defaultValue} />
                </section>
                <SettingCheckPanel
                  check={checkState.data}
                  loading={checkState.loading}
                  error={checkState.error}
                  readOnly={detail.readOnly}
                  onRetry={checkState.reload}
                />
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function SettingEditor({
  client,
  setting,
  onMutated,
}: {
  client: KeelWebClient;
  setting: SettingView;
  onMutated(): void;
}) {
  const [text, setText] = useState(() => JSON.stringify(setting.value, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const value = JSON.parse(text);
      const check = await client.checkSetting(setting.key, value);
      if (!check.ok) throw new Error(formatDiagnostics(check.diagnostics));
      await client.putSetting(setting.key, value, setting.generation ?? undefined);
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.deleteSetting(setting.key, setting.generation ?? undefined);
      setResetOpen(false);
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel resource-editor">
      <div className="panel-heading">
        <h2>Current value</h2>
        {setting.readOnly ? <StatusPill tone="neutral">read-only</StatusPill> : null}
      </div>
      {setting.readOnly ? (
        <JsonBlock value={setting.value} />
      ) : (
        <form onSubmit={save}>
          <label className="form-field" htmlFor="setting-value-json">
            <span>JSON value</span>
            <textarea
              id="setting-value-json"
              className="field-textarea resource-json-editor"
              value={text}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          {error ? (
            <div className="form-error" role="alert">
              {error.message}
            </div>
          ) : null}
          <div className="form-actions">
            <Button icon={Save} variant="primary" type="submit" disabled={busy}>
              Save value
            </Button>
            {!setting.isDefault ? (
              <Button
                icon={RotateCcw}
                variant="danger"
                disabled={busy}
                onClick={() => setResetOpen(true)}
              >
                Reset to default
              </Button>
            ) : null}
          </div>
        </form>
      )}
      <ConfirmDialog
        open={resetOpen}
        title="Reset setting?"
        detail={`Remove the catalog override for ${setting.key} and restore its default value.`}
        confirmLabel="Reset setting"
        busy={busy}
        onClose={() => setResetOpen(false)}
        onConfirm={() => void reset()}
      />
    </section>
  );
}

function settingColumns(): Array<Column<SettingView>> {
  return [
    {
      key: "key",
      header: "Key",
      render: (setting) => (
        <div className="cell-stack">
          <strong>{setting.key}</strong>
          <span>{setting.description}</span>
        </div>
      ),
    },
    { key: "class", header: "Class", width: "160px", render: (setting) => setting.class },
    {
      key: "value",
      header: "Value",
      render: (setting) => <span className="mono text-truncate">{settingText(setting.value)}</span>,
    },
    {
      key: "source",
      header: "Source",
      width: "120px",
      render: (setting) => (
        <StatusPill tone={setting.isDefault ? "neutral" : "success"}>
          {setting.isDefault ? "default" : "override"}
        </StatusPill>
      ),
    },
    {
      key: "readonly",
      header: "Read-only",
      width: "110px",
      render: (setting) => (setting.readOnly ? "yes" : "no"),
    },
  ];
}

function SettingCheckPanel({
  check,
  loading,
  error,
  readOnly,
  onRetry,
}: {
  check: SettingCheckResult | null;
  loading: boolean;
  error: Error | null;
  readOnly: boolean;
  onRetry(): void;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Write check</h2>
        {readOnly ? (
          <StatusPill tone="neutral">read-only</StatusPill>
        ) : check ? (
          <StatusPill tone={check.ok ? "success" : "failed"}>
            {check.ok ? "ok" : "failed"}
          </StatusPill>
        ) : null}
      </div>
      {readOnly ? (
        <div className="notice-panel">
          This setting is read-only. Runtime write validation is skipped because writes are not
          available for this setting.
        </div>
      ) : (
        <>
          {loading ? <LoadingState label="Checking setting" /> : null}
          {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
          {!loading && !error && check ? (
            <SettingsDiagnostics diagnostics={check.diagnostics} />
          ) : null}
        </>
      )}
    </section>
  );
}

function SettingsDiagnostics({ diagnostics }: { diagnostics: SettingsDiagnostic[] }) {
  if (diagnostics.length === 0)
    return (
      <EmptyState title="No diagnostics" detail="The current value passes the write validator." />
    );
  return (
    <div className="diagnostic-list">
      {diagnostics.map((diagnostic, index) => (
        <div className="diagnostic-row" key={`${diagnostic.path}:${index}`}>
          <StatusPill
            tone={
              diagnostic.level === "error"
                ? "failed"
                : diagnostic.level === "warning"
                  ? "waiting"
                  : "info"
            }
          >
            {diagnostic.level}
          </StatusPill>
          <span className="mono">{diagnostic.path}</span>
          <span>{diagnostic.message}</span>
        </div>
      ))}
    </div>
  );
}

function settingCounts(settings: SettingView[]) {
  return {
    defaultCount: settings.filter((setting) => setting.isDefault).length,
    catalogCount: settings.filter((setting) => !setting.isDefault).length,
    readOnlyCount: settings.filter((setting) => setting.readOnly).length,
  };
}

function settingText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatDiagnostics(diagnostics: SettingsDiagnostic[]): string {
  return (
    diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ") ||
    "Setting validation failed."
  );
}
