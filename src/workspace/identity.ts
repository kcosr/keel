import { hashJson } from "../hash.ts";
import type { AgentWorkspaceKind } from "../journal/types.ts";

export function agentWorkspaceId(kind: AgentWorkspaceKind, key: string): string {
  return `ws_${hashJson({ kind, key }).slice(0, 32)}`;
}
