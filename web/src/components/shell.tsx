import {
  Activity,
  CalendarClock,
  CheckSquare,
  FolderGit2,
  KeyRound,
  type LucideIcon,
  RefreshCw,
  Search,
  Server,
  Settings,
  UserCog,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import type { HealthResponse } from "../api/types";
import { IconButton, StatusPill } from "./controls";

export type NavRoute =
  | "runs"
  | "approvals"
  | "workflows"
  | "workspaces"
  | "schedules"
  | "profiles"
  | "settings"
  | "system";

const NAV: Array<{ id: NavRoute; label: string; href: string; icon: LucideIcon }> = [
  { id: "runs", label: "Runs", href: "#/runs", icon: Activity },
  { id: "approvals", label: "Approvals", href: "#/approvals", icon: CheckSquare },
  { id: "workflows", label: "Workflows", href: "#/workflows", icon: Workflow },
  { id: "workspaces", label: "Workspaces", href: "#/workspaces", icon: FolderGit2 },
  { id: "schedules", label: "Schedules", href: "#/schedules", icon: CalendarClock },
  { id: "profiles", label: "Profiles", href: "#/profiles", icon: UserCog },
  { id: "settings", label: "Settings", href: "#/settings", icon: Settings },
  { id: "system", label: "System", href: "#/system", icon: Server },
];

export function AppShell({
  route,
  title,
  subtitle,
  health,
  credential,
  search,
  searchEnabled = true,
  onCredentialChange,
  onSearchChange,
  onRefresh,
  children,
}: {
  route: NavRoute;
  title: ReactNode;
  subtitle?: ReactNode;
  health: HealthResponse | null;
  credential: string;
  search: string;
  searchEnabled?: boolean;
  onCredentialChange(value: string): void;
  onSearchChange(value: string): void;
  onRefresh(): void;
  children: ReactNode;
}) {
  const daemonReachable = health?.daemon.reachable === true;

  return (
    <div className="app">
      <aside className="nav">
        <a className="nav-brand" href="#/runs">
          <span className="logo-mark">K</span>
          <span>
            <span className="nav-brand-name">Keel</span>
            <span className="nav-brand-sub">operator console</span>
          </span>
        </a>
        <div className="realm-switch">
          <span className={`realm-dot ${daemonReachable ? "is-online" : "is-offline"}`} />
          <span>
            <span className="realm-name">local daemon</span>
            <span className="realm-sub">{daemonReachable ? "reachable" : "unreachable"}</span>
          </span>
        </div>
        <nav className="nav-groups" aria-label="Primary">
          <div className="nav-group">
            <div className="nav-group-label">Operate</div>
            {NAV.slice(0, 5).map((item) => (
              <NavItem active={route === item.id} key={item.id} {...item} />
            ))}
          </div>
          <div className="nav-group">
            <div className="nav-group-label">Configure</div>
            {NAV.slice(5).map((item) => (
              <NavItem active={route === item.id} key={item.id} {...item} />
            ))}
          </div>
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-main">
            <h1>{title}</h1>
            {subtitle ? <div className="topbar-subtitle">{subtitle}</div> : null}
          </div>
          {searchEnabled ? (
            <label className="search-box">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search"
                aria-label="Search"
              />
            </label>
          ) : null}
          <label className="credential-box">
            <KeyRound size={15} />
            <input
              value={credential}
              onChange={(event) => onCredentialChange(event.target.value)}
              placeholder="Bearer token"
              type="password"
              aria-label="Bearer token"
            />
          </label>
          <StatusPill tone={daemonReachable ? "success" : "failed"} dot>
            {daemonReachable ? "daemon" : "offline"}
          </StatusPill>
          <IconButton icon={RefreshCw} label="Refresh" onClick={onRefresh} />
        </header>
        <section className="content">{children}</section>
      </main>
    </div>
  );
}

function NavItem({
  id,
  label,
  href,
  icon: Icon,
  active,
}: {
  id: NavRoute;
  label: string;
  href: string;
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <a className={`nav-item ${active ? "is-active" : ""}`} href={href} data-route={id}>
      <Icon size={16} />
      <span>{label}</span>
    </a>
  );
}
