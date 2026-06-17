import type { Ctx } from "@kcosr/keel";

export default async function readPlusBashSecret(ctx: Ctx, _input: null): Promise<string> {
  return ctx.agent({
    key: "inspect",
    prompt: "inspect with shell and secret",
    provider: "writer",
    capabilities: { fs: "read", secrets: ["TOKEN"] },
    allowTools: ["bash"],
    environment: { secrets: ["TOKEN"] },
  });
}
