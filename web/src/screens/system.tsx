import type { KeelWebClient } from "../api/client";
import type { HealthResponse } from "../api/types";
import {
  EmptyState,
  ErrorState,
  JsonBlock,
  KeyValueList,
  LoadingState,
  StatusPill,
  formatTime,
  toneForStatus,
} from "../components/controls";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

export function SystemScreen({
  client,
  health,
  refreshKey,
}: {
  client: KeelWebClient;
  health: HealthResponse | null;
  refreshKey: number;
}) {
  const state = useAsync(() => client.system(), [client, refreshKey]);

  return (
    <div className="content-split">
      <div className="content-scroll">
        <div className="overview-grid">
          <section className="panel">
            <h2>Web</h2>
            {health ? (
              <KeyValueList
                rows={[
                  { label: "API only", value: String(health.web.apiOnly) },
                  {
                    label: "Bundle",
                    value: (
                      <StatusPill tone={health.bundle.available ? "success" : "waiting"}>
                        {health.bundle.available ? "available" : "missing"}
                      </StatusPill>
                    ),
                  },
                  { label: "Bundle mtime", value: formatTime(health.bundle.indexMtimeMs) },
                ]}
              />
            ) : (
              <LoadingState label="Loading health" />
            )}
          </section>
          <section className="panel">
            <h2>Daemon</h2>
            {health ? (
              <KeyValueList
                rows={[
                  {
                    label: "Reachable",
                    value: (
                      <StatusPill tone={health.daemon.reachable ? "success" : "failed"}>
                        {String(health.daemon.reachable)}
                      </StatusPill>
                    ),
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
            <h2>Projection</h2>
            {state.loading ? <LoadingState label="Loading system" /> : null}
            {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
            {state.data ? (
              <div className="system-grid">
                <StatusPill tone="info">{state.data.profiles.length} profiles</StatusPill>
                <StatusPill tone="info">{state.data.settings.length} settings</StatusPill>
                {state.data.warnings.map((warning) => (
                  <StatusPill tone={toneForStatus("waiting")} key={warning}>
                    {warning}
                  </StatusPill>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      </div>
      <Inspector title="System raw">
        {state.data ? (
          <JsonBlock value={state.data} />
        ) : (
          <EmptyState title="No system projection loaded" />
        )}
      </Inspector>
    </div>
  );
}
