// Phase 7: ctx.agent against the deterministic mock provider — structured output,
// bounded schema retry, replay (exactly-once) vs re-execution (at-least-once),
// and crash consistency through the realm.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../../agents/mock.ts";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
} from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const FIX = new URL("./fixtures/", import.meta.url);
const reviewUrl = captureWorkflowFile(new URL("agent-review.workflow.ts", FIX).pathname);
const singleUrl = captureWorkflowFile(new URL("agent-single.workflow.ts", FIX).pathname);
const TASK_REVIEW = new URL("../../../workflows/task-review-guidance/", import.meta.url);
const taskCodeReviewUrl = captureWorkflowFile(
  new URL("code-review.workflow.ts", TASK_REVIEW).pathname,
);
const taskPlanReviewUrl = captureWorkflowFile(
  new URL("plan-review.workflow.ts", TASK_REVIEW).pathname,
);
const taskDocsReviewUrl = captureWorkflowFile(
  new URL("docs-review.workflow.ts", TASK_REVIEW).pathname,
);

function kernel(
  store: JournalStore,
  mock: AgentProvider,
  extra: Record<string, unknown> = {},
): RealmKernel {
  let id = 0;
  return new RealmKernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => 1,
    rng: () => 0.5,
    agents: new AgentProviderRegistry().register(mock),
    ...extra,
  });
}

class RecordingProvider implements AgentProvider {
  readonly name = "mock";
  readonly calls: AgentInvocation[] = [];

  constructor(private readonly outputs: Record<string, unknown>) {}

  async generate(invocation: AgentInvocation, _hooks: AgentHooks): Promise<AgentResult> {
    this.calls.push(invocation);
    const output = this.outputs[invocation.key];
    if (output === undefined) {
      throw new Error(`recording provider: no output for ${invocation.key}`);
    }
    return {
      text: typeof output === "string" ? output : JSON.stringify(output),
      transcript: [],
    };
  }
}

const mockProfiles = {
  "claude-default": { provider: "mock" },
};

describe("ctx.agent — structured output + fan-out", () => {
  test("a fan-out of agents validates output and aggregates", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: {
        "review:auth": { outputs: ['{"findings":[{"title":"a"},{"title":"b"}]}'] },
        "review:net": { outputs: ['```json\n{"findings":[{"title":"c"}]}\n```'] },
      },
    });
    const handle = await kernel(store, mock).run<number>(
      reviewUrl,
      { domains: ["auth", "net"] },
      { name: "review", target: process.cwd() },
    );
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe(3); // 2 + 1 findings
    // the agent steps are journaled as effectful
    const rows = store.listJournalRows("run_0");
    const agents = rows.filter((r) => r.effectType === "effectful");
    expect(agents.map((r) => r.stableKey).sort()).toEqual(["review:auth", "review:net"]);
  });
});

