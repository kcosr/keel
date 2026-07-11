import { useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { HealthResponse } from "../api/types";
import {
  EmptyState,
  ErrorState,
  JsonBlock,
  KeyValueList,
  LoadingState,
  StatusPill,
  Tabs,
  formatTime,
} from "../components/controls";
import { useAsync } from "../hooks/use-async";

type SystemTab = "overview" | "diagnostics";

export function SystemScreen({
  client,
  health,
  refreshKey,
}: { client: KeelWebClient; health: HealthResponse | null; refreshKey: number }) {
  const state = useAsync(() => client.system(), [client, refreshKey]);
  const [tab, setTab] = useState<SystemTab>("overview");

  return (
    <div className="content-scroll system-screen resource-screen">
      <Tabs<SystemTab>
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "diagnostics", label: "Diagnostics", count: state.data?.warnings.length },
        ]}
        active={tab}
        onChange={setTab}
      />
      {state.loading ? <LoadingState label="Loading system" /> : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
      {tab === "overview" ? (
        <div className="overview-grid">
          <section className="panel">
            <div className="panel-heading">
              <h2>Web console</h2>
              <StatusPill tone={health?.web.ok ? "success" : "failed"}>
                {health?.web.ok ? "healthy" : "unavailable"}
              </StatusPill>
            </div>
            {health ? (
              <KeyValueList
                rows={[
                  { label: "Mode", value: health.web.apiOnly ? "API only" : "Console and API" },
                  { label: "Bundle", value: health.bundle.available ? "Available" : "Missing" },
                  { label: "Bundle updated", value: formatTime(health.bundle.indexMtimeMs) },
                ]}
              />
            ) : (
              <LoadingState label="Loading health" />
            )}
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Daemon</h2>
              <StatusPill tone={health?.daemon.reachable ? "success" : "failed"}>
                {health?.daemon.reachable ? "reachable" : "unreachable"}
              </StatusPill>
            </div>
            {health ? (
              <KeyValueList
                rows={[
                  {
                    label: "Healthy",
                    value: health.daemon.ok === undefined ? "-" : health.daemon.ok ? "yes" : "no",
                  },
                  { label: "Owner", value: health.daemon.ownerId ?? "-", mono: true },
                  { label: "Error", value: health.daemon.error?.message ?? "-" },
                ]}
              />
            ) : (
              <LoadingState label="Loading daemon" />
            )}
          </section>
          <section className="panel panel-wide">
            <h2>Runtime inventory</h2>
            {state.data ? (
              <div className="system-grid">
                <div className="metric">
                  <strong>{state.data.profiles.length}</strong>
                  <span>Profiles</span>
                </div>
                <div className="metric">
                  <strong>{state.data.settings.length}</strong>
                  <span>Settings</span>
                </div>
                <div className="metric">
                  <strong>{state.data.warnings.length}</strong>
                  <span>Warnings</span>
                </div>
              </div>
            ) : null}
          </section>
          {state.data?.warnings.length ? (
            <section className="panel panel-wide">
              <h2>Warnings</h2>
              <div className="warning-list">
                {state.data.warnings.map((warning) => (
                  <div className="notice-panel" key={warning}>
                    {warning}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
      {tab === "diagnostics" ? (
        <section className="panel diagnostics-panel">
          <div className="panel-heading">
            <div>
              <h2>Raw system projection</h2>
              <div className="muted">
                Daemon, profile, and setting data returned by the system API.
              </div>
            </div>
          </div>
          {state.data ? (
            <JsonBlock value={state.data} />
          ) : (
            <EmptyState title="No system projection loaded" />
          )}
        </section>
      ) : null}
    </div>
  );
}
