import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
} from "../../src/agents/types.ts";
import { AgentProviderRegistry } from "../../src/agents/types.ts";
import { JournalStore } from "../../src/journal/store.ts";
import { RealmKernel } from "../../src/kernel/realm/realm-host.ts";
import { captureWorkflowFile } from "../../src/workflow-definitions/capture.ts";

const workflowUrl = captureWorkflowFile(
  new URL("web-ui-product-loop.workflow.ts", import.meta.url).pathname,
);

class WebUiLoopProvider implements AgentProvider {
  readonly name = "session";
  readonly supportsSessions = true;
  readonly calls: AgentInvocation[] = [];
  private reviewCalls = 0;

  constructor(private readonly reviewMode: "clean" | "block-once" = "clean") {}

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    this.calls.push(invocation);
    const sessionToken = invocation.resumeToken ?? `${invocation.key}-token`;
    hooks.onSessionToken?.(sessionToken);
    const output = invocation.key.includes("reviewer-")
      ? this.reviewOutput(invocation.key)
      : {
          status: "implemented",
          milestoneId: "foundation",
          summary: `implemented ${invocation.key}`,
          filesChanged: ["web/src/main.tsx"],
          commits: [`commit-${this.calls.length}`],
          verification: ["not run"],
          screenshotPaths: [],
          adversarialReview: "no findings",
          notes: "test provider",
        };
    return { text: JSON.stringify(output), transcript: [], sessionToken };
  }

  private reviewOutput(key: string): unknown {
    this.reviewCalls += 1;
    if (this.reviewMode === "block-once" && this.reviewCalls === 1) {
      return {
        status: "changes-requested",
        milestoneId: "foundation",
        summary: `blocking review ${key}`,
        findings: [
          {
            severity: "medium",
            title: "Needs another pass",
            file: "web/src/main.tsx",
            line: 1,
            problem: "The implementation is incomplete.",
            recommendation: "Run another implementation pass.",
          },
        ],
        advisoryFindings: [],
        visualNotes: "static review only",
        verificationNotes: "reported verification inspected",
      };
    }
    return {
      status: "clean",
      milestoneId: "foundation",
      summary: `reviewed ${key}`,
      findings: [],
      advisoryFindings: [],
      visualNotes: "static review only",
      verificationNotes: "reported verification inspected",
    };
  }
}

function testAgentRegistry(provider: AgentProvider): AgentProviderRegistry {
  const registry = new AgentProviderRegistry();
  for (const name of ["codex", "claude"]) {
    registry.register({
      ...provider,
      name,
      supportsSessions: provider.supportsSessions,
      generate: provider.generate.bind(provider),
    });
  }
  return registry;
}

