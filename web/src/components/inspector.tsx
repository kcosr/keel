import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { type ReactNode, useState } from "react";

const COLLAPSE_KEY = "keel.web.inspector-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function Inspector({
  title,
  subtitle,
  status,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggle = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        if (next) localStorage.setItem(COLLAPSE_KEY, "1");
        else localStorage.removeItem(COLLAPSE_KEY);
      } catch {
        // best-effort persistence only
      }
      return next;
    });
  };

  return (
    <aside className={`inspector ${collapsed ? "is-collapsed" : ""}`}>
      <div className="inspector-header">
        <button
          className="inspector-toggle icon-btn"
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand details panel" : "Collapse details panel"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand details" : "Collapse details"}
        >
          {collapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
        </button>
        {collapsed ? null : (
          <>
            <div className="inspector-title-block">
              <h2>{title}</h2>
              {subtitle ? <div className="inspector-subtitle">{subtitle}</div> : null}
            </div>
            {status}
          </>
        )}
      </div>
      {collapsed ? null : <div className="inspector-body">{children}</div>}
      {collapsed || !footer ? null : <div className="inspector-footer">{footer}</div>}
    </aside>
  );
}
