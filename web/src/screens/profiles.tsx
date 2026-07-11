import { Plus, Save, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type {
  AgentProfileCheckResult,
  AgentProfileDiagnostic,
  AgentProfileView,
} from "../api/types";
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
  TextInput,
  formatTime,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { useAsync } from "../hooks/use-async";

type ProfileSourceFilter = "all" | "catalog" | "programmatic";

export function ProfilesScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const [sourceFilter, setSourceFilter] = useState<ProfileSourceFilter>("all");
  const [mutationKey, setMutationKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const state = useAsync(
    () => client.listAgentProfiles(sourceFilter),
    [client, sourceFilter, refreshKey, mutationKey],
  );
  const profiles = state.data ?? [];
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (creating) return;
    if (selectedKey && profiles.some((profile) => profileKey(profile) === selectedKey)) return;
    setSelectedKey(profiles[0] ? profileKey(profiles[0]) : null);
  }, [creating, profiles, selectedKey]);

  const selectedSummary = profiles.find((profile) => profileKey(profile) === selectedKey) ?? null;
  const selectedName = selectedSummary?.name ?? null;
  const detailState = useAsync(
    () => (selectedName ? client.getAgentProfile(selectedName) : Promise.resolve(null)),
    [client, selectedName, refreshKey, mutationKey],
  );
  const checkState = useAsync(
    () => (selectedName ? client.checkAgentProfile(selectedName) : Promise.resolve(null)),
    [client, selectedName, refreshKey, mutationKey],
  );
  const detail = detailState.data ?? selectedSummary;
  const providerCounts = useMemo(() => countByProvider(profiles), [profiles]);
  const mutated = (name?: string) => {
    setCreating(false);
    if (name) setSelectedKey(`catalog:${name}`);
    setMutationKey((value) => value + 1);
  };

  return (
    <div className="content-scroll profile-screen resource-screen">
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
        <Button
          icon={Plus}
          variant="primary"
          onClick={() => {
            setSourceFilter("catalog");
            setCreating(true);
            setSelectedKey(null);
          }}
        >
          New profile
        </Button>
      </div>
      {state.loading ? <LoadingState label="Loading profiles" /> : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error ? (
        <DenseTable
          rows={profiles}
          rowKey={profileKey}
          selectedKey={selectedKey}
          onRowClick={(profile) => {
            setCreating(false);
            setSelectedKey(profileKey(profile));
          }}
          empty={<EmptyState title="No profiles returned" />}
          columns={profileColumns()}
        />
      ) : null}

      {creating ? (
        <ProfileEditor client={client} onCancel={() => setCreating(false)} onMutated={mutated} />
      ) : detail ? (
        <section className="resource-detail-panel">
          <div className="panel-heading">
            <div>
              <h2>{detail.name}</h2>
              <div className="muted mono">{detail.configHash}</div>
            </div>
            <StatusPill tone={detail.source === "catalog" ? "success" : "info"}>
              {detail.source}
            </StatusPill>
          </div>
          {detailState.loading ? <LoadingState label="Loading profile" /> : null}
          {detailState.error ? (
            <ErrorState error={detailState.error} onRetry={detailState.reload} />
          ) : null}
          {!detailState.loading && !detailState.error ? (
            <div className="resource-editor-grid">
              {detail.source === "catalog" ? (
                <ProfileEditor
                  key={`${detail.name}:${detail.generation}`}
                  client={client}
                  profile={detail}
                  onMutated={mutated}
                />
              ) : (
                <section className="panel resource-editor">
                  <div className="panel-heading">
                    <h2>Configuration</h2>
                    <StatusPill tone="neutral">managed in code</StatusPill>
                  </div>
                  <div className="notice-panel">
                    Programmatic profiles are defined by workflow code and cannot be changed from
                    the catalog.
                  </div>
                  <JsonBlock value={detail.config} />
                </section>
              )}
              <div className="resource-side-stack">
                <section className="panel">
                  <h2>Runtime</h2>
                  <KeyValueList
                    rows={[
                      { label: "Provider", value: textValue(detail.config.provider) },
                      { label: "Model", value: textValue(detail.config.model) },
                      { label: "Reasoning", value: textValue(detail.config.reasoning) },
                      { label: "Tool policy", value: textValue(detail.config.toolPolicy) },
                      { label: "Generation", value: detail.generation ?? "-" },
                      { label: "Updated", value: formatTime(detail.updatedAtMs) },
                    ]}
                  />
                </section>
                <ProfileCheckPanel
                  check={checkState.data}
                  loading={checkState.loading}
                  error={checkState.error}
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

function ProfileEditor({
  client,
  profile,
  onCancel,
  onMutated,
}: {
  client: KeelWebClient;
  profile?: AgentProfileView;
  onCancel?(): void;
  onMutated(name?: string): void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [text, setText] = useState(() =>
    JSON.stringify(profile?.config ?? { provider: "codex", toolPolicy: "read-only" }, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const formId = useId();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const config = JSON.parse(text) as Record<string, unknown>;
      if (!config || Array.isArray(config) || typeof config !== "object")
        throw new Error("Profile config must be a JSON object.");
      const check = await client.checkAgentProfileConfig(config);
      if (!check.ok) throw new Error(formatDiagnostics(check.diagnostics));
      const saved = await client.putAgentProfile({
        name: name.trim(),
        config,
        ...(profile?.generation !== null && profile?.generation !== undefined
          ? { ifGeneration: profile.generation }
          : {}),
        ...(!profile ? { createOnly: true } : {}),
      });
      onMutated(saved.name);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      await client.deleteAgentProfile(profile.name, profile.generation ?? undefined);
      setDeleteOpen(false);
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`panel resource-editor ${profile ? "" : "resource-create-panel"}`}>
      <div className="panel-heading">
        <h2>{profile ? "Edit configuration" : "Create catalog profile"}</h2>
      </div>
      <form onSubmit={save}>
        <label className="form-field" htmlFor={`${formId}-name`}>
          <span>Name</span>
          <TextInput
            id={`${formId}-name`}
            value={name}
            disabled={Boolean(profile)}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="form-field">
          <span>Configuration JSON</span>
          <textarea
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
          <Button icon={Save} type="submit" variant="primary" disabled={busy || !name.trim()}>
            {profile ? "Save profile" : "Create profile"}
          </Button>
          {onCancel ? (
            <Button disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          {profile ? (
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
        title="Delete profile?"
        detail={`Delete the catalog profile ${profile?.name ?? ""}. Workflows that reference it may fail.`}
        confirmLabel="Delete profile"
        busy={busy}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void remove()}
      />
    </section>
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
      key: "tools",
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
        <h2>Validation</h2>
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

function DiagnosticsList({ diagnostics }: { diagnostics: AgentProfileDiagnostic[] }) {
  if (diagnostics.length === 0)
    return (
      <EmptyState title="No diagnostics" detail="The current profile passes catalog validation." />
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
  return value === null || value === undefined || value === ""
    ? "-"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
}
function formatDiagnostics(diagnostics: AgentProfileDiagnostic[]): string {
  return (
    diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ") ||
    "Profile validation failed."
  );
}
