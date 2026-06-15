// Verification fixture: a worktree agent that also receives a secret.
import type { Ctx } from "@kcosr/keel";

export default async function writeSecret(ctx: Ctx, _input: null): Promise<string> {
  const workspace = await ctx.workspace({ key: "secret-workspace", mode: "worktree" });
  return ctx.agent({
    key: "edit",
    prompt: "write the config",
    provider: "writer",
    workspace,
    capabilities: { fs: "workspace-write" },
    secrets: ["TOKEN"],
  });
}
