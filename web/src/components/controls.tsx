import { AlertCircle, Loader2, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type Tone = "success" | "running" | "waiting" | "failed" | "info" | "neutral" | "future";

export function toneForStatus(status: string | null | undefined): Tone {
  switch (status) {
    case "finished":
    case "completed":
    case "available":
    case "enabled":
      return "success";
    case "running":
    case "continued":
      return "running";
    case "waiting-human":
    case "waiting-signal":
    case "waiting-timer":
    case "waiting-approval":
    case "interrupted":
    case "agent_concurrency":
      return "waiting";
    case "failed":
    case "cancelled":
    case "missing":
    case "error":
    case "parse-error":
      return "failed";
    case "stalled_no_heartbeat":
      return "failed";
    default:
      return "neutral";
  }
}

export function StatusPill({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span className={`pill pill-${tone}`}>
      {dot ? <span className="pill-dot" /> : null}
      {children}
    </span>
  );
}

export function Button({
  icon: Icon,
  children,
  variant = "secondary",
  size = "md",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  variant?: "primary" | "secondary" | "subtle" | "danger";
  size?: "sm" | "md";
}) {
  return (
    <button className={`btn btn-${variant} btn-${size}`} type="button" {...props}>
      {Icon ? <Icon size={15} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button className="icon-btn" type="button" aria-label={label} title={label} {...props}>
      <Icon size={16} />
    </button>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className="field-input" {...props} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="field-input field-select" {...props} />;
}

export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" />
      <span className="toggle-label">{label}</span>
    </label>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange(id: T): void;
}) {
  return (
    <div className="tabs tabs-line">
      {tabs.map((tab) => (
        <button
          className={`tab ${active === tab.id ? "is-active" : ""}`}
          type="button"
          key={tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state state-loading">
      <Loader2 size={16} className="spin" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="state">
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <AlertCircle size={17} />
      <div>
        <strong>{error.message}</strong>
        {onRetry ? (
          <button className="inline-link" type="button" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function KeyValueList({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode; mono?: boolean }>;
}) {
  return (
    <dl className="kv-list">
      {rows.map((row) => (
        <div className="kv-row" key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.mono ? "mono" : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="code-block">{JSON.stringify(value, null, 2)}</pre>;
}

export function formatTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return new Date(value).toLocaleString();
}

export function formatDuration(
  start: number | null | undefined,
  end: number | null | undefined,
): string {
  if (!start) return "-";
  const duration = Math.max(0, (end ?? Date.now()) - start);
  const seconds = Math.floor(duration / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
