import { useEffect, useMemo, useState } from "react";
import { KeelWebClient } from "./api/client";
import type { HealthResponse } from "./api/types";
import { AppShell, type NavRoute } from "./components/shell";
import { useAsync } from "./hooks/use-async";
import { ApprovalsScreen } from "./screens/approvals";
import { ProfilesScreen } from "./screens/profiles";
import { RunDetailScreen } from "./screens/run-detail";
import { RunsScreen } from "./screens/runs";
import { SchedulesScreen } from "./screens/schedules";
import { SettingsScreen } from "./screens/settings";
import { SystemScreen } from "./screens/system";
import { WorkflowsScreen } from "./screens/workflows";
import { WorkspacesScreen } from "./screens/workspaces";

const CREDENTIAL_SESSION_KEY = "keel.web.credential";

type AppRoute =
  | { kind: "runs"; nav: "runs" }
  | { kind: "run-detail"; nav: "runs"; runId: string }
  | { kind: Exclude<NavRoute, "runs">; nav: Exclude<NavRoute, "runs"> };

const TITLES: Record<NavRoute, { title: string; subtitle: string }> = {
  runs: {
    title: "Runs",
    subtitle: "Live daemon run projections and blockers",
  },
  approvals: {
    title: "Approvals",
    subtitle: "Workflow-authored human gates",
  },
  workflows: {
    title: "Workflows",
    subtitle: "Saved workflow registry",
  },
  workspaces: {
    title: "Workspaces",
    subtitle: "Retained run workspace projections",
  },
  schedules: {
    title: "Schedules",
    subtitle: "Recurring saved workflow operations",
  },
  profiles: {
    title: "Profiles",
    subtitle: "Agent profile catalog",
  },
  settings: {
    title: "Settings",
    subtitle: "Daemon settings catalog",
  },
  system: {
    title: "System",
    subtitle: "Web transport and daemon status",
  },
};

export function App() {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.hash));
  const [credential, setCredential] = useState(
    () => sessionStorage.getItem(CREDENTIAL_SESSION_KEY) ?? "",
  );
  const [refreshKey, setRefreshKey] = useState(0);

  const client = useMemo(
    () =>
      new KeelWebClient({
        getCredential: () => credential.trim() || null,
      }),
    [credential],
  );
  const healthState = useAsync(() => client.health(), [client, refreshKey]);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const applyCredential = (value: string) => {
    setCredential(value);
    if (value.trim()) sessionStorage.setItem(CREDENTIAL_SESSION_KEY, value.trim());
    else sessionStorage.removeItem(CREDENTIAL_SESSION_KEY);
  };

  const clearCredential = () => applyCredential("");

  const nav = route.nav;
  const title = route.kind === "run-detail" ? "Run Detail" : TITLES[nav].title;
  const subtitle = route.kind === "run-detail" ? route.runId : TITLES[nav].subtitle;

  return (
    <AppShell
      route={nav}
      title={title}
      subtitle={subtitle}
      health={healthState.data}
      credentialSet={credential.trim().length > 0}
      onCredentialApply={applyCredential}
      onCredentialClear={clearCredential}
      onRefresh={() => setRefreshKey((value) => value + 1)}
    >
      {renderRoute(route, client, refreshKey, healthState.data)}
    </AppShell>
  );
}

function renderRoute(
  route: AppRoute,
  client: KeelWebClient,
  refreshKey: number,
  health: HealthResponse | null,
) {
  switch (route.kind) {
    case "runs":
      return <RunsScreen client={client} refreshKey={refreshKey} />;
    case "run-detail":
      return <RunDetailScreen client={client} runId={route.runId} refreshKey={refreshKey} />;
    case "approvals":
      return <ApprovalsScreen client={client} refreshKey={refreshKey} />;
    case "workflows":
      return <WorkflowsScreen client={client} refreshKey={refreshKey} />;
    case "workspaces":
      return <WorkspacesScreen client={client} refreshKey={refreshKey} />;
    case "schedules":
      return <SchedulesScreen client={client} refreshKey={refreshKey} />;
    case "profiles":
      return <ProfilesScreen client={client} refreshKey={refreshKey} />;
    case "settings":
      return <SettingsScreen client={client} refreshKey={refreshKey} />;
    case "system":
      return <SystemScreen client={client} health={health} refreshKey={refreshKey} />;
  }
}

function parseRoute(hash: string): AppRoute {
  const path = hash.replace(/^#\/?/, "").split("?", 1)[0] ?? "";
  const [section, detail] = path.split("/");
  if (section === "runs" && detail) {
    return { kind: "run-detail", nav: "runs", runId: decodeURIComponent(detail) };
  }
  if (section === "approvals") return { kind: "approvals", nav: "approvals" };
  if (section === "workflows") return { kind: "workflows", nav: "workflows" };
  if (section === "workspaces") return { kind: "workspaces", nav: "workspaces" };
  if (section === "schedules") return { kind: "schedules", nav: "schedules" };
  if (section === "profiles") return { kind: "profiles", nav: "profiles" };
  if (section === "settings") return { kind: "settings", nav: "settings" };
  if (section === "system") return { kind: "system", nav: "system" };
  return { kind: "runs", nav: "runs" };
}
