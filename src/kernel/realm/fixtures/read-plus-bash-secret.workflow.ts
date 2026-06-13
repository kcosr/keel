import type { Ctx } from "../../ctx.ts";

export default async function readPlusBashSecret(ctx: Ctx, _input: null): Promise<string> {
  return ctx.agent({
    key: "inspect",
    prompt: "inspect with shell and secret",
    provider: "writer",
    toolPolicy: "read-only",
    allowTools: ["bash"],
    secrets: ["TOKEN"],
  });
}
