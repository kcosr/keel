// Commit 10 fixture: an agent that inherits its config from a named profile.
import type { Ctx } from "@kcosr/keel";

export default async function profiled(ctx: Ctx, _input: null): Promise<string> {
  // no provider/model here — they come from the "reviewer" profile.
  return ctx.agent({ key: "review", prompt: "review", profile: "reviewer" });
}
