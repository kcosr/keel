import { Check, X } from "lucide-react";
import type { KeelWebClient } from "../api/client";
import type { ApprovalView } from "../api/types";
import {
  Button,
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
  const selected = approvals[0] ?? null;

  return (
    <div className="content-split">
      <div className="content-scroll">
        {state.loading ? <LoadingState label="Loading approvals" /> : null}
        {state.error ? <ErrorState error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error ? (
          <DenseTable
            rows={approvals}
            rowKey={(approval) => `${approval.runId}:${approval.gateId ?? "gate"}`}
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
                <dt>CLI</dt>
                <dd className="mono">{selected.cli ?? "-"}</dd>
              </div>
            </dl>
            <div className="btn-row">
              <Button icon={Check} variant="primary" disabled title="Requires admin authority">
                Approve
              </Button>
              <Button icon={X} variant="danger" disabled title="Requires admin authority">
                Deny
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
