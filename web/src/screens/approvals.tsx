import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import type { KeelWebClient } from "../api/client";
import type { ApprovalView } from "../api/types";
import {
  Button,
  CommandCopyButton,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusPill,
  formatTime,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { Inspector } from "../components/inspector";
import { useAsync } from "../hooks/use-async";

export function ApprovalsScreen({
  client,
  refreshKey,
}: { client: KeelWebClient; refreshKey: number }) {
  const state = useAsync(() => client.listApprovals(), [client, refreshKey]);
  const approvals = state.data?.approvals ?? [];
  const decisionAuthorized = state.data?.decisionAuthorized === true;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [actionPending, setActionPending] = useState<"approved" | "denied" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  useEffect(() => {
    if (selectedKey && approvals.some((approval) => approvalKey(approval) === selectedKey)) return;
    setSelectedKey(approvals[0] ? approvalKey(approvals[0]) : null);
  }, [approvals, selectedKey]);
  const selected = approvals.find((approval) => approvalKey(approval) === selectedKey) ?? null;
  const canDecide =
    decisionAuthorized && selected?.gateId !== null && selected?.gateId !== undefined;

  const decide = async (status: "approved" | "denied") => {
    if (!selected?.gateId || !canDecide || actionPending) return;
    setActionPending(status);
    setActionError(null);
    setActionMessage(null);
    try {
      await client.decideApproval(selected.runId, selected.gateId, {
        status,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNote("");
      setActionMessage(`${status === "approved" ? "Approved" : "Denied"} ${selected.gateId}`);
      state.reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setActionPending(null);
    }
  };

  return (
    <div className="content-split">
      <div className="content-scroll">
        <div className="notice-panel">
          Current workflow-authored <code>ctx.human</code> gates only. Provider-native tool,
          sandbox, and network approvals are not shown here.
        </div>
        {state.loading ? <LoadingState label="Loading approvals" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error ? (
          <DenseTable
            rows={approvals}
            rowKey={approvalKey}
            selectedKey={selectedKey}
            onRowClick={(approval) => setSelectedKey(approvalKey(approval))}
            empty={<EmptyState title="No approvals waiting" />}
            columns={approvalColumns()}
          />
        ) : null}
      </div>
      <Inspector title="Decision" subtitle={selected?.runName ?? selected?.runId ?? "No approval"}>
        {selected ? (
          <>
            <p>{selected.prompt}</p>
            <dl className="kv-list">
              <div className="kv-row">
                <dt>Run</dt>
                <dd className="mono">{selected.runId}</dd>
              </div>
              <div className="kv-row">
                <dt>Gate</dt>
                <dd className="mono">{selected.gateId ?? "-"}</dd>
              </div>
              <div className="kv-row">
                <dt>Authority</dt>
                <dd>{selected.requiredAuthority}</dd>
              </div>
            </dl>
            <div className="command-copy-grid">
              <CommandCopyButton
                label="Copy approve command"
                command={selected.cli ?? approveCliFallback(selected)}
                disabled={!selected.gateId}
                detail={selected.gateId ? null : "Gate key unavailable"}
              />
              <CommandCopyButton
                label="Copy deny command"
                command={denyCli(selected) ?? `keel deny ${selected.runId} <gate>`}
                disabled={!selected.gateId}
                detail={selected.gateId ? null : "Gate key unavailable"}
              />
            </div>
            <textarea
              className="field-textarea"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Decision note"
              aria-label="Decision note"
            />
            {!decisionAuthorized ? (
              <p className="muted">
                Requires admin authority. Use the copied CLI equivalent with an admin credential.
              </p>
            ) : null}
            {selected.gateId ? null : (
              <p className="muted">The daemon did not expose a gate key for this approval.</p>
            )}
            {actionError ? <p className="form-error">{actionError}</p> : null}
            {actionMessage ? <p className="form-success">{actionMessage}</p> : null}
            <div className="btn-row">
              <Button
                icon={X}
                variant="danger"
                disabled={!canDecide || actionPending !== null}
                title={decisionTitle(canDecide, "deny")}
                onClick={() => void decide("denied")}
              >
                {actionPending === "denied" ? "Denying" : "Deny"}
              </Button>
              <Button
                icon={Check}
                variant="primary"
                disabled={!canDecide || actionPending !== null}
                title={decisionTitle(canDecide, "approve")}
                onClick={() => void decide("approved")}
              >
                {actionPending === "approved" ? "Approving" : "Approve"}
              </Button>
            </div>
          </>
        ) : (
          <EmptyState title="No approval selected" />
        )}
      </Inspector>
    </div>
  );
}

function approvalKey(approval: ApprovalView): string {
  return `${approval.runId}:${approval.gateId ?? "gate"}`;
}

function denyCli(approval: ApprovalView): string | null {
  return approval.gateId ? `keel deny ${approval.runId} ${approval.gateId}` : null;
}

function approveCliFallback(approval: ApprovalView): string {
  return approval.gateId
    ? `keel approve ${approval.runId} ${approval.gateId}`
    : `keel approve ${approval.runId} <gate>`;
}

function decisionTitle(canDecide: boolean, action: "approve" | "deny"): string {
  return canDecide
    ? `${action === "approve" ? "Approve" : "Deny"} this ctx.human gate`
    : "Requires admin authority and a current gate key";
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function approvalColumns(): Array<Column<ApprovalView>> {
  return [
    {
      key: "run",
      header: "Run",
      render: (approval) => <span className="mono">{approval.runId}</span>,
    },
    { key: "prompt", header: "Prompt", render: (approval) => approval.prompt },
    {
      key: "gate",
      header: "Gate",
      width: "160px",
      render: (approval) => <span className="mono">{approval.gateId ?? "-"}</span>,
    },
    {
      key: "created",
      header: "Created",
      width: "190px",
      render: (approval) => formatTime(approval.createdAtMs),
    },
    {
      key: "auth",
      header: "Authority",
      width: "120px",
      render: () => <StatusPill tone="info">admin</StatusPill>,
    },
  ];
}
