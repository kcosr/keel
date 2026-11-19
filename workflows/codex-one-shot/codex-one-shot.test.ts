import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentInvocation, AgentProviderRegistry } from "../../src/agents/types.ts";
import { JournalStore } from "../../src/journal/store.ts";
import { RealmKernel } from "../../src/kernel/realm/realm-host.ts";
import { captureWorkflowFile } from "../../src/workflow-definitions/capture.ts";
import { validateWorkflowInput } from "../../src/workflow-input.ts";

const workflow = captureWorkflowFile(join(import.meta.dir, "codex-one-shot.workflow.ts"));
const schema = JSON.parse(readFileSync(join(import.meta.dir, "input-schema.json"), "utf8"));

for (const [profile, model, reasoning, tier] of [
  [undefined, "gpt-6-astra", "xhigh", undefined],
  ["codex-fast", "gpt-6.2-sol", "xhigh", "priority"],
  ["codex-ultrafast", "gpt-6.2-sol", "xhigh", "ultrafast"],
] as const) {
  test(`runs one Codex call in the requested target using ${profile ?? "the default profile"}`, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "keel-codex-one-shot-")));
    const store = JournalStore.memory();
    try {
      const target = join(dir, "target");
      mkdirSync(target);
      const calls: AgentInvocation[] = [];
      const agents = new AgentProviderRegistry().register({
        name: "codex",
        async generate(invocation) {
          calls.push(invocation);
          return { text: "README updated.", transcript: [] };
        },
      });
      const kernel = new RealmKernel(store, {
        agents,
        definitionCacheRoot: join(dir, "definitions"),
        agentProfiles: {
          "codex-default": { provider: "codex", model: "gpt-6-astra", reasoning: "xhigh" },
          "codex-fast": {
            provider: "codex",
            model: "gpt-6.2-sol",
            reasoning: "xhigh",
            providerConfig: { codex: { serviceTier: "priority" } },
          },
          "codex-ultrafast": {
            provider: "codex",
            model: "gpt-6.2-sol",
            reasoning: "xhigh",
            providerConfig: { codex: { serviceTier: "ultrafast" } },
          },
        },
      });
      const prompt = "Update the README.";
      const input = profile === undefined ? { prompt } : { prompt, profile };
      await validateWorkflowInput(schema, input);

      const result = await kernel.run<string>(workflow, input, { target });

      expect(result.status).toBe("finished");
      expect(result.output).toBe("README updated.");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        provider: "codex",
        cwd: target,
        prompt,
        model,
        reasoning,
        toolPolicy: "workspace-write",
        capabilities: { fs: "workspace-write", network: "none", shell: false, secrets: [] },
      });
      expect(calls[0]?.providerConfig).toEqual(
        tier === undefined ? undefined : { serviceTier: tier },
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the input contract rejects blank prompts and profiles outside the seeded set", async () => {
  await expect(validateWorkflowInput(schema, { prompt: "  \n " })).rejects.toThrow(/\$\.prompt/);
  await expect(
    validateWorkflowInput(schema, { prompt: "Update the README.", profile: "claude-default" }),
  ).rejects.toThrow(/\$\.profile/);
});
