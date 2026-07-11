import { AlertTriangle, X } from "lucide-react";
import { useEffect, useId } from "react";
import { Button, IconButton } from "./controls";

export function ConfirmDialog({
  open,
  title,
  detail,
  confirmLabel,
  busy = false,
  danger = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  detail: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  const titleId = useId();
  const detailId = useId();

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [busy, onClose, open]);

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={detailId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div className="confirm-dialog-title">
            <AlertTriangle size={18} />
            <h2 id={titleId}>{title}</h2>
          </div>
          <IconButton icon={X} label="Close" disabled={busy} onClick={onClose} />
        </div>
        <div className="dialog-body">
          <p id={detailId}>{detail}</p>
          <div className="dialog-actions">
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant={danger ? "danger" : "primary"}
              disabled={busy}
              autoFocus
              onClick={onConfirm}
            >
              {busy ? "Working..." : confirmLabel}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
