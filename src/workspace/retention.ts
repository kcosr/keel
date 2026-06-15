import { existsSync } from "node:fs";
import type { JournalStore } from "../journal/store.ts";
import type {
  AgentWorkspaceRow,
  AgentWorkspaceStatus,
  RunStatus,
  WorkspaceRetention,
} from "../journal/types.ts";
import { removeManagedWorkspace } from "./worktree.ts";

export const DEFAULT_WORKSPACE_RETENTION: WorkspaceRetention = "remove";
export const WORKSPACE_RETENTIONS: readonly WorkspaceRetention[] = [
  "remove",
  "retain-on-failure",
  "retain",
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
  if (value === "remove" || value === "retain-on-failure" || value === "retain") return value;
  throw new Error(`workspace retention must be one of ${WORKSPACE_RETENTIONS.join(", ")}`);
}

export function workspaceShouldRetain(row: AgentWorkspaceRow, terminalStatus: RunStatus): boolean {
  if (!row.owned) return true;
  if (row.retentionPolicy === "retain") return true;
  if (row.retentionPolicy === "remove") return false;
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
  for (const row of store.listAgentWorkspaces(runId, { includeRemoved: true })) {
    cleanupTerminalWorkspace(store, row, terminalStatus, atMs);
  }
}

export function cleanupTerminalWorkspace(
  store: JournalStore,
  row: AgentWorkspaceRow,
  terminalStatus: RunStatus,
  atMs: number,
): void {
  if (!row.owned) return;
  if (row.status === "merged" || row.status === "discarded" || row.status === "removed") return;
  if (workspaceShouldRetain(row, terminalStatus)) {
    if (RUN_LIFETIME_STATUSES.has(row.status)) {
      store.updateAgentWorkspace(row.runId, row.workspaceId, {
        status: existsSync(row.workspacePath) ? "pending_review" : "abandoned",
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        updatedAtMs: atMs,
      });
    }
    return;
  }
  try {
    removeManagedWorkspace({
      mode: row.mode as "worktree" | "copy" | "clone",
      sourcePath: row.sourcePath,
      workspacePath: row.workspacePath,
      baseCommit: row.baseCommit,
      copyBaselinePath: row.copyBaselinePath,
    });
    store.transaction(() => {
      store.updateAgentWorkspace(row.runId, row.workspaceId, {
        status: "removed",
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        removedAtMs: atMs,
        updatedAtMs: atMs,
      });
      store.appendEvent(
        row.runId,
        "workspace.removed",
        {
          workspaceId: row.workspaceId,
          mode: row.mode,
          ownerKind: row.ownerKind,
          key: row.key,
          workspacePath: row.workspacePath,
          sourcePath: row.sourcePath,
          copyBaselinePath: row.copyBaselinePath,
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
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        updatedAtMs: atMs,
      });
      store.appendEvent(
        row.runId,
        "workspace.cleanup_error",
        {
          workspaceId: row.workspaceId,
          mode: row.mode,
          ownerKind: row.ownerKind,
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
