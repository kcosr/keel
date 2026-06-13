import type { Ctx } from "@kcosr/keel";
import { passthrough } from "@kcosr/keel";

export default async function (ctx: Ctx, _input: Record<string, never>) {
  // Fan out 5 agents that each run a 10-second sleep via the bash tool.
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      ctx.agent({
        key: ctx.stepKey("sleep-agent", String(i)),
        prompt: `Run the command "sleep 10" and then output the word "done".`,
        // Enable the bash tool (shell capability)
        capabilities: { shell: true, fs: "none", network: "none", secrets: [] },
        schema: passthrough<string>(),
        reasoning: "low",
        lenient: true,
      }),
    ),
  );

  // Filter out any nulls (failed agents) and return the collected strings.
  return { messages: results.filter(Boolean) };
}
