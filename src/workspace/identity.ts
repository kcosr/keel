import { canonicalJson, hashJson } from "../hash.ts";
import type {
  AgentWorkspaceOwnerKind,
  WorkspaceMode,
  WorkspaceRetention,
  WorkspaceSourceKind,
} from "../journal/types.ts";

export const DEFAULT_WORKSPACE_ID = "__default";
export const DIRECT_WORKSPACE_RULES_VERSION = 1;
export const WORKTREE_WORKSPACE_RULES_VERSION = 2;
export const COPY_WORKSPACE_RULES_VERSION = 1;
export const CLONE_WORKSPACE_RULES_VERSION = 1;

export function agentWorkspaceId(kind: AgentWorkspaceOwnerKind, key: string): string {
  return `ws_${hashJson({ kind, key }).slice(0, 32)}`;
}

export function workflowWorkspaceId(key: string): string {
  return key;
}

export type WorkspaceIdentityInput =
  | {
      key: string;
      mode: "direct";
      path: string;
      ownerKind: AgentWorkspaceOwnerKind;
      sdkAbiVersion: number;
    }
  | {
      key: string;
      mode: "worktree";
      sourcePath: string;
      sourceRef: string;
      retentionPolicy: WorkspaceRetention;
      branchPolicy: "detached" | "generated";
      sdkAbiVersion: number;
    }
  | {
      key: string;
      mode: "copy";
      sourcePath: string;
      retentionPolicy: WorkspaceRetention;
      sdkAbiVersion: number;
    }
  | {
      key: string;
      mode: "clone";
      repo: string;
      sourceKind: Extract<WorkspaceSourceKind, "local-clone-git" | "remote-git">;
      sourcePath: string | null;
      sourceRef: string | null;
      retentionPolicy: WorkspaceRetention;
      sdkAbiVersion: number;
    };

export function workspaceIdentity(input: WorkspaceIdentityInput): {
  json: string;
  hash: string;
} {
  const value = workspaceIdentityValue(input);
  const json = canonicalJson(value);
  return { json, hash: hashJson(value) };
}

function workspaceIdentityValue(input: WorkspaceIdentityInput): Record<string, unknown> {
  switch (input.mode) {
    case "direct":
      return {
        key: input.key,
        mode: input.mode,
        ownerKind: input.ownerKind,
        path: input.path,
        rulesVersion: DIRECT_WORKSPACE_RULES_VERSION,
        sdkAbiVersion: input.sdkAbiVersion,
      };
    case "worktree":
      return {
        key: input.key,
        mode: input.mode,
        sourcePath: input.sourcePath,
        sourceRef: input.sourceRef,
        retentionPolicy: input.retentionPolicy,
        branchPolicy: input.branchPolicy,
        rulesVersion: WORKTREE_WORKSPACE_RULES_VERSION,
        sdkAbiVersion: input.sdkAbiVersion,
      };
    case "copy":
      return {
        key: input.key,
        mode: input.mode,
        sourcePath: input.sourcePath,
        retentionPolicy: input.retentionPolicy,
        rulesVersion: COPY_WORKSPACE_RULES_VERSION,
        sdkAbiVersion: input.sdkAbiVersion,
      };
    case "clone":
      return {
        key: input.key,
        mode: input.mode,
        repo: input.repo,
        sourceKind: input.sourceKind,
        sourcePath: input.sourcePath,
        sourceRef: input.sourceRef ?? "__default",
        retentionPolicy: input.retentionPolicy,
        rulesVersion: CLONE_WORKSPACE_RULES_VERSION,
        sdkAbiVersion: input.sdkAbiVersion,
      };
  }
}
