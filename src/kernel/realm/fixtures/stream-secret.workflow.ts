// Commit 3 fixture: an agent that streams an event containing the injected secret.
import type { Ctx } from "@kcosr/keel";

export default async function streamSecret(ctx: Ctx, _input: null): Promise<string> {
  return ctx.agent({
    key: "stream",
    prompt: "p",
    provider: "streamer",
    capabilities: { secrets: ["TOKEN"] },
    environment: { secrets: ["TOKEN"] },
  });
}
