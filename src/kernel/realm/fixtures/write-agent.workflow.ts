// Commit 3 fixture: an agent explicitly isolated in a worktree.
import type { Ctx } from "@kcosr/keel";

export default async function writeAgent(ctx: Ctx, _input: null): Promise<string> {
  return ctx.agent({
    key: "edit",
    prompt: "make a change",
    provider: "writer",
    workspaceIsolation: true,
    capabilities: { fs: "workspace-write" },
  });
}
