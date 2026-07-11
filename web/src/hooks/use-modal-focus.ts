import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalFocus<T extends HTMLElement>({
  open,
  closeDisabled = false,
  returnFocusRef,
  onClose,
}: {
  open: boolean;
  closeDisabled?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const containerRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  const explicitReturnFocusRef = useRef(returnFocusRef);
  onCloseRef.current = onClose;
  closeDisabledRef.current = closeDisabled;
  explicitReturnFocusRef.current = returnFocusRef;

  useEffect(() => {
    if (!open) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = containerRef.current;
    if (!container) return;

    if (!container.contains(document.activeElement)) {
      (
        container.querySelector<HTMLElement>("[autofocus]") ??
        container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
        container
      ).focus();
    }

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!closeDisabledRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      const returnFocus = explicitReturnFocusRef.current?.current ?? previousFocus;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [open]);

  return containerRef;
}
