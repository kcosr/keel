import { useEffect, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { AgentProfileView } from "../api/types";
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

export function ProfilesScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const state = useAsync(() => client.listAgentProfiles(), [client, refreshKey]);
  const profiles = state.data ?? [];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  useEffect(() => {
    if (selectedName && profiles.some((profile) => profile.name === selectedName)) return;
    setSelectedName(profiles[0]?.name ?? null);
  }, [profiles, selectedName]);
  const selected = profiles.find((profile) => profile.name === selectedName) ?? null;

  return (
    <div className="content-split">
      <div className="content-scroll">
        {state.loading ? <LoadingState label="Loading profiles" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error ? (
          <DenseTable
            rows={profiles}
            rowKey={(profile) => profile.name}
            selectedKey={selectedName}
            onRowClick={(profile) => setSelectedName(profile.name)}
            empty={<EmptyState title="No profiles returned" />}
            columns={profileColumns()}
          />
        ) : null}
      </div>
      <Inspector title="Profile" subtitle={selected?.name ?? "No profile"}>
        {selected ? <JsonBlock value={selected} /> : <EmptyState title="No profile selected" />}
      </Inspector>
    </div>
  );
}

function profileColumns(): Array<Column<AgentProfileView>> {
  return [
    { key: "name", header: "Name", render: (profile) => <strong>{profile.name}</strong> },
    { key: "source", header: "Source", width: "130px", render: (profile) => profile.source ?? "-" },
    {
      key: "generation",
      header: "Generation",
      width: "110px",
      align: "right",
      render: (profile) => profile.generation ?? "-",
    },
    {
      key: "diagnostics",
      header: "Diagnostics",
      width: "130px",
      render: (profile) => (
        <StatusPill tone={(profile.diagnostics?.length ?? 0) > 0 ? "waiting" : "success"}>
          {profile.diagnostics?.length ?? 0}
        </StatusPill>
      ),
    },
  ];
}
