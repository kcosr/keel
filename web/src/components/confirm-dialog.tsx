import { AlertTriangle, X } from "lucide-react";
import { type RefObject, useEffect, useId, useRef } from "react";
import { useModalFocus } from "../hooks/use-modal-focus";
import { Button, IconButton } from "./controls";

export function ConfirmDialog({
  open,
  title,
  detail,
  confirmLabel,
  busy = false,
  danger = true,
  returnFocusRef,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  detail: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onConfirm(): void;
  onClose(): void;
}) {
  const titleId = useId();
  const detailId = useId();
  const confirmPendingRef = useRef(false);
  const dialogRef = useModalFocus<HTMLElement>({
    open,
    closeDisabled: busy,
    returnFocusRef,
    onClose,
  });

  useEffect(() => {
    if (!busy) confirmPendingRef.current = false;
  }, [busy]);

  const confirm = () => {
    if (confirmPendingRef.current || busy) return;
    confirmPendingRef.current = true;
    onConfirm();
  };

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section
        ref={dialogRef}
        className="dialog confirm-dialog"
        role="alertdialog"
        tabIndex={-1}
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
              onClick={confirm}
            >
              {busy ? "Working..." : confirmLabel}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
