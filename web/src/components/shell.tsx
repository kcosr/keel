import {
  Activity,
  CalendarClock,
  CheckSquare,
  FolderGit2,
  KeyRound,
  type LucideIcon,
  Menu,
  RefreshCw,
  Server,
  Settings,
  UserCog,
  Workflow,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { HealthResponse } from "../api/types";
import { Button, IconButton, StatusPill } from "./controls";

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
  credentialSet,
  onCredentialApply,
  onCredentialClear,
  onRefresh,
  children,
}: {
  route: NavRoute;
  title: ReactNode;
  subtitle?: ReactNode;
  health: HealthResponse | null;
  credentialSet: boolean;
  onCredentialApply(value: string): void;
  onCredentialClear(): void;
  onRefresh(): void;
  children: ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const daemonReachable = health?.daemon.reachable === true;

  useEffect(() => {
    const closeNav = () => setNavOpen(false);
    window.addEventListener("hashchange", closeNav);
    return () => window.removeEventListener("hashchange", closeNav);
  }, []);

  return (
    <div className="app">
      <aside className={`nav ${navOpen ? "is-open" : ""}`} id="primary-navigation">
        <div className="nav-header">
          <a className="nav-brand" href="#/runs">
            <Brand />
          </a>
          <IconButton
            className="nav-close"
            icon={X}
            label="Close navigation"
            onClick={() => setNavOpen(false)}
          />
        </div>
        <nav className="nav-groups" aria-label="Primary">
          <div className="nav-group">
            <div className="nav-group-label">Operate</div>
            {NAV.slice(0, 5).map((item) => (
              <NavItem
                active={route === item.id}
                key={item.id}
                onNavigate={() => setNavOpen(false)}
                {...item}
              />
            ))}
          </div>
          <div className="nav-group">
            <div className="nav-group-label">Configure</div>
            {NAV.slice(5).map((item) => (
              <NavItem
                active={route === item.id}
                key={item.id}
                onNavigate={() => setNavOpen(false)}
                {...item}
              />
            ))}
          </div>
        </nav>
        <div className="nav-footer">
          <div className="connection-summary">
            <span className={`realm-dot ${daemonReachable ? "is-online" : "is-offline"}`} />
            <span>
              <span className="realm-name">Local daemon</span>
              <span className="realm-sub">{daemonReachable ? "Reachable" : "Unreachable"}</span>
            </span>
          </div>
          <button className="access-button" type="button" onClick={() => setAccessOpen(true)}>
            <KeyRound size={16} />
            <span>
              <strong>Access credential</strong>
              <small>{credentialSet ? "Configured for this session" : "No credential set"}</small>
            </span>
          </button>
        </div>
      </aside>
      {navOpen ? (
        <button
          className="nav-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <main className="main">
        <div className="mobile-appbar">
          <IconButton
            icon={Menu}
            label="Open navigation"
            aria-controls="primary-navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          />
          <a className="mobile-brand" href="#/runs">
            <Brand compact />
          </a>
          <IconButton
            icon={KeyRound}
            label="Manage access credential"
            onClick={() => setAccessOpen(true)}
          />
        </div>
        <header className="topbar">
          <div className="topbar-main">
            <h1>{title}</h1>
            {subtitle ? <div className="topbar-subtitle">{subtitle}</div> : null}
          </div>
          <div className="topbar-actions">
            <StatusPill tone={daemonReachable ? "success" : "failed"} dot>
              {daemonReachable ? "Daemon online" : "Daemon offline"}
            </StatusPill>
            {credentialSet ? <StatusPill tone="info">Credential set</StatusPill> : null}
            <IconButton icon={RefreshCw} label="Refresh" onClick={onRefresh} />
          </div>
        </header>
        <section className="content">{children}</section>
      </main>
      <AccessDialog
        open={accessOpen}
        credentialSet={credentialSet}
        onClose={() => setAccessOpen(false)}
        onApply={onCredentialApply}
        onClear={onCredentialClear}
      />
    </div>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <>
      <span className="logo-mark">K</span>
      <span>
        <span className="nav-brand-name">Keel</span>
        {compact ? null : <span className="nav-brand-sub">operator console</span>}
      </span>
    </>
  );
}

function NavItem({
  id,
  label,
  href,
  icon: Icon,
  active,
  onNavigate,
}: {
  id: NavRoute;
  label: string;
  href: string;
  icon: LucideIcon;
  active: boolean;
  onNavigate(): void;
}) {
  return (
    <a
      className={`nav-item ${active ? "is-active" : ""}`}
      href={href}
      data-route={id}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
    >
      <Icon size={16} />
      <span>{label}</span>
    </a>
  );
}

function AccessDialog({
  open,
  credentialSet,
  onClose,
  onApply,
  onClear,
}: {
  open: boolean;
  credentialSet: boolean;
  onClose(): void;
  onApply(value: string): void;
  onClear(): void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft("");
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    onApply(value);
    onClose();
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <dialog
        open
        className="dialog access-dialog"
        aria-modal="true"
        aria-labelledby="access-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <h2 id="access-dialog-title">Daemon access</h2>
            <p>Use a bearer capability for protected runs and administration.</p>
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <form className="dialog-body" onSubmit={submit}>
          <label className="form-field" htmlFor="access-credential">
            <span>Bearer credential</span>
            <input
              ref={inputRef}
              id="access-credential"
              className="field-input credential-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={credentialSet ? "Enter a replacement credential" : "kc_..."}
            />
          </label>
          <p className="dialog-note">
            Stored only in this browser tab session. Applying a credential refreshes the current
            view.
          </p>
          <div className="dialog-actions">
            {credentialSet ? (
              <Button
                variant="danger"
                onClick={() => {
                  onClear();
                  onClose();
                }}
              >
                Remove credential
              </Button>
            ) : null}
            <span className="dialog-actions-spacer" />
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={!draft.trim()}>
              Apply credential
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
