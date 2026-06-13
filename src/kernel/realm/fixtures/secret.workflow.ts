// Phase 15 fixture: an agent that receives a secret and echoes it; the host must
// redact it before journaling, and inject it via the side channel.
import type { Ctx } from "@kcosr/keel";

export default async function leak(ctx: Ctx, _input: null): Promise<string> {
  return ctx.agent({ key: "leak", prompt: "echo the token", provider: "mock", secrets: ["TOKEN"] });
}
