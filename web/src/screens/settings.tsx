import { useEffect, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { SettingView } from "../api/types";
import {
  EmptyState,
  ErrorState,
  JsonBlock,
  LoadingState,
  StatusPill,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

export function SettingsScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const state = useAsync(() => client.listSettings(), [client, refreshKey]);
  const settings = state.data ?? [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    if (selectedKey && settings.some((setting) => setting.key === selectedKey)) return;
    setSelectedKey(settings[0]?.key ?? null);
  }, [settings, selectedKey]);
  const selected = settings.find((setting) => setting.key === selectedKey) ?? null;

  return (
    <div className="content-split">
      <div className="content-scroll">
        {state.loading ? <LoadingState label="Loading settings" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error ? (
          <DenseTable
            rows={settings}
            rowKey={(setting) => setting.key}
            selectedKey={selectedKey}
            onRowClick={(setting) => setSelectedKey(setting.key)}
            empty={<EmptyState title="No settings returned" />}
            columns={settingColumns()}
          />
        ) : null}
      </div>
      <Inspector title="Setting" subtitle={selected?.key ?? "No setting"}>
        {selected ? <JsonBlock value={selected} /> : <EmptyState title="No setting selected" />}
      </Inspector>
    </div>
  );
}

function settingColumns(): Array<Column<SettingView>> {
  return [
    { key: "key", header: "Key", render: (setting) => <strong>{setting.key}</strong> },
    {
      key: "value",
      header: "Value",
      render: (setting) => (
        <span className="mono text-truncate">{JSON.stringify(setting.value)}</span>
      ),
    },
    { key: "source", header: "Source", width: "130px", render: (setting) => setting.source ?? "-" },
    {
      key: "diagnostics",
      header: "Diagnostics",
      width: "130px",
      render: (setting) => (
        <StatusPill tone={(setting.diagnostics?.length ?? 0) > 0 ? "waiting" : "success"}>
          {setting.diagnostics?.length ?? 0}
        </StatusPill>
      ),
    },
  ];
}