describe("task review guidance workflows", () => {
  test("code review validates clean and changes-requested output with read-only tools", async () => {
    const store = JournalStore.memory();
    const target = mkdtempSync(join(tmpdir(), "keel-task-code-review-"));
    const provider = new RecordingProvider({
      review: {
        status: "clean",
        findings: [],
        summary: "No findings.",
      },
    });
    try {
      const clean = await kernel(store, provider, { agentProfiles: mockProfiles }).run<{
        status: string;
        findings: unknown[];
        summary: string;
      }>(
        taskCodeReviewUrl,
        { repository: ".", task: "review", focus: ["capability"], maxFindings: 2 },
        { name: "task-code-review", target },
      );
      expect(clean.status).toBe("finished");
      expect(clean.output).toEqual({ status: "clean", findings: [], summary: "No findings." });
      expect(provider.calls[0]?.toolPolicy).toBe("read-only");
      expect(provider.calls[0]?.cwd).toBe(target);
      expect(provider.calls[0]?.prompt).toContain(`Repository: ${target}`);
      expect(provider.calls[0]?.prompt).toContain("code.capabilities");
      expect(provider.calls[0]?.prompt).toContain("Advisory finding cap: 2");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }

    const store2 = JournalStore.memory();
    const provider2 = new RecordingProvider({
      review: {
        status: "changes-requested",
        summary: "Needs fixes and does not exceed scope.",
        findings: [
          {
            severity: "high",
            file: "src/a.ts",
            line: 12,
            title: "Broken replay",
            evidence: "The durable key changes between resumes.",
            recommendation: "Keep the key stable.",
          },
          {
            severity: "low",
            title: "Missing docs",
            evidence: "USAGE.md does not mention the output shape.",
            recommendation: "Document the saved workflow behavior.",
          },
        ],
      },
    });
    const changes = await kernel(store2, provider2, { agentProfiles: mockProfiles }).run<{
      status: string;
      findings: unknown[];
      summary: string;
    }>(
      taskCodeReviewUrl,
      { repository: process.cwd(), task: "review", maxFindings: 1 },
      { name: "task-code-review", target: process.cwd() },
    );
    expect(changes.status).toBe("finished");
    expect(changes.output?.status).toBe("changes-requested");
    expect(changes.output?.findings).toHaveLength(2);
    expect(changes.output?.summary).toContain("exceeding the advisory cap of 1");
  });

  test("code review retries structurally malformed output through the agent schema", async () => {
    const store = JournalStore.memory();
    const provider = new MockProvider({
      responses: {
        review: {
          outputs: [
            "{}",
            JSON.stringify({
              status: "clean",
              findings: [],
              summary: "Valid after retry.",
            }),
          ],
        },
      },
    });
    const handle = await kernel(store, provider, { agentProfiles: mockProfiles }).run<{
      status: string;
      findings: unknown[];
      summary: string;
    }>(
      taskCodeReviewUrl,
      { repository: process.cwd(), task: "review" },
      { name: "task-code-review", target: process.cwd() },
    );
    expect(handle.status).toBe("finished");
    expect(handle.output).toEqual({
      status: "clean",
      findings: [],
      summary: "Valid after retry.",
    });
  });

  test("code review fails malformed reviewer output in workflow validation", async () => {
    const store = JournalStore.memory();
    const provider = new RecordingProvider({
      review: {
        status: "changes-requested",
        summary: "bad",
        findings: [],
      },
    });
    await expect(
      kernel(store, provider, { agentProfiles: mockProfiles }).run(
        taskCodeReviewUrl,
        { repository: process.cwd(), task: "review" },
        { name: "task-code-review", target: process.cwd() },
      ),
    ).rejects.toThrow(/requires one or more findings/);
    expect(store.getRun("run_0")?.status).toBe("failed");
  });

  test("plan review uses read-only by default and workspace-write only for append mode", async () => {
    const readonlyStore = JournalStore.memory();
    const readonlyProvider = new RecordingProvider({
      review: {
        status: "clean",
        findings: [],
        summary: "Plan is ready.",
      },
    });
    const readonlyRun = await kernel(readonlyStore, readonlyProvider, {
      agentProfiles: mockProfiles,
    }).run<{ appended: boolean }>(
      taskPlanReviewUrl,
      { specPath: ".specs/plan.md", request: "review plan", focus: ["migrations"] },
      { name: "task-plan-review", target: process.cwd() },
    );
    expect(readonlyRun.status).toBe("finished");
    expect(readonlyRun.output?.appended).toBe(false);
    expect(readonlyProvider.calls.map((call) => call.toolPolicy)).toEqual(["read-only"]);
    expect(readonlyProvider.calls[0]?.prompt).toContain("plan.migrations");

    const appendStore = JournalStore.memory();
    const appendProvider = new RecordingProvider({
      review: {
        status: "clean",
        findings: [],
        summary: "Correspondence appended.",
      },
      "confirm-correspondence": {
        present: true,
        summary: "Header found.",
      },
    });
    const appendRun = await kernel(appendStore, appendProvider, {
      agentProfiles: mockProfiles,
    }).run<{ appended: boolean }>(
      taskPlanReviewUrl,
      {
        specPath: ".specs/plan.md",
        request: "review plan",
        appendCorrespondence: true,
        correspondenceHeader: "### 2026-06-15T00:00:00.000Z - Reviewer: mock",
      },
      { name: "task-plan-review", target: process.cwd() },
    );
    expect(appendRun.status).toBe("finished");
    expect(appendRun.output?.appended).toBe(true);
    expect(appendProvider.calls.map((call) => call.toolPolicy)).toEqual([
      "workspace-write",
      "read-only",
    ]);
    expect(appendProvider.calls[0]?.prompt).toContain(
      "Correspondence header to add exactly: ### 2026-06-15T00:00:00.000Z - Reviewer: mock",
    );
    expect(appendProvider.calls[1]?.prompt).toContain("under a ## Correspondence section");
  });

  test("plan review append mode requires and confirms correspondence", async () => {
    const missingHeaderStore = JournalStore.memory();
    await expect(
      kernel(missingHeaderStore, new RecordingProvider({}), { agentProfiles: mockProfiles }).run(
        taskPlanReviewUrl,
        { specPath: ".specs/plan.md", request: "review", appendCorrespondence: true },
        { name: "task-plan-review", target: process.cwd() },
      ),
    ).rejects.toThrow(/requires correspondenceHeader/);

    const emptySpecPathStore = JournalStore.memory();
    await expect(
      kernel(emptySpecPathStore, new RecordingProvider({}), { agentProfiles: mockProfiles }).run(
        taskPlanReviewUrl,
        { specPath: " ", request: "review" },
        { name: "task-plan-review", target: process.cwd() },
      ),
    ).rejects.toThrow(/specPath must be non-empty/);

    const escapingSpecPathStore = JournalStore.memory();
    await expect(
      kernel(escapingSpecPathStore, new RecordingProvider({}), { agentProfiles: mockProfiles }).run(
        taskPlanReviewUrl,
        {
          specPath: "../outside.md",
          request: "review",
          appendCorrespondence: true,
          correspondenceHeader: "### 2026-06-15T00:00:00.000Z - Reviewer: mock",
        },
        { name: "task-plan-review", target: process.cwd() },
      ),
    ).rejects.toThrow(/specPath must stay inside the run target/);

    const confirmationStore = JournalStore.memory();
    const provider = new RecordingProvider({
      review: {
        status: "clean",
        findings: [],
        summary: "Correspondence appended.",
      },
      "confirm-correspondence": {
        present: false,
        summary: "Header missing.",
      },
    });
    await expect(
      kernel(confirmationStore, provider, { agentProfiles: mockProfiles }).run(
        taskPlanReviewUrl,
        {
          specPath: ".specs/plan.md",
          request: "review",
          appendCorrespondence: true,
          correspondenceHeader: "### 2026-06-15T00:00:00.000Z - Reviewer: mock",
        },
        { name: "task-plan-review", target: process.cwd() },
      ),
    ).rejects.toThrow(/correspondence confirmation failed/);
  });

  test("docs review validates output with read-only tools and resolved repository cwd", async () => {
    const store = JournalStore.memory();
    const target = mkdtempSync(join(tmpdir(), "keel-task-docs-review-"));
    const provider = new RecordingProvider({
      review: {
        status: "clean",
        findings: [],
        summary: "Docs are accurate.",
      },
    });
    try {
      const clean = await kernel(store, provider, { agentProfiles: mockProfiles }).run<{
        status: string;
        findings: unknown[];
        summary: string;
      }>(
        taskDocsReviewUrl,
        { repository: ".", task: "review docs", focus: ["quickstart"], maxFindings: 2 },
        { name: "task-docs-review", target },
      );
      expect(clean.status).toBe("finished");
      expect(clean.output).toEqual({
        status: "clean",
        findings: [],
        summary: "Docs are accurate.",
      });
      expect(provider.calls[0]?.toolPolicy).toBe("read-only");
      expect(provider.calls[0]?.cwd).toBe(target);
      expect(provider.calls[0]?.prompt).toContain(`Repository: ${target}`);
      expect(provider.calls[0]?.prompt).toContain("docs.quickstart");
      expect(provider.calls[0]?.prompt).toContain("Advisory finding cap: 2");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }

    const escapingStore = JournalStore.memory();
    await expect(
      kernel(escapingStore, new RecordingProvider({}), { agentProfiles: mockProfiles }).run(
        taskDocsReviewUrl,
        { repository: "../outside", task: "review docs" },
        { name: "task-docs-review", target: process.cwd() },
      ),
    ).rejects.toThrow(/repository must stay inside the run target/);

    const invalidStore = JournalStore.memory();
    const invalidProvider = new RecordingProvider({
      review: {
        status: "changes-requested",
        summary: "bad",
        findings: [],
      },
    });
    await expect(
      kernel(invalidStore, invalidProvider, { agentProfiles: mockProfiles }).run(
        taskDocsReviewUrl,
        { repository: process.cwd(), task: "review docs" },
        { name: "task-docs-review", target: process.cwd() },
      ),
    ).rejects.toThrow(/requires one or more findings/);
  });
});

