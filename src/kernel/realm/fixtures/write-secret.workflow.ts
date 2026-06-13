// Verification fixture: a workspace-isolated agent that also receives a secret.
import type { Ctx } from "@kcosr/keel";

export default async function writeSecret(ctx: Ctx, _input: null): Promise<string> {
  return ctx.agent({
    key: "edit",
    prompt: "write the config",
    provider: "writer",
    workspaceIsolation: true,
    capabilities: { fs: "workspace-write" },
    secrets: ["TOKEN"],
  });
}
