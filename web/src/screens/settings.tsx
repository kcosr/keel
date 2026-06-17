import { useEffect, useMemo, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { SettingCheckResult, SettingView, SettingsDiagnostic } from "../api/types";
import {
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
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

type SettingClassFilter = "all" | SettingView["class"];

export function SettingsScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const state = useAsync(() => client.listSettings(), [client, refreshKey]);
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
    [client, selectedKey, refreshKey],
  );
  const detail = detailState.data ?? selectedSummary;
  const checkState = useAsync(
    () => (detail ? client.checkSetting(detail.key, detail.value) : Promise.resolve(null)),
    [client, detail?.key, detail?.value, refreshKey],
  );
  const counts = useMemo(() => settingCounts(settings), [settings]);

  return (
    <div className="content-split">
      <div className="content-scroll setting-screen">
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
            <StatusPill tone="info">{counts.catalogCount} catalog overrides</StatusPill>
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
          <section className="panel setting-detail-panel">
            <div className="panel-heading">
              <div>
                <h2>{detail.key}</h2>
                <div className="muted">{detail.description}</div>
              </div>
              <StatusPill tone={detail.isDefault ? "neutral" : "success"}>
                {detail.isDefault ? "default" : "catalog"}
              </StatusPill>
            </div>
            <div className="overview-grid">
              <section className="panel">
                <h2>Value</h2>
                <KeyValueList
                  rows={[
                    { label: "Class", value: detail.class },
                    { label: "Read-only", value: detail.readOnly ? "yes" : "no" },
                    { label: "Generation", value: detail.generation ?? "-" },
                    { label: "Updated", value: formatTime(detail.updatedAtMs) },
                  ]}
                />
                <JsonBlock value={detail.value} />
              </section>
              <section className="panel">
                <h2>Default</h2>
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
          </section>
        ) : null}
      </div>
      <SettingInspector
        setting={detail}
        loading={detailState.loading}
        error={detailState.error}
        onRetry={detailState.reload}
      />
    </div>
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
    {
      key: "class",
      header: "Class",
      width: "160px",
      render: (setting) => setting.class,
    },
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
          {setting.isDefault ? "default" : "catalog"}
        </StatusPill>
      ),
    },
    {
      key: "readonly",
      header: "Read-only",
      width: "110px",
      render: (setting) => (setting.readOnly ? "yes" : "no"),
    },
    {
      key: "generation",
      header: "Generation",
      width: "110px",
      align: "right",
      render: (setting) => setting.generation ?? "-",
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
    <section className="panel panel-wide">
      <div className="panel-heading">
        <h2>Write Check</h2>
        {check ? (
          <StatusPill tone={check.ok ? "success" : "failed"}>
            {check.ok ? "ok" : "failed"}
          </StatusPill>
        ) : null}
      </div>
      {readOnly ? (
        <div className="notice-panel">Read-only settings intentionally fail write checks.</div>
      ) : null}
      {loading ? <LoadingState label="Checking setting" /> : null}
      {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
      {!loading && !error && check ? <SettingsDiagnostics diagnostics={check.diagnostics} /> : null}
    </section>
  );
}

function SettingInspector({
  setting,
  loading,
  error,
  onRetry,
}: {
  setting: SettingView | null;
  loading: boolean;
  error: Error | null;
  onRetry(): void;
}) {
  return (
    <Inspector
      title="Setting"
      subtitle={setting?.key ?? "No setting"}
      status={
        setting ? (
          <StatusPill tone={setting.isDefault ? "neutral" : "success"}>
            {setting.isDefault ? "default" : "catalog"}
          </StatusPill>
        ) : null
      }
    >
      {loading ? <LoadingState label="Loading setting" /> : null}
      {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
      {!loading && !error && setting ? (
        <>
          <KeyValueList
            rows={[
              { label: "Class", value: setting.class },
              { label: "Read-only", value: setting.readOnly ? "yes" : "no" },
              { label: "Generation", value: setting.generation ?? "-" },
              { label: "Updated", value: formatTime(setting.updatedAtMs) },
            ]}
          />
          <JsonBlock value={setting} />
        </>
      ) : null}
      {!loading && !error && !setting ? <EmptyState title="No setting selected" /> : null}
    </Inspector>
  );
}

function SettingsDiagnostics({ diagnostics }: { diagnostics: SettingsDiagnostic[] }) {
  if (diagnostics.length === 0) {
    return (
      <EmptyState title="No diagnostics" detail="The current value passes the write validator." />
    );
  }
  return (
    <div className="diagnostic-list">
      {diagnostics.map((diagnostic, index) => (
        <div className="diagnostic-row" key={`${diagnostic.path}:${index}`}>
          <StatusPill tone={diagnosticTone(diagnostic.level)}>{diagnostic.level}</StatusPill>
          <span className="mono">{diagnostic.path}</span>
          <span>{diagnostic.message}</span>
        </div>
      ))}
    </div>
  );
}

function settingCounts(settings: SettingView[]): {
  defaultCount: number;
  catalogCount: number;
  readOnlyCount: number;
} {
  return {
    defaultCount: settings.filter((setting) => setting.isDefault).length,
    catalogCount: settings.filter((setting) => !setting.isDefault).length,
    readOnlyCount: settings.filter((setting) => setting.readOnly).length,
  };
}

function settingText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function diagnosticTone(level: SettingsDiagnostic["level"]): "failed" | "waiting" | "info" {
  if (level === "error") return "failed";
  if (level === "warning") return "waiting";
  return "info";
}
