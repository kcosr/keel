// Trusted-local secrets fixture: an agent receives a secret via the side channel
// and echoes it into output, which Keel journals as-is.
import type { Ctx } from "@kcosr/keel";

export default async function leak(ctx: Ctx, _input: null): Promise<string> {
  return ctx.agent({
    key: "leak",
    prompt: "echo the token",
    provider: "mock",
    capabilities: { secrets: ["TOKEN"] },
    environment: { secrets: ["TOKEN"] },
  });
}
