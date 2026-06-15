// Fixture: an agent explicitly running in a Keel-owned worktree.
import type { Ctx } from "@kcosr/keel";

export default async function writeAgent(ctx: Ctx, _input: null): Promise<string> {
  const workspace = await ctx.workspace({ key: "edit-workspace", mode: "worktree" });
  return ctx.agent({
    key: "edit",
    prompt: "make a change",
    provider: "writer",
    workspace,
    capabilities: { fs: "workspace-write" },
  });
}
