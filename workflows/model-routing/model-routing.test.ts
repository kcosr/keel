import { describe, expect, test } from "bun:test";
import type { Ctx } from "@kcosr/keel";
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
import {
  type RouterAgentOutput,
  type RoutingConstraints,
  buildRoutingPrompt,
  routeWithAgent,
  sanitizeRoute,
  selectModelRoute,
} from "./model-routing";

const CODEX_BACKEND = { provider: "codex", model: "gpt-5.5" };
const CLAUDE_BACKEND = { provider: "claude", model: "claude-opus-4-8" };

const BASE_CONSTRAINTS: RoutingConstraints = {
  allowedBackends: [CODEX_BACKEND, CLAUDE_BACKEND],
  allowedReasoning: ["low", "medium", "high", "xhigh"],
  maxReasoning: "xhigh",
  defaultImplementer: CODEX_BACKEND,
  defaultReviewer: CLAUDE_BACKEND,
};

const ROUTER_OUTPUT: RouterAgentOutput = {
  complexity: "medium",
  surfaces: ["docs"],
  risks: ["unknown"],
  languages: ["typescript"],
  implementer: {
    provider: "codex",
    model: "gpt-5.5",
    reasoning: "medium",
    timeoutMs: 120000,
  },
  reviewer: {
    provider: "claude",
    model: "claude-opus-4-8",
    reasoning: "medium",
  },
  maxRounds: 3,
  verification: ["bun test workflows/model-routing/model-routing.test.ts"],
  rationale: "medium documentation-adjacent change",
};

const exampleWorkflow = captureWorkflowFile(
  new URL("example-smart-implement-review.workflow.ts", import.meta.url).pathname,
);

class ExampleSessionProvider implements AgentProvider {
  readonly name = "session";
  readonly supportsSessions = true;
  readonly calls: AgentInvocation[] = [];
  private reviewCalls = 0;

