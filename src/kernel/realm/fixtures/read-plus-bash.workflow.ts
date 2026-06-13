import type { Ctx } from "../../ctx.ts";

export default async function readPlusBash(ctx: Ctx, _input: null): Promise<string> {
  return ctx.agent({
    key: "inspect",
    prompt: "inspect with shell",
    provider: "writer",
    toolPolicy: "read-only",
    allowTools: ["bash"],
  });
}
