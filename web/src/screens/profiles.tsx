import { useEffect, useMemo, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type {
  AgentProfileCheckResult,
  AgentProfileDiagnostic,
  AgentProfileView,
} from "../api/types";
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

type ProfileSourceFilter = "all" | "catalog" | "programmatic";

export function ProfilesScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const [sourceFilter, setSourceFilter] = useState<ProfileSourceFilter>("all");
  const state = useAsync(
    () => client.listAgentProfiles(sourceFilter),
    [client, sourceFilter, refreshKey],
  );
  const profiles = state.data ?? [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (selectedKey && profiles.some((profile) => profileKey(profile) === selectedKey)) return;
    setSelectedKey(profiles[0] ? profileKey(profiles[0]) : null);
  }, [profiles, selectedKey]);

  const selectedSummary = profiles.find((profile) => profileKey(profile) === selectedKey) ?? null;
  const selectedName = selectedSummary?.name ?? null;
  const detailState = useAsync(
    () => (selectedName ? client.getAgentProfile(selectedName) : Promise.resolve(null)),
    [client, selectedName, refreshKey],
  );
  const checkState = useAsync(
    () => (selectedName ? client.checkAgentProfile(selectedName) : Promise.resolve(null)),
    [client, selectedName, refreshKey],
  );
  const detail = detailState.data ?? selectedSummary;
  const providerCounts = useMemo(() => countByProvider(profiles), [profiles]);

  return (
    <div className="content-split">
      <div className="content-scroll profile-screen">
        <div className="toolbar">
          <div className="toolbar-left">
            <Select
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value as ProfileSourceFilter)}
              aria-label="Profile source"
            >
              <option value="all">All sources</option>
              <option value="programmatic">Programmatic</option>
              <option value="catalog">Catalog</option>
            </Select>
            {Object.entries(providerCounts).map(([provider, count]) => (
              <StatusPill tone="info" key={provider}>
                {provider}: {count}
              </StatusPill>
            ))}
          </div>
        </div>
        {state.loading ? <LoadingState label="Loading profiles" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error ? (
          <DenseTable
            rows={profiles}
            rowKey={profileKey}
            selectedKey={selectedKey}
            onRowClick={(profile) => setSelectedKey(profileKey(profile))}
            empty={<EmptyState title="No profiles returned" />}
            columns={profileColumns()}
          />
        ) : null}

        {detail ? (
          <section className="panel profile-detail-panel">
            <div className="panel-heading">
              <div>
                <h2>{detail.name}</h2>
                <div className="muted">{detail.configHash}</div>
              </div>
              <StatusPill tone={detail.source === "catalog" ? "success" : "info"}>
                {detail.source}
              </StatusPill>
            </div>
            <div className="overview-grid">
              <section className="panel">
                <h2>Runtime</h2>
                <KeyValueList
                  rows={[
                    { label: "Provider", value: textValue(detail.config.provider) },
                    { label: "Model", value: textValue(detail.config.model) },
                    { label: "Reasoning", value: textValue(detail.config.reasoning) },
                    { label: "Tool policy", value: textValue(detail.config.toolPolicy) },
                    { label: "Timeout", value: textValue(detail.config.timeoutMs) },
                    { label: "On failure", value: textValue(detail.config.onFailure) },
                  ]}
                />
              </section>
              <ProfileCheckPanel
                check={checkState.data}
                loading={checkState.loading}
                error={checkState.error}
                onRetry={checkState.reload}
              />
              <section className="panel panel-wide">
                <h2>Config</h2>
                <JsonBlock value={detail.config} />
              </section>
            </div>
          </section>
        ) : null}
      </div>
      <ProfileInspector
        profile={detail}
        loading={detailState.loading}
        error={detailState.error}
        onRetry={detailState.reload}
      />
    </div>
  );
}

function profileColumns(): Array<Column<AgentProfileView>> {
  return [
    {
      key: "name",
      header: "Name",
      render: (profile) => (
        <div className="cell-stack">
          <strong>{profile.name}</strong>
          <span>{profile.configHash}</span>
        </div>
      ),
    },
    {
      key: "source",
      header: "Source",
      width: "130px",
      render: (profile) => (
        <StatusPill tone={profile.source === "catalog" ? "success" : "info"}>
          {profile.source}
        </StatusPill>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      width: "130px",
      render: (profile) => textValue(profile.config.provider),
    },
    {
      key: "model",
      header: "Model",
      render: (profile) => (
        <span className="mono text-truncate">{textValue(profile.config.model)}</span>
      ),
    },
    {
      key: "toolPolicy",
      header: "Tools",
      width: "130px",
      render: (profile) => textValue(profile.config.toolPolicy),
    },
    {
      key: "generation",
      header: "Generation",
      width: "110px",
      align: "right",
      render: (profile) => profile.generation ?? "-",
    },
  ];
}

function ProfileCheckPanel({
  check,
  loading,
  error,
  onRetry,
}: {
  check: AgentProfileCheckResult | null;
  loading: boolean;
  error: Error | null;
  onRetry(): void;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Check</h2>
        {check ? (
          <StatusPill tone={check.ok ? "success" : "failed"}>
            {check.ok ? "ok" : "failed"}
          </StatusPill>
        ) : null}
      </div>
      {loading ? <LoadingState label="Checking profile" /> : null}
      {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
      {!loading && !error && check ? <DiagnosticsList diagnostics={check.diagnostics} /> : null}
    </section>
  );
}

function ProfileInspector({
  profile,
  loading,
  error,
  onRetry,
}: {
  profile: AgentProfileView | null;
  loading: boolean;
  error: Error | null;
  onRetry(): void;
}) {
  return (
    <Inspector
      title="Profile"
      subtitle={profile?.name ?? "No profile"}
      status={
        profile ? (
          <StatusPill tone={profile.source === "catalog" ? "success" : "info"}>
            {profile.source}
          </StatusPill>
        ) : null
      }
    >
      {loading ? <LoadingState label="Loading profile" /> : null}
      {error ? <ErrorState error={error} onRetry={onRetry} /> : null}
      {!loading && !error && profile ? (
        <>
          <KeyValueList
            rows={[
              { label: "Source", value: profile.source },
              { label: "Hash", value: profile.configHash, mono: true },
              { label: "Generation", value: profile.generation ?? "-" },
              { label: "Created", value: formatTime(profile.createdAtMs) },
              { label: "Updated", value: formatTime(profile.updatedAtMs) },
            ]}
          />
          <JsonBlock value={profile} />
        </>
      ) : null}
      {!loading && !error && !profile ? <EmptyState title="No profile selected" /> : null}
    </Inspector>
  );
}

function DiagnosticsList({ diagnostics }: { diagnostics: AgentProfileDiagnostic[] }) {
  if (diagnostics.length === 0) {
    return (
      <EmptyState title="No diagnostics" detail="The current profile passes catalog validation." />
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

function profileKey(profile: AgentProfileView): string {
  return `${profile.source}:${profile.name}`;
}

function countByProvider(profiles: AgentProfileView[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const profile of profiles) {
    const provider = textValue(profile.config.provider);
    counts[provider] = (counts[provider] ?? 0) + 1;
  }
  return counts;
}

function textValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function diagnosticTone(level: AgentProfileDiagnostic["level"]): "failed" | "waiting" | "info" {
  if (level === "error") return "failed";
  if (level === "warning") return "waiting";
  return "info";
}
