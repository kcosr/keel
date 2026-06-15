import { hashJson } from "../hash.ts";
import type { AgentWorkspaceOwnerKind } from "../journal/types.ts";

export const DEFAULT_WORKSPACE_ID = "__default";

export function agentWorkspaceId(kind: AgentWorkspaceOwnerKind, key: string): string {
  return `ws_${hashJson({ kind, key }).slice(0, 32)}`;
}

export function workflowWorkspaceId(key: string): string {
  return key;
}