describe("web UI product loop workflow", () => {
  test("rework uses fresh agent-session turn keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-web-loop-"));
    const repo = join(dir, "repo");
    const store = JournalStore.memory();
    const provider = new WebUiLoopProvider();
    try {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "README.md"), "fixture\n");
      await Bun.spawn(["git", "init", "-b", "main"], { cwd: repo }).exited;
      await Bun.spawn(["git", "config", "user.email", "keel@example.test"], {
        cwd: repo,
      }).exited;
      await Bun.spawn(["git", "config", "user.name", "Keel Test"], { cwd: repo }).exited;
      await Bun.spawn(["git", "add", "README.md"], { cwd: repo }).exited;
      await Bun.spawn(["git", "commit", "-m", "init"], { cwd: repo }).exited;

      const kernel = new RealmKernel(store, {
        idgen: () => "run_web_loop_rework",
        clock: () => 1,
        rng: () => 0.5,
        workspaceStore: join(dir, "workspaces"),
        agents: testAgentRegistry(provider),
      });

      const milestone = {
        id: "foundation",
        title: "Foundation",
        task: "Create a tiny frontend foundation.",
        acceptance: ["foundation exists"],
        verification: ["not run"],
      };

      const parked = await kernel.run(
        workflowUrl,
        {
          repository: repo,
          spec: "/tmp/spec.md",
          prototypeDir: "/tmp/prototype",
          mockupsDir: "/tmp/mockups",
          milestones: [milestone],
          maxRoundsPerMilestone: 2,
        },
        { name: "web-loop", target: repo },
      );
      expect(parked.status).toBe("waiting-signal");

      store.putSignal(
        "run_web_loop_rework",
        "web-ui-control",
        { action: "rework", instructions: "Run another pass." },
        2,
      );
      const reworked = await kernel.resume("run_web_loop_rework");
      expect(reworked.status).toBe("waiting-signal");

      store.putSignal("run_web_loop_rework", "web-ui-control", { action: "complete" }, 3);
      const finished = await kernel.resume<{ completedMilestones: string[] }>(
        "run_web_loop_rework",
      );
      expect(finished.status).toBe("finished");
      expect(finished.output?.completedMilestones).toEqual(["foundation"]);
      expect(provider.calls.map((call) => call.key)).toEqual([
        "__session.implementer-foundation.foundation-implement-1",
        "__session.reviewer-foundation.foundation-review-1",
        "__session.implementer-foundation.foundation-implement-2",
        "__session.reviewer-foundation.foundation-review-2",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("max-round rework keeps persisted round sequence unique", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-web-loop-"));
    const repo = join(dir, "repo");
    const store = JournalStore.memory();
    const provider = new WebUiLoopProvider("block-once");
    try {
      await initRepo(repo);
      const kernel = new RealmKernel(store, {
        idgen: () => "run_web_loop_max_rework",
        clock: () => 1,
        rng: () => 0.5,
        workspaceStore: join(dir, "workspaces"),
        agents: testAgentRegistry(provider),
      });

      const parked = await kernel.run<{ rounds: Array<{ round: number }> }>(
        workflowUrl,
        {
          repository: repo,
          spec: "/tmp/spec.md",
          prototypeDir: "/tmp/prototype",
          mockupsDir: "/tmp/mockups",
          milestones: [foundationMilestone()],
          maxRoundsPerMilestone: 1,
        },
        { name: "web-loop", target: repo },
      );
      expect(parked.status).toBe("waiting-signal");

      store.putSignal(
        "run_web_loop_max_rework",
        "web-ui-control",
        { action: "rework", instructions: "Fix the medium finding." },
        2,
      );
      const reworked = await kernel.resume("run_web_loop_max_rework");
      expect(reworked.status).toBe("waiting-signal");

      store.putSignal("run_web_loop_max_rework", "web-ui-control", { action: "complete" }, 3);
      const finished = await kernel.resume<{ rounds: Array<{ round: number }> }>(
        "run_web_loop_max_rework",
      );
      expect(finished.status).toBe("finished");
      expect(finished.output?.rounds.map((round) => round.round)).toEqual([1, 2]);
      expect(provider.calls.map((call) => call.key)).toEqual([
        "__session.implementer-foundation.foundation-implement-1",
        "__session.reviewer-foundation.foundation-review-1",
        "__session.implementer-foundation.foundation-implement-2",
        "__session.reviewer-foundation.foundation-review-2",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function initRepo(repo: string): Promise<void> {
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "fixture\n");
  await Bun.spawn(["git", "init", "-b", "main"], { cwd: repo }).exited;
  await Bun.spawn(["git", "config", "user.email", "keel@example.test"], { cwd: repo }).exited;
  await Bun.spawn(["git", "config", "user.name", "Keel Test"], { cwd: repo }).exited;
  await Bun.spawn(["git", "add", "README.md"], { cwd: repo }).exited;
  await Bun.spawn(["git", "commit", "-m", "init"], { cwd: repo }).exited;
}

function foundationMilestone(): {
  id: string;
  title: string;
  task: string;
  acceptance: string[];
  verification: string[];
} {
  return {
    id: "foundation",
    title: "Foundation",
    task: "Create a tiny frontend foundation.",
    acceptance: ["foundation exists"],
    verification: ["not run"],
  };
}
