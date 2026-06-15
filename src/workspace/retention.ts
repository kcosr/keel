import { existsSync } from "node:fs";
import type { JournalStore } from "../journal/store.ts";
import type {
  AgentWorkspaceRow,
  AgentWorkspaceStatus,
  RunStatus,
  WorkspaceRetention,
} from "../journal/types.ts";
import { removeRetainedWorkspace } from "./worktree.ts";

export const DEFAULT_WORKSPACE_RETENTION: WorkspaceRetention = "never";
export const WORKSPACE_RETENTIONS: readonly WorkspaceRetention[] = [
  "never",
  "on-failure",
  "always",
];
export const RUN_TERMINAL_STATUSES = new Set<RunStatus>([
  "finished",
  "failed",
  "cancelled",
  "continued",
]);
export const RUN_FAILURE_STATUSES = new Set<RunStatus>(["failed", "cancelled"]);

const RUN_LIFETIME_STATUSES = new Set<AgentWorkspaceStatus>(["creating", "active", "idle"]);

export function validateWorkspaceRetention(value: unknown): WorkspaceRetention {
  if (value === "never" || value === "on-failure" || value === "always") return value;
  throw new Error(`workspaceRetention must be one of ${WORKSPACE_RETENTIONS.join(", ")}`);
}

export function resolveWorkspaceRetention(input: {
  workspaceIsolation: boolean;
  workspaceRetention?: unknown;
}): WorkspaceRetention | null {
  if (input.workspaceRetention !== undefined && !input.workspaceIsolation) {
    throw new Error("workspaceRetention requires workspaceIsolation: true");
  }
  if (!input.workspaceIsolation) return null;
  return input.workspaceRetention === undefined
    ? DEFAULT_WORKSPACE_RETENTION
    : validateWorkspaceRetention(input.workspaceRetention);
}

export function workspaceShouldRetain(row: AgentWorkspaceRow, terminalStatus: RunStatus): boolean {
  if (row.retentionPolicy === "always") return true;
  if (row.retentionPolicy === "never") return false;
  return (
    RUN_FAILURE_STATUSES.has(terminalStatus) ||
    row.failureSeen ||
    row.status === "diff_error" ||
    row.status === "abandoned" ||
    row.status === "cleanup_error" ||
    row.cleanupErrorJson !== null
  );
}

export function cleanupTerminalRunWorkspaces(
  store: JournalStore,
  runId: string,
  terminalStatus: RunStatus,
  atMs: number,
): void {
  if (!RUN_TERMINAL_STATUSES.has(terminalStatus)) return;
  for (const row of store.listAgentWorkspaces(runId)) {
    cleanupTerminalWorkspace(store, row, terminalStatus, atMs);
  }
}

export function cleanupTerminalWorkspace(
  store: JournalStore,
  row: AgentWorkspaceRow,
  terminalStatus: RunStatus,
  atMs: number,
): void {
  if (row.status === "merged" || row.status === "discarded" || row.status === "removed") return;
  if (workspaceShouldRetain(row, terminalStatus)) {
    if (RUN_LIFETIME_STATUSES.has(row.status)) {
      store.updateAgentWorkspace(row.runId, row.workspaceId, {
        status: existsSync(row.workspacePath) ? "pending_review" : "abandoned",
        updatedAtMs: atMs,
      });
    }
    return;
  }
  try {
    removeRetainedWorkspace(row.target, row.workspacePath, row.baseCommit);
    store.transaction(() => {
      store.updateAgentWorkspace(row.runId, row.workspaceId, {
        status: "removed",
        removedAtMs: atMs,
        updatedAtMs: atMs,
      });
      store.appendEvent(
        row.runId,
        "workspace.removed",
        {
          workspaceId: row.workspaceId,
          kind: row.kind,
          key: row.key,
          workspacePath: row.workspacePath,
          target: row.target,
        },
        atMs,
      );
    });
  } catch (err) {
    const errorJson = JSON.stringify(serializeError(err));
    store.transaction(() => {
      store.updateAgentWorkspace(row.runId, row.workspaceId, {
        status: "cleanup_error",
        cleanupErrorJson: errorJson,
        updatedAtMs: atMs,
      });
      store.appendEvent(
        row.runId,
        "workspace.cleanup_error",
        {
          workspaceId: row.workspaceId,
          kind: row.kind,
          key: row.key,
          workspacePath: row.workspacePath,
          error: JSON.parse(errorJson),
        },
        atMs,
      );
    });
  }
}

function serializeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}
