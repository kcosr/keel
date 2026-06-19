import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInvocation, AgentProvider, AgentResult } from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { RealmKernel } from "./realm-host.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function kernel(store: JournalStore, provider: AgentProvider): RealmKernel {
  return new RealmKernel(store, {
    idgen: () => "run_workspace_setup",
    agents: new AgentProviderRegistry().register(provider),
  });
}

describe("workspace setup commands", () => {
  test("runs setup before an agent uses the workspace", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-");
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "reader",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        invocation = inv;
        return {
          text: readFileSync(join(inv.cwd ?? "", "generated.txt"), "utf8"),
          transcript: [],
        };
      },
    };
    const workflow = {
      name: "workspace-setup-agent",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const workspace = await ctx.workspace({
            key: "prepared",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                {
                  key: "generate",
                  command: "/bin/sh",
                  args: ["-c", "printf prepared > generated.txt"],
                },
              ],
            },
          });
          return await ctx.agent({ key: "inspect", provider: "reader", prompt: "read", workspace });
        }
      `,
    };

    const result = await kernel(store, provider).run<string>(
      workflow,
      { workspace },
      { target: workspace },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toBe("prepared");
    expect(invocation?.cwd).toBe(workspace);
    expect(store.getAgentWorkspace("run_workspace_setup", "prepared")).toMatchObject({
      setupStatus: "completed",
      activeHolderKind: null,
    });
    expect(
      store.getLatestAttempt("run_workspace_setup", "workspace.setup.prepared.generate"),
    ).toMatchObject({
      effectType: "workspace_setup",
      status: "completed",
    });
    expect(store.listEvents("run_workspace_setup").map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "workspace.setup.started",
        "workspace.setup.command.started",
        "workspace.setup.command.completed",
        "workspace.setup.completed",
      ]),
    );
  });

  test("reuses completed setup for repeated workspace resolution", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-reuse-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-reuse",
      source: `
        import { type Ctx } from "@kcosr/keel";
        const spec = (workspace: string) => ({
          key: "prepared",
          mode: "direct" as const,
          path: workspace,
          setup: {
            capabilities: { fs: "workspace-write" as const, shell: true, network: "none" as const },
            commands: [
              {
                key: "append",
                command: "/bin/sh",
                args: ["-c", "printf run >> count.txt"],
              },
            ],
          },
        });
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const workspace = await ctx.workspace(spec(input.workspace));
          await ctx.workspace(spec(input.workspace));
          const read = await ctx.command({
            key: "read-count",
            workspace,
            cwd: ".",
            mode: "argv",
            argv: ["/bin/sh", "-c", "cat count.txt"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          return read.stdout.text;
        }
      `,
    };

    const result = await kernel(store, provider).run<string>(
      workflow,
      { workspace },
      { target: workspace },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toBe("run");
  });

  test("shares one setup execution across parallel workspace resolution", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-parallel-");
    const provider: AgentProvider = {
      name: "noop",
      async generate(): Promise<AgentResult> {
        return { text: "unused", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-parallel",
      source: `
        import { type Ctx } from "@kcosr/keel";
        const spec = (workspace: string) => ({
          key: "prepared",
          mode: "direct" as const,
          path: workspace,
          setup: {
            capabilities: { fs: "workspace-write" as const, shell: true, network: "none" as const },
            commands: [
              {
                key: "append",
                command: "/bin/sh",
                args: ["-c", "sleep 0.05; printf run >> count.txt"],
              },
            ],
          },
        });
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const [first] = await Promise.all([
            ctx.workspace(spec(input.workspace)),
            ctx.workspace(spec(input.workspace)),
          ]);
          const read = await ctx.command({
            key: "read-count",
            workspace: first,
            cwd: ".",
            mode: "argv",
            argv: ["/bin/sh", "-c", "cat count.txt"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          return read.stdout.text;
        }
      `,
    };

    const result = await kernel(store, provider).run<string>(
      workflow,
      { workspace },
      { target: workspace },
    );

    expect(result.status).toBe("finished");
    expect(result.output).toBe("run");
    expect(
      store
        .listEvents("run_workspace_setup")
        .filter((event) => event.type === "workspace.setup.started"),
    ).toHaveLength(1);
  });

  test("failed setup prevents provider invocation", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-workspace-setup-fail-");
    let called = false;
    const provider: AgentProvider = {
      name: "reader",
      async generate(): Promise<AgentResult> {
        called = true;
        return { text: "called", transcript: [] };
      },
    };
    const workflow = {
      name: "workspace-setup-fail",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }): Promise<string> {
          const workspace = await ctx.workspace({
            key: "prepared",
            mode: "direct",
            path: input.workspace,
            setup: {
              capabilities: { fs: "workspace-write", shell: true, network: "none" },
              commands: [
                { key: "fail", command: "/bin/sh", args: ["-c", "printf nope >&2; exit 7"] },
              ],
            },
          });
          return await ctx.agent({ key: "inspect", provider: "reader", prompt: "read", workspace });
        }
      `,
    };

    await expect(
      kernel(store, provider).run<string>(workflow, { workspace }, { target: workspace }),
    ).rejects.toThrow(/command fail failed/);
    expect(called).toBe(false);
    expect(store.getAgentWorkspace("run_workspace_setup", "prepared")).toMatchObject({
      setupStatus: "failed",
      failureSeen: true,
      activeHolderKind: null,
    });
    expect(store.listEvents("run_workspace_setup").map((event) => event.type)).toContain(
      "workspace.setup.failed",
    );
  });
});
