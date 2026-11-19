import type { Ctx } from "@kcosr/keel";

const DEFAULT_PROFILE = "codex-default";
const PROFILES = [DEFAULT_PROFILE, "codex-fast", "codex-ultrafast"] as const;

type CodexOneShotInput = {
  prompt: string;
  profile?: (typeof PROFILES)[number];
};

export default async function codexOneShot(ctx: Ctx, input: CodexOneShotInput): Promise<string> {
  if (typeof input?.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new Error("prompt must be a nonblank string");
  }
  const profile = input.profile === undefined ? DEFAULT_PROFILE : input.profile;
  if (!PROFILES.includes(profile)) {
    throw new Error(`profile must be one of ${PROFILES.join(", ")}`);
  }

  const workspace = await ctx.workspace({ key: "target", mode: "direct", path: ctx.run.target });
  return await ctx.agent<string>({
    key: "codex",
    provider: "codex",
    profile,
    workspace,
    toolPolicy: "workspace-write",
    onFailure: "throw",
    prompt: input.prompt,
  });
}
