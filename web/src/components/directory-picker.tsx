import { ArrowUp, Check, Folder, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeelWebClient } from "../api/client";
import type { BrowseDirectoriesResult } from "../api/types";
import { useModalFocus } from "../hooks/use-modal-focus";
import {
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  LoadingState,
  TextInput,
  Toggle,
} from "./controls";

export function DirectoryPickerField({
  client,
  id,
  label,
  value,
  placeholder,
  disabled = false,
  onChange,
}: {
  client: KeelWebClient;
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="form-field">
      <label htmlFor={id}>
        <span>{label}</span>
      </label>
      <div className="directory-field-row">
        <TextInput
          id={id}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
        />
        <IconButton
          ref={triggerRef}
          icon={FolderOpen}
          label={`Browse ${label.toLowerCase()}`}
          disabled={disabled}
          onClick={() => setOpen(true)}
        />
      </div>
      <DirectoryPickerDialog
        client={client}
        open={open}
        initialPath={value.trim() || "~"}
        returnFocusRef={triggerRef}
        onClose={() => setOpen(false)}
        onSelect={(path) => {
          onChange(path);
          setOpen(false);
        }}
      />
    </div>
  );
}

export function DirectoryPickerDialog({
  client,
  open,
  initialPath,
  returnFocusRef,
  onClose,
  onSelect,
}: {
  client: KeelWebClient;
  open: boolean;
  initialPath: string;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose(): void;
  onSelect(path: string): void;
}) {
  const titleId = useId();
  const [address, setAddress] = useState(initialPath);
  const [result, setResult] = useState<BrowseDirectoriesResult | null>(null);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestId = useRef(0);
  const dialogRef = useModalFocus<HTMLDialogElement>({ open, returnFocusRef, onClose });

  const browse = useCallback(
    async (path: string) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const next = await client.browseDirectories(path);
        if (id !== requestId.current) return;
        setResult(next);
        setAddress(next.path);
        setFilter("");
      } catch (err) {
        if (id !== requestId.current) return;
        setResult(null);
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (!open) return;
    setAddress(initialPath);
    setResult(null);
    setFilter("");
    setShowHidden(false);
    void browse(initialPath);
  }, [browse, initialPath, open]);

  const entries = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (result?.entries ?? []).filter(
      (entry) =>
        (showHidden || !entry.name.startsWith(".")) &&
        (!needle || entry.name.toLowerCase().includes(needle)),
    );
  }, [filter, result, showHidden]);

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim()) void browse(address.trim());
  };

  if (!open) return null;
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <dialog
        ref={dialogRef}
        open
        className="dialog directory-dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header directory-dialog-header">
          <div>
            <div className="directory-dialog-title">
              <FolderOpen size={18} />
              <h2 id={titleId}>Select directory</h2>
            </div>
            <p>Browse directories available to the Keel daemon.</p>
          </div>
          <IconButton icon={X} label="Close directory picker" onClick={onClose} />
        </div>
        <div className="directory-dialog-body">
          <form className="directory-address-row" onSubmit={submitAddress}>
            <IconButton
              icon={ArrowUp}
              label="Parent directory"
              disabled={!result?.parentPath || loading}
              onClick={() => result?.parentPath && void browse(result.parentPath)}
            />
            <TextInput
              value={address}
              aria-label="Directory path"
              spellCheck={false}
              autoFocus
              onChange={(event) => setAddress(event.target.value)}
            />
            <Button size="sm" type="submit" disabled={!address.trim() || loading}>
              Go
            </Button>
            <IconButton
              icon={RefreshCw}
              label="Refresh directories"
              disabled={!result || loading}
              onClick={() => result && void browse(result.path)}
            />
          </form>
          <div className="directory-filter-row">
            <div className="directory-filter-input">
              <Search size={14} />
              <TextInput
                value={filter}
                aria-label="Filter directories"
                placeholder="Filter directories"
                disabled={!result}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            <Toggle label="Show hidden" checked={showHidden} onChange={setShowHidden} />
          </div>
          <div className="directory-list" aria-busy={loading}>
            {loading ? <LoadingState label="Loading directories" /> : null}
            {!loading && error ? (
              <ErrorState error={error} onRetry={() => void browse(address)} />
            ) : null}
            {!loading && !error && result && entries.length === 0 ? (
              <EmptyState
                title={filter ? "No matching directories" : "No child directories"}
                detail={filter ? "Clear the filter to see every directory." : undefined}
              />
            ) : null}
            {!loading && !error
              ? entries.map((entry) => (
                  <button
                    className="directory-entry"
                    type="button"
                    aria-label={`Open ${entry.name}`}
                    key={entry.path}
                    onClick={() => void browse(entry.path)}
                  >
                    <Folder size={17} />
                    <span>{entry.name}</span>
                  </button>
                ))
              : null}
          </div>
          {result?.truncated ? (
            <p className="directory-limit-note">
              This directory contains more entries than can be displayed. Refine the path.
            </p>
          ) : null}
          <div className="dialog-actions directory-dialog-actions">
            <div className="directory-selection-path mono" title={result?.path}>
              {result?.path ?? "No directory loaded"}
            </div>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              icon={Check}
              variant="primary"
              disabled={!result || loading}
              onClick={() => result && onSelect(result.path)}
            >
              Select
            </Button>
          </div>
        </div>
      </dialog>
    </div>,
    document.body,
  );
}
