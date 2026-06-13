import type { Ctx } from "@kcosr/keel";
import { passthrough } from "@kcosr/keel";

export default async function (ctx: Ctx, _input: Record<string, never>) {
  // Fan out 5 agents, each invoking the bash tool to run `sleep 10 && echo done`.
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      ctx.agent({
        key: ctx.stepKey("sleep-agent", String(i)),
        prompt: `Run the command "sleep 10 && echo done" and return only the word "done".`,
        // Specify the model you want to use
        model: "qwen-3-6-27b/qwen3.6-27b",
        // Enable the bash tool (shell capability)
        capabilities: { shell: true, fs: "none", network: "none", secrets: [] },
        // We just want the raw text output
        schema: passthrough<string>(),
        reasoning: "low",
        lenient: true,
      }),
    ),
  );

  // Return the collected messages
  return { messages: results.filter(Boolean) };
}