  constructor(private readonly reviewMode: "clean" | "always-findings") {}

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    this.calls.push(invocation);
    if (invocation.key.startsWith("__session.")) {
      const token = invocation.resumeToken ?? `${invocation.key.split(".")[1] ?? "session"}-token`;
      hooks.onSessionToken?.(token);
      return {
        text: JSON.stringify(this.sessionOutput(invocation.key)),
        transcript: [],
        sessionToken: token,
      };
    }
    if (invocation.key !== "model-router") {
      throw new Error(`unexpected invocation key ${invocation.key}`);
    }
    return {
      text: JSON.stringify({
        ...ROUTER_OUTPUT,
        implementer: { ...ROUTER_OUTPUT.implementer, timeoutMs: 111000 },
        reviewer: { ...ROUTER_OUTPUT.reviewer, timeoutMs: 222000 },
        maxRounds: 2,
      }),
      transcript: [],
    };
  }

  private sessionOutput(key: string): unknown {
    if (key.startsWith("__session.implementer.")) {
      return {
        status: "implemented",
        summary: `implemented ${key}`,
        filesChanged: ["workflows/model-routing/model-routing.ts"],
        verification: ["bun test workflows/model-routing/model-routing.test.ts"],
      };
    }
    if (key.startsWith("__session.reviewer.")) {
      this.reviewCalls += 1;
      if (this.reviewMode === "clean") {
        return { status: "clean", findings: [], summary: "clean" };
      }
      return {
        status: "changes-requested",
        findings: [
          {
            severity: "low",
            title: `finding ${this.reviewCalls}`,
            evidence: "evidence",
            recommendation: "fix it",
          },
        ],
        summary: "changes requested",
      };
    }
    throw new Error(`unexpected session key ${key}`);
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

describe("model routing helper", () => {
  test("static routing applies critical surface and risk floors", () => {
    const journalRoute = selectModelRoute({
      role: "reviewer",
      task: "implementation-review",
      complexity: "low",
      surfaces: ["journal"],
      risks: ["migration"],
      budget: "cheap",
    });
    expect(journalRoute.provider).toBe("claude");
    expect(journalRoute.model).toBe("claude-opus-4-8");
    expect(journalRoute.reasoning).toBe("high");
    expect(journalRoute.rationale).toContain("critical floor high");

    const dataLossRoute = selectModelRoute({
      role: "implementer",
      task: "implementation",
      complexity: "medium",
      risks: ["data-loss"],
      budget: "cheap",
    });
    expect(dataLossRoute.provider).toBe("codex");
    expect(dataLossRoute.model).toBe("gpt-5.5");
    expect(dataLossRoute.reasoning).toBe("xhigh");

    const cheapExplicitHighRoute = selectModelRoute({
      role: "reviewer",
      task: "docs-review",
      complexity: "xhigh",
      budget: "cheap",
    });
    expect(cheapExplicitHighRoute.reasoning).toBe("high");
  });

  test("static routing rejects invalid runtime budget values", () => {
    expect(() =>
      selectModelRoute({
        role: "reviewer",
        task: "docs-review",
        budget: "free" as never,
      }),
    ).toThrow(/budget/);
    expect(() =>
      selectModelRoute({
        role: "reviewer",
        task: "docs-review",
        budget: "" as never,
      }),
    ).toThrow(/budget/);
    expect(() =>
      selectModelRoute({
        role: "reviewer",
        task: "docs-review",
        complexity: null as never,
      }),
    ).toThrow(/complexity/);
  });

  test("sanitizeRoute rejects unknown backends and out-of-order reasoning", () => {
    expect(() =>
      sanitizeRoute(
        {
          ...ROUTER_OUTPUT,
          implementer: { ...ROUTER_OUTPUT.implementer, model: "not-allowed" },
        },
        { constraints: BASE_CONSTRAINTS },
      ),
    ).toThrow(/allowedBackends/);

    expect(() =>
      sanitizeRoute(
        {
          ...ROUTER_OUTPUT,
          implementer: { ...ROUTER_OUTPUT.implementer, provider: " " },
        },
        { constraints: BASE_CONSTRAINTS },
      ),
    ).toThrow(/provider cannot be empty/);

    expect(() =>
      sanitizeRoute(
        {
          ...ROUTER_OUTPUT,
          implementer: { ...ROUTER_OUTPUT.implementer, reasoning: "minimal" },
        },
        { constraints: BASE_CONSTRAINTS },
      ),
    ).toThrow(/active reasoning order/);
  });

  test("sanitizeRoute validates allowed reasoning, min, and max constraints", () => {
    expect(() =>
      sanitizeRoute(ROUTER_OUTPUT, {
        constraints: { ...BASE_CONSTRAINTS, allowedReasoning: ["low", "minimal"] },
      }),
    ).toThrow(/allowedReasoning minimal/);
    expect(() =>
      sanitizeRoute(ROUTER_OUTPUT, {
        constraints: { ...BASE_CONSTRAINTS, minReasoning: "minimal" },
      }),
    ).toThrow(/minReasoning minimal/);
    expect(() =>
      sanitizeRoute(ROUTER_OUTPUT, {
        constraints: { ...BASE_CONSTRAINTS, maxReasoning: "minimal" },
      }),
    ).toThrow(/maxReasoning minimal/);
  });

  test("sanitizeRoute treats allowedReasoning as a membership allowlist", () => {
    expect(() =>
      sanitizeRoute(ROUTER_OUTPUT, {
        constraints: {
          ...BASE_CONSTRAINTS,
          allowedReasoning: ["low", "high", "xhigh"],
        },
      }),
    ).toThrow(/outside allowedReasoning/);

    const clamped = sanitizeRoute(
      {
        ...ROUTER_OUTPUT,
        implementer: { ...ROUTER_OUTPUT.implementer, reasoning: "low" },
        reviewer: { ...ROUTER_OUTPUT.reviewer, reasoning: "low" },
      },
      {
        constraints: {
          ...BASE_CONSTRAINTS,
          allowedReasoning: ["low", "high", "xhigh"],
        },
        declaredSurfaces: ["journal"],
      },
    );
    expect(clamped.implementer?.reasoning).toBe("high");
    expect(clamped.reviewer?.reasoning).toBe("high");

    const downward = sanitizeRoute(
      {
        ...ROUTER_OUTPUT,
        implementer: { ...ROUTER_OUTPUT.implementer, reasoning: "xhigh" },
        reviewer: { ...ROUTER_OUTPUT.reviewer, reasoning: "xhigh" },
      },
      {
        constraints: {
          ...BASE_CONSTRAINTS,
          allowedReasoning: ["low", "medium", "xhigh"],
          maxReasoning: "high",
        },
      },
    );
    expect(downward.implementer?.reasoning).toBe("medium");
    expect(downward.reviewer?.reasoning).toBe("medium");
  });

  test("sanitizeRoute uses caller-declared candidates as trusted floor input", () => {
    const route = sanitizeRoute(
      {
        ...ROUTER_OUTPUT,
        surfaces: ["docs"],
        risks: [],
        implementer: { ...ROUTER_OUTPUT.implementer, reasoning: "low" },
        reviewer: { ...ROUTER_OUTPUT.reviewer, reasoning: "low" },
      },
      {
        constraints: BASE_CONSTRAINTS,
        declaredSurfaces: ["workflow-sdk"],
        declaredRisks: ["replay"],
      },
    );
    expect(route.surfaces).toEqual(["workflow-sdk", "docs"]);
    expect(route.risks).toEqual(["replay"]);
    expect(route.implementer?.reasoning).toBe("high");
    expect(route.reviewer?.reasoning).toBe("high");
  });

  test("sanitizeRoute fails when critical floor exceeds maxReasoning", () => {
    expect(() =>
      sanitizeRoute(ROUTER_OUTPUT, {
        constraints: { ...BASE_CONSTRAINTS, maxReasoning: "high" },
        declaredRisks: ["data-loss"],
      }),
    ).toThrow(/above maxReasoning/);
  });

  test("sanitizeRoute rejects custom reasoning orders missing critical floor levels", () => {
    expect(() =>
      sanitizeRoute(ROUTER_OUTPUT, {
        constraints: {
          ...BASE_CONSTRAINTS,
          reasoningOrder: ["off", "minimal", "low", "medium"],
          allowedReasoning: ["low", "medium"],
          maxReasoning: "medium",
        },
      }),
    ).toThrow(/critical floor level high/);
  });

  test("sanitizeRoute drops unknown router classifications but preserves unknown sentinel", () => {
    const route = sanitizeRoute(
      {
        ...ROUTER_OUTPUT,
        surfaces: ["unknown", "docs", "invented-surface"],
        risks: ["unknown", "invented-risk"],
      },
      { constraints: BASE_CONSTRAINTS },
    );
    expect(route.surfaces).toEqual(["unknown", "docs"]);
    expect(route.risks).toEqual(["unknown"]);
    expect(route.rationale).toContain("dropped unknown value invented-surface");
    expect(route.rationale).toContain("dropped unknown value invented-risk");
  });

  test("buildRoutingPrompt includes candidates and hard routing bounds", () => {
    const prompt = buildRoutingPrompt({
      key: "router-preflight",
      request: "Implement a journal migration",
      specPath: ".specs/journal.md",
      target: "/repo",
      candidateSurfaces: ["journal", "workflow-sdk"],
      candidateRisks: ["migration", "replay"],
      constraints: BASE_CONSTRAINTS,
    });
    expect(prompt).toContain("Allowed output backends: codex/gpt-5.5, claude/claude-opus-4-8");
    expect(prompt).toContain("Allowed output reasoning: low, medium, high, xhigh");
    expect(prompt).toContain("Caller-declared candidate surfaces: journal, workflow-sdk");
    expect(prompt).toContain("Caller-declared candidate risks: migration, replay");
    expect(prompt).toContain("Spec path: .specs/journal.md");
  });

  test("routeWithAgent uses router backend and read-only policy before sanitizing", async () => {
    let capturedSpec:
      | {
          provider?: string;
          model?: string;
          reasoning?: string;
          toolPolicy?: string;
          prompt?: string;
        }
      | undefined;
    const ctx = {
      run: { id: "run_test", target: "/repo" },
      agent: async (spec: typeof capturedSpec) => {
        capturedSpec = spec;
        return {
          ...ROUTER_OUTPUT,
          implementer: { ...ROUTER_OUTPUT.implementer, reasoning: "low" },
          reviewer: { ...ROUTER_OUTPUT.reviewer, reasoning: "low" },
        };
      },
    } as unknown as Ctx;

    const route = await routeWithAgent(ctx, {
      key: "router-preflight",
      request: "Review workflow SDK replay behavior",
      target: "/repo",
      candidateSurfaces: ["workflow-sdk"],
      candidateRisks: ["replay"],
      constraints: {
        ...BASE_CONSTRAINTS,
        router: CLAUDE_BACKEND,
      },
    });

    expect(capturedSpec?.provider).toBe("claude");
    expect(capturedSpec?.model).toBe("claude-opus-4-8");
    expect((capturedSpec as { key?: string } | undefined)?.key).toBe("router-preflight");
    expect(capturedSpec?.reasoning).toBe("xhigh");
    expect(capturedSpec?.toolPolicy).toBe("read-only");
    expect(capturedSpec?.prompt).toContain("workflow-sdk");
    expect(route.implementer?.reasoning).toBe("high");
    expect(route.reviewer?.reasoning).toBe("high");
  });

  test("routeWithAgent rejects blank keys before invoking the router", async () => {
    let called = false;
    const ctx = {
      run: { id: "run_test", target: "/repo" },
      agent: async () => {
        called = true;
        return ROUTER_OUTPUT;
      },
    } as unknown as Ctx;

    await expect(
      routeWithAgent(ctx, {
        key: " ",
        request: "Review workflow SDK replay behavior",
        target: "/repo",
        constraints: BASE_CONSTRAINTS,
      }),
    ).rejects.toThrow(/key cannot be empty/);
    expect(called).toBe(false);
  });

  test("routeWithAgent fails fast when declared critical floor exceeds maxReasoning", async () => {
    let called = false;
    const ctx = {
      run: { id: "run_test", target: "/repo" },
      agent: async () => {
        called = true;
        return ROUTER_OUTPUT;
      },
    } as unknown as Ctx;

    await expect(
      routeWithAgent(ctx, {
        key: "router-preflight",
        request: "Review data loss risk",
        target: "/repo",
        candidateRisks: ["data-loss"],
        constraints: { ...BASE_CONSTRAINTS, maxReasoning: "high" },
      }),
    ).rejects.toThrow(/above maxReasoning/);
    expect(called).toBe(false);
  });

  test("example workflow executes clean session turns with route timeouts", async () => {
    const store = JournalStore.memory();
    const provider = new ExampleSessionProvider("clean");
    const kernel = new RealmKernel(store, {
      idgen: () => "run_example_clean",
      clock: () => 1,
      rng: () => 0.5,
      agents: testAgentRegistry(provider),
    });

    const handle = await kernel.run<{
      status: string;
      rounds: unknown[];
      remainingFindings: unknown[];
    }>(
      exampleWorkflow,
      {
        task: "review routing",
        candidateSurfaces: ["workflow-sdk"],
        candidateRisks: ["replay"],
      },
      { name: "model-routing-example", target: process.cwd() },
    );

    expect(handle.status).toBe("finished");
    expect(handle.output).toBeDefined();
    const output = handle.output;
    if (output === undefined) throw new Error("expected workflow output");
    expect(output.status).toBe("clean");
    expect(output.rounds).toHaveLength(1);
    expect(output.remainingFindings).toEqual([]);
    expect(provider.calls.map((call) => call.key)).toEqual([
      "model-router",
      "__session.implementer.implement-1",
      "__session.reviewer.review-1",
    ]);
    expect(provider.calls[0]?.toolPolicy).toBe("read-only");
    expect(provider.calls[1]?.timeoutMs).toBe(111000);
    expect(provider.calls[2]?.timeoutMs).toBe(222000);
    expect(provider.calls[2]?.toolPolicy).toBe("read-only");
  });

  test("example workflow honors the route maxRounds hint", async () => {
    const store = JournalStore.memory();
    const provider = new ExampleSessionProvider("always-findings");
    const kernel = new RealmKernel(store, {
      idgen: () => "run_example_max_rounds",
      clock: () => 1,
      rng: () => 0.5,
      agents: testAgentRegistry(provider),
    });

    const handle = await kernel.run<{
      status: string;
      rounds: unknown[];
      remainingFindings: unknown[];
    }>(
      exampleWorkflow,
      {
        task: "review routing",
        candidateSurfaces: ["workflow-sdk"],
        candidateRisks: ["replay"],
      },
      { name: "model-routing-example", target: process.cwd() },
    );

    expect(handle.status).toBe("finished");
    expect(handle.output).toBeDefined();
    const output = handle.output;
    if (output === undefined) throw new Error("expected workflow output");
    expect(output.status).toBe("max-rounds-reached");
    expect(output.rounds).toHaveLength(2);
    expect(output.remainingFindings).toHaveLength(1);
    expect(provider.calls.map((call) => call.key)).toEqual([
      "model-router",
      "__session.implementer.implement-1",
      "__session.reviewer.review-1",
      "__session.implementer.fix-2",
      "__session.reviewer.review-2",
    ]);
  });

  test("example workflow fails loud when the daemon lacks the router backend", async () => {
    const store = JournalStore.memory();
    const provider: AgentProvider = {
      name: "mock",
      async generate(): Promise<AgentResult> {
        return { text: JSON.stringify(ROUTER_OUTPUT), transcript: [] };
      },
    };
    const kernel = new RealmKernel(store, {
      idgen: () => "run_router_backend",
      clock: () => 1,
      rng: () => 0.5,
      agents: new AgentProviderRegistry().register(provider),
    });

    await expect(
      kernel.run(
        exampleWorkflow,
        {
          task: "review routing",
          candidateSurfaces: ["workflow-sdk"],
          candidateRisks: ["replay"],
        },
        { name: "model-routing-example", target: process.cwd() },
      ),
    ).rejects.toThrow(/no agent provider registered for "claude"/);
    expect(store.getRun("run_router_backend")?.status).toBe("failed");
  });
});
