import {
  GitFork,
  type LucideIcon,
  MoreHorizontal,
  Pause,
  Play,
  Repeat2,
  RotateCcw,
  Send,
  StepBack,
  X,
} from "lucide-react";
import { type FormEvent, useMemo, useRef, useState } from "react";
import type { KeelWebClient } from "../api/client";
import type { RunActionName, RunProjection } from "../api/types";
import { useModalFocus } from "../hooks/use-modal-focus";
import { Button, IconButton, Select, StatusPill, TextInput } from "./controls";

type RunActionId = "resume" | "interrupt" | "retry" | "rerun" | "rewind" | "fork" | "signal";

interface RunActionDefinition {
  id: RunActionId;
  label: string;
  icon: LucideIcon;
  authority: string;
  description: string;
  eligible: boolean;
  authorized: boolean;
  unavailableReason: string | null;
}

export function RunActions({
  client,
  run,
  authorization,
  onChanged,
}: {
  client: KeelWebClient;
  run: RunProjection;
  authorization: Record<RunActionName, boolean>;
  onChanged(): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [selected, setSelected] = useState<RunActionId | null>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const actions = useMemo(() => actionDefinitions(run, authorization), [run, authorization]);
  const primary = primaryAction(actions, run);

  return (
    <div className="run-actions">
      {primary ? (
        <Button
          icon={primary.icon}
          variant="primary"
          size="sm"
          onClick={() => setSelected(primary.id)}
        >
          {primary.label}
        </Button>
      ) : null}
      <div className="action-menu-wrap">
        <Button
          ref={actionsButtonRef}
          icon={MoreHorizontal}
          size="sm"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          Actions
        </Button>
        {menuOpen ? (
          <div className="action-menu" role="menu">
            {actions.map((action) => (
              <button
                type="button"
                role="menuitem"
                className="action-menu-item"
                disabled={!action.eligible || !action.authorized}
                title={action.unavailableReason ?? undefined}
                key={action.id}
                onClick={() => {
                  setSelected(action.id);
                  setMenuOpen(false);
                }}
              >
                <action.icon size={15} />
                <span>
                  <strong>{action.label}</strong>
                  <small>
                    {!action.authorized
                      ? `Requires ${action.authority} authority.`
                      : (action.unavailableReason ?? action.description)}
                  </small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {selected ? (
        <RunActionDialog
          action={actions.find((action) => action.id === selected) as RunActionDefinition}
          client={client}
          run={run}
          returnFocusRef={actionsButtonRef}
          onClose={() => setSelected(null)}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}

function RunActionDialog({
  action,
  client,
  run,
  returnFocusRef,
  onClose,
  onChanged,
}: {
  action: RunActionDefinition;
  client: KeelWebClient;
  run: RunProjection;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onClose(): void;
  onChanged(): void;
}) {
  const [reason, setReason] = useState("");
  const [stableKey, setStableKey] = useState(run.nodes.at(-1)?.stableKey ?? "");
  const [signalName, setSignalName] = useState("");
  const [payloadText, setPayloadText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalFocus<HTMLDialogElement>({
    open: true,
    closeDisabled: pending,
    returnFocusRef,
    onClose,
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      switch (action.id) {
        case "resume":
          await client.resumeRun(run.runId);
          break;
        case "interrupt":
          await client.interruptRun(run.runId, reason.trim() || undefined);
          break;
        case "retry":
          await client.retryRun(run.runId);
          break;
        case "rerun":
          await client.rerunRun(run.runId);
          break;
        case "rewind":
          if (!stableKey) throw new Error("Select a step to rewind to.");
          await client.rewindRun(run.runId, stableKey);
          break;
        case "fork": {
          const result = await client.forkRun(run.runId, stableKey || undefined);
          onClose();
          window.location.hash = `#/runs/${encodeURIComponent(result.runId)}`;
          return;
        }
        case "signal":
          if (!signalName.trim()) throw new Error("Signal name is required.");
          await client.sendSignal(
            run.runId,
            signalName.trim(),
            payloadText.trim() ? JSON.parse(payloadText) : null,
          );
          break;
      }
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !pending && onClose()}>
      <dialog
        ref={dialogRef}
        open
        className="dialog run-action-dialog"
        aria-modal="true"
        aria-labelledby="run-action-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <h2 id="run-action-title">{action.label} run</h2>
            <p>{action.description}</p>
          </div>
          <IconButton icon={X} label="Close" disabled={pending} onClick={onClose} />
        </div>
        <form className="dialog-body" onSubmit={submit}>
          <div className="action-dialog-meta">
            <code>{run.runId}</code>
            <StatusPill tone="info">{action.authority}</StatusPill>
          </div>
          {action.id === "interrupt" ? (
            <label className="form-field" htmlFor="interrupt-reason">
              <span>Reason</span>
              <textarea
                id="interrupt-reason"
                className="field-textarea"
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Optional operator note"
              />
            </label>
          ) : null}
          {action.id === "rewind" || action.id === "fork" ? (
            <label className="form-field" htmlFor="run-action-step">
              <span>{action.id === "rewind" ? "Rewind to step" : "Fork after step"}</span>
              <Select
                id="run-action-step"
                value={stableKey}
                onChange={(event) => setStableKey(event.target.value)}
              >
                {action.id === "fork" ? <option value="">Entire run</option> : null}
                {run.nodes.map((node) => (
                  <option value={node.stableKey} key={`${node.stableKey}:${node.attempt}`}>
                    {node.stableKey}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {action.id === "signal" ? (
            <>
              <label className="form-field" htmlFor="signal-name">
                <span>Signal name</span>
                <TextInput
                  id="signal-name"
                  value={signalName}
                  onChange={(event) => setSignalName(event.target.value)}
                />
              </label>
              <label className="form-field" htmlFor="signal-payload">
                <span>Payload JSON</span>
                <textarea
                  id="signal-payload"
                  className="field-textarea mono"
                  rows={4}
                  value={payloadText}
                  onChange={(event) => setPayloadText(event.target.value)}
                  placeholder="null"
                />
              </label>
            </>
          ) : null}
          {action.id === "retry" || action.id === "rerun" || action.id === "rewind" ? (
            <p className="dialog-note">
              Browser controls do not send run secrets. Use the CLI when this run requires secret
              reinjection.
            </p>
          ) : null}
          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
          <div className="dialog-actions">
            <span className="dialog-actions-spacer" />
            <Button disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={pending}>
              {pending ? `${action.label} in progress` : action.label}
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function actionDefinitions(
  run: RunProjection,
  authorization: Record<RunActionName, boolean>,
): RunActionDefinition[] {
  const terminal = ["finished", "failed", "cancelled", "continued"].includes(run.status);
  const interrupted = run.status === "interrupted";
  const waitingSignal = run.status === "waiting-signal";
  return [
    definition(
      "resume",
      "Resume",
      Play,
      "run:resume",
      "Continue this interrupted run.",
      interrupted,
      "Resume is available only for interrupted runs.",
      authorization.resume,
    ),
    definition(
      "interrupt",
      "Interrupt",
      Pause,
      "run:interrupt",
      "Stop active work and park the run until it is resumed.",
      !terminal && !interrupted,
      terminal ? "Terminal runs cannot be interrupted." : "This run is already interrupted.",
      authorization.interrupt,
    ),
    definition(
      "retry",
      "Retry failed step",
      RotateCcw,
      "run:retry",
      "Retry from the failed step while replaying completed upstream work.",
      run.status === "failed",
      "Retry is available only for failed runs.",
      authorization.retry,
    ),
    definition(
      "rerun",
      "Rerun",
      Repeat2,
      "run:retry",
      "Re-execute this run using its stored source and input.",
      terminal,
      "Rerun is available after the run reaches a terminal state.",
      authorization.rerun,
    ),
    definition(
      "rewind",
      "Rewind",
      StepBack,
      "run:rewind",
      "Discard journal state after a selected step and execute again.",
      terminal && run.nodes.length > 0,
      terminal ? "No recorded steps are available." : "Rewind is available for terminal runs.",
      authorization.rewind,
    ),
    definition(
      "fork",
      "Fork",
      GitFork,
      "run:fork",
      "Create a new independent run from this run's durable history.",
      terminal,
      "Fork is available for terminal runs.",
      authorization.fork,
    ),
    definition(
      "signal",
      "Send signal",
      Send,
      "run:signal",
      "Deliver a named durable signal and wake the run when eligible.",
      waitingSignal,
      "Signal delivery is available when the run is waiting for a signal.",
      authorization.signal,
    ),
  ];
}

function definition(
  id: RunActionId,
  label: string,
  icon: LucideIcon,
  authority: string,
  description: string,
  eligible: boolean,
  unavailableReason: string | null = null,
  authorized = false,
): RunActionDefinition {
  return { id, label, icon, authority, description, eligible, unavailableReason, authorized };
}

function primaryAction(
  actions: RunActionDefinition[],
  run: RunProjection,
): RunActionDefinition | null {
  const preferred: RunActionId | null =
    run.status === "interrupted"
      ? "resume"
      : run.status === "failed"
        ? "retry"
        : run.status === "waiting-signal"
          ? "signal"
          : run.status === "running"
            ? "interrupt"
            : null;
  return preferred
    ? (actions.find((action) => action.id === preferred && action.eligible && action.authorized) ??
        null)
    : null;
}
