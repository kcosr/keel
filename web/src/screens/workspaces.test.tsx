import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelWebClient } from "../api/client";
import type { RunWorkspaceDiff, RunWorkspaceView } from "../api/types";
import { WorkspacesScreen } from "./workspaces";

describe("WorkspacesScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("disables workspace mutations when admin authority is absent", async () => {
    const client = {
      listWorkspaces: async () => ({
        workspaces: [workspace()],
        mutationAuthority: "admin",
        mutationAuthorized: false,
      }),
      getRunWorkspace: vi.fn(async () => workspace()),
      getRunWorkspaceDiff: vi.fn(async () => diff()),
      mergeRunWorkspace: vi.fn(),
      discardRunWorkspace: vi.fn(),
      gcWorkspaces: vi.fn(),
    } as unknown as KeelWebClient;

    render(<WorkspacesScreen client={client} refreshKey={0} />);

    await screen.findByText("ws_agent");
    const merge = await screen.findByRole("button", { name: "Merge" });
    const discard = screen.getByRole("button", { name: "Discard" });
    const gc = screen.getByRole("button", { name: "GC" });

    expect(merge).toBeDisabled();
    expect(discard).toBeDisabled();
    expect(gc).toBeDisabled();
    fireEvent.click(merge);
    fireEvent.click(discard);
    fireEvent.click(gc);

    expect(client.mergeRunWorkspace).not.toHaveBeenCalled();
    expect(client.discardRunWorkspace).not.toHaveBeenCalled();
    expect(client.gcWorkspaces).not.toHaveBeenCalled();
    expect(screen.getByText(/workspace mutation requires admin authority/i)).toBeInTheDocument();
  });

  test("loads retained diffs and confirms admin workspace mutations", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = {
      listWorkspaces: vi.fn(async () => ({
        workspaces: [workspace()],
        mutationAuthority: "admin",
        mutationAuthorized: true,
      })),
      getRunWorkspace: vi.fn(async () => workspace()),
      getRunWorkspaceDiff: vi.fn(async () => diff()),
      mergeRunWorkspace: vi.fn(async () => ({ ...workspace(), status: "merged" })),
      discardRunWorkspace: vi.fn(async () => ({ ...workspace(), status: "discarded" })),
      gcWorkspaces: vi.fn(async () => ({ removed: [workspace()] })),
    } as unknown as KeelWebClient;

    render(<WorkspacesScreen client={client} refreshKey={0} />);

    await screen.findByText("src/app.ts");
    expect(screen.getByText("+new line")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByText("git-patch from HEAD to /tmp/ws")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(client.mergeRunWorkspace).toHaveBeenCalledWith("run_1", "ws_agent"));

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(client.discardRunWorkspace).toHaveBeenCalledWith("run_1", "ws_agent"),
    );

    fireEvent.click(screen.getByRole("button", { name: "GC" }));
    await waitFor(() => expect(client.gcWorkspaces).toHaveBeenCalledWith());
    expect(window.confirm).toHaveBeenCalledTimes(3);
  });

  test("uses the selected row while fresh workspace detail is loading", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const first = workspace("ws_a", "agent-a", 3);
    const second = workspace("ws_b", "agent-b", 2);
    const client = {
      listWorkspaces: vi.fn(async () => ({
        workspaces: [first, second],
        mutationAuthority: "admin",
        mutationAuthorized: true,
      })),
      getRunWorkspace: vi.fn(async (_runId: string, workspaceId: string) =>
        workspaceId === "ws_b" ? second : first,
      ),
      getRunWorkspaceDiff: vi.fn(async (_runId: string, workspaceId: string) =>
        diff(workspaceId === "ws_b" ? second : first),
      ),
      mergeRunWorkspace: vi.fn(async (_runId: string, workspaceId: string) =>
        workspaceId === "ws_b" ? second : first,
      ),
      discardRunWorkspace: vi.fn(),
      gcWorkspaces: vi.fn(async () => ({ removed: [] })),
    } as unknown as KeelWebClient;

    render(<WorkspacesScreen client={client} refreshKey={0} />);

    await screen.findByText("agent-a");
    await screen.findByText("src/app.ts");
    fireEvent.click(screen.getByText("agent-b"));
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(client.mergeRunWorkspace).toHaveBeenCalledWith("run_1", "ws_b"));
  });
});

function workspace(workspaceId = "ws_agent", key = "agent", updatedAtMs = 2): RunWorkspaceView {
  return {
    runId: "run_1",
    workspaceId,
    mode: "worktree",
    ownerKind: "agent",
    key,
    lastAttempt: null,
    retentionPolicy: null,
    workspacePath: "/tmp/ws",
    setupStatus: "none",
    setupIdentityHash: null,
    setupStartedAtMs: null,
    setupFinishedAtMs: null,
    setupError: null,
    sourceKind: "worktree-git",
    sourcePath: "/repo",
    sourceUri: null,
    sourceBare: null,
    sourceMergeEligible: true,
    suppliedPath: null,
    sourceRef: null,
    resolvedRef: null,
    checkoutBranch: null,
    baseCommit: "HEAD",
    copyBaselinePath: null,
    owned: true,
    status: "pending_review",
    failureSeen: false,
    lastTurnKey: null,
    lastTurnAttempt: null,
    activeHolderKind: null,
    activeHolderKey: null,
    activeHolderAttempt: null,
    activeStartedAtMs: null,
    lastDiffEventSeq: null,
    lastErrorEventSeq: null,
    cleanupError: null,
    mergeSupported: true,
    discardSupported: true,
    diffSupported: true,
    createdAtMs: 1,
    updatedAtMs,
    mergedAtMs: null,
    discardedAtMs: null,
    removedAtMs: null,
  };
}

function diff(workspaceView = workspace()): RunWorkspaceDiff {
  return {
    workspace: workspaceView,
    modified: ["src/app.ts"],
    added: [],
    deleted: [],
    omittedPathCounts: { modified: 0, added: 0, deleted: 0 },
    pathLimit: 100,
    contentDiff: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old line\n+new line\n",
    mode: "worktree",
    diffKind: "git-patch",
    baseLabel: "HEAD",
    workspaceLabel: "/tmp/ws",
    fileChanges: [{ path: "src/app.ts", status: "modified", textDiffIncluded: true }],
  };
}
