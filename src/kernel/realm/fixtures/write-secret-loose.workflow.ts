// Verification fixture: a write-capable secret agent without workspace isolation.
import type { Ctx } from "../../ctx.ts";

export default async function writeSecretLoose(ctx: Ctx, _input: null): Promise<string> {
  return ctx.agent({
    key: "edit",
    prompt: "write the config",
    provider: "writer",
    capabilities: { fs: "workspace-write" },
    secrets: ["TOKEN"],
  });
}