describe("ctx.agent — bounded schema retry", () => {
  test("invalid-then-valid output retries in-session and succeeds", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: {
        ask: {
          // first attempt: not valid JSON; second: valid
          outputs: ["sorry, no JSON here", '{"value":21}'],
        },
      },
    });
    const handle = await kernel(store, mock).run<number>(singleUrl, null, {
      name: "s",
      target: process.cwd(),
    });
    expect(handle.status).toBe("finished");
    expect(handle.output).toBe(42); // 21 * 2
  });

  test("never-valid output fails the run after retries", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: { ask: { outputs: ["nope"] } },
    });
    await expect(
      kernel(store, mock).run(singleUrl, null, { name: "s", target: process.cwd() }),
    ).rejects.toThrow(/failed schema validation/);
    expect(store.getRun("run_0")?.status).toBe("failed");
  });
});

describe("ctx.agent — replay vs re-execution", () => {
  test("a completed agent replays on resume (exactly-once); pending re-executes", async () => {
    const store = JournalStore.memory();
    let asks = 0;
    const mock = new MockProvider({
      responses: { ask: { outputs: ['{"value":5}'] } },
    });
    // wrap generate to count
    const counting = new Proxy(mock, {
      get(t, p) {
        if (p === "generate") {
          return async (...args: Parameters<typeof t.generate>) => {
            asks++;
            return t.generate(...args);
          };
        }
        return Reflect.get(t, p);
      },
    });

    // Run with a before-commit fault on the pure step AFTER the agent, so the
    // agent commits but the run aborts → resume replays the agent (no re-ask).
    const exec: string[] = [];
    const k1 = kernel(store, counting as MockProvider, {
      onStepExecute: (key: string) => exec.push(key),
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "double") throw new Error("CRASH");
      },
    });
    await k1.run(singleUrl, null, { name: "s", target: process.cwd() }).catch(() => null);
    expect(asks).toBe(1); // agent ran once
    expect(store.getRun("run_0")?.status).toBe("running"); // resumable

    const k2 = kernel(store, counting as MockProvider);
    const resumed = await k2.resume<number>("run_0");
    expect(resumed.output).toBe(10);
    expect(asks).toBe(1); // agent REPLAYED — not re-asked (exactly-once)
  });

  test("a crash before the agent commits re-executes it on resume (at-least-once)", async () => {
    const store = JournalStore.memory();
    let asks = 0;
    const mock = new MockProvider({ responses: { ask: { outputs: ['{"value":7}'] } } });
    const counting = new Proxy(mock, {
      get(t, p) {
        if (p === "generate") {
          return async (...args: Parameters<typeof t.generate>) => {
            asks++;
            return t.generate(...args);
          };
        }
        return Reflect.get(t, p);
      },
    });

    const k1 = kernel(store, counting as MockProvider, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "ask") throw new Error("CRASH");
      },
    });
    await k1.run(singleUrl, null, { name: "s", target: process.cwd() }).catch(() => null);
    expect(asks).toBe(1); // ran, but crashed before commit
    expect(store.getRun("run_0")?.status).toBe("running");

    const k2 = kernel(store, counting as MockProvider);
    const resumed = await k2.resume<number>("run_0");
    expect(resumed.output).toBe(14);
    expect(asks).toBe(2); // re-executed on resume (at-least-once)
  });
});
