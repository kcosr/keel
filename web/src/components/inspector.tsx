import type { ReactNode } from "react";

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
  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div className="inspector-title-block">
          <h2>{title}</h2>
          {subtitle ? <div className="inspector-subtitle">{subtitle}</div> : null}
        </div>
        {status}
      </div>
      <div className="inspector-body">{children}</div>
      {footer ? <div className="inspector-footer">{footer}</div> : null}
    </aside>
  );
}
