import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "../../agents/secrets.ts";
import { JournalStore } from "../../journal/store.ts";
import { RealmKernel } from "./realm-host.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.AMBIENT_SHOULD_NOT_LEAK = undefined;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function kernel(store: JournalStore, extra: Record<string, unknown> = {}): RealmKernel {
  let id = 0;
  let clock = 1_000;
  return new RealmKernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => clock++,
    rng: () => 0.5,
    ...extra,
  });
}

describe("ctx.command", () => {
  test("runs in an explicit workspace and replays a completed result without spawning again", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-workspace-");
    const seen: string[] = [];
    const workflow = {
      name: "command-replay",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }) {
          const workspace = await ctx.workspace({ key: "impl", mode: "direct", path: input.workspace });
          const spec = {
            key: "count",
            workspace,
            cwd: ".",
            mode: "argv" as const,
            argv: ["/bin/sh", "-c", "printf hello; printf err >&2; echo run >> count.txt"],
            capabilities: { fs: "workspace-write" as const, shell: true, network: "none" as const },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          };
          const first = await ctx.command(spec);
          const second = await ctx.command(spec);
          return {
            first: first.stdout.text,
            second: second.stdout.text,
            stderr: second.stderr.text,
            attempt: second.attempt,
            workspaceId: second.workspaceId,
          };
        }
      `,
    };

    const handle = await kernel(store, { onStepExecute: (key: string) => seen.push(key) }).run<{
      first: string;
      second: string;
      stderr: string;
      attempt: number;
      workspaceId: string;
    }>(workflow, { workspace }, { name: "command-replay", target: workspace });

    expect(handle.status).toBe("finished");
    expect(handle.output).toMatchObject({
      first: "hello",
      second: "hello",
      stderr: "err",
      attempt: 1,
    });
    expect(readFileSync(join(workspace, "count.txt"), "utf8")).toBe("run\n");
    expect(seen).toEqual(["command.count"]);
    expect(store.getJournalRow("run_0", "command.count", 1)).toMatchObject({
      effectType: "command",
      status: "completed",
    });
    expect(
      store
        .listEvents("run_0")
        .map((event) => event.type)
        .filter((type) => type.startsWith("command.")),
    ).toEqual(["command.started", "command.completed"]);
  });

  test("commits nonzero results and rethrows from replay for failureMode throw", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-failure-");
    const workflow = {
      name: "command-failure",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }) {
          const workspace = await ctx.workspace({ key: "impl", mode: "direct", path: input.workspace });
          const spec = {
            key: "verify",
            workspace,
            cwd: ".",
            mode: "shell" as const,
            shell: "echo run >> fail-count.txt; echo bad >&2; exit 7",
            capabilities: { fs: "workspace-write" as const, shell: true, network: "none" as const },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          };
          const names: string[] = [];
          for (let i = 0; i < 2; i += 1) {
            try {
              await ctx.command(spec);
            } catch (err) {
              names.push((err as Error).name);
            }
          }
          return names;
        }
      `,
    };

    const handle = await kernel(store).run<string[]>(
      workflow,
      { workspace },
      { name: "command-failure", target: workspace },
    );

    expect(handle.output).toEqual(["CommandFailure", "CommandFailure"]);
    expect(readFileSync(join(workspace, "fail-count.txt"), "utf8")).toBe("run\n");
    const result = JSON.parse(
      store.getJournalRow("run_0", "command.verify", 1)?.resultInline ?? "{}",
    );
    expect(result).toMatchObject({
      status: "exited",
      exitCode: 7,
      error: { kind: "nonzero-exit" },
    });
  });

  test("uses the explicit environment allowlist plus literal vars and granted secrets", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-env-");
    const secrets = new SecretStore();
    process.env.AMBIENT_SHOULD_NOT_LEAK = "leaked";
    const workflow = {
      name: "command-env",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }) {
          const workspace = await ctx.workspace({ key: "impl", mode: "direct", path: input.workspace });
          const result = await ctx.command({
            key: "env",
            workspace,
            cwd: ".",
            mode: "shell",
            shell: 'printf "%s|%s|%s" "\${AMBIENT_SHOULD_NOT_LEAK-unset}" "$LITERAL" "$TOKEN"',
            capabilities: {
              fs: "workspace-write",
              shell: true,
              network: "none",
              secrets: ["TOKEN"],
            },
            environment: { vars: { LITERAL: "literal" }, secrets: ["TOKEN"] },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          return result.stdout.text;
        }
      `,
    };

    const handle = await kernel(store, { secrets }).run<string>(
      workflow,
      { workspace },
      { name: "command-env", target: workspace, runSecrets: { TOKEN: "secret-value" } },
    );

    expect(handle.output).toBe("unset|literal|secret-value");
    const started = store.listEvents("run_0").find((event) => event.type === "command.started");
    expect(started?.payloadJson).toContain("TOKEN");
    expect(started?.payloadJson).not.toContain("secret-value");
  });

  test("rejects raw workspace paths and symlink cwd escapes before spawning", async () => {
    const rawStore = JournalStore.memory();
    const workspace = tempDir("keel-command-raw-");
    const rawWorkflow = {
      name: "command-raw-workspace",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }) {
          return await ctx.command({
            key: "bad",
            workspace: input.workspace,
            cwd: ".",
            mode: "argv",
            argv: ["/bin/echo", "bad"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
        }
      `,
    };
    await expect(
      kernel(rawStore).run(rawWorkflow, { workspace }, { name: "raw", target: workspace }),
    ).rejects.toThrow(/WorkspaceHandle/);
    expect(rawStore.listJournalRows("run_0")).toEqual([]);

    const escapeStore = JournalStore.memory();
    const root = tempDir("keel-command-root-");
    const outside = tempDir("keel-command-outside-");
    symlinkSync(outside, join(root, "outside"));
    const escapeWorkflow = {
      name: "command-cwd-escape",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }) {
          const workspace = await ctx.workspace({ key: "impl", mode: "direct", path: input.workspace });
          return await ctx.command({
            key: "escape",
            workspace,
            cwd: "outside",
            mode: "argv",
            argv: ["/bin/echo", "bad"],
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
        }
      `,
    };
    await expect(
      kernel(escapeStore).run(
        escapeWorkflow,
        { workspace: root },
        { name: "escape", target: root },
      ),
    ).rejects.toThrow(/escapes workspace/);
    expect(escapeStore.getJournalRow("run_0", "command.escape", 1)).toBeNull();
  });

  test("truncates bounded output and stores large command results as artifacts", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-output-");
    const workflow = {
      name: "command-output",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }) {
          const workspace = await ctx.workspace({ key: "impl", mode: "direct", path: input.workspace });
          return await ctx.command({
            key: "big",
            workspace,
            cwd: ".",
            mode: "shell",
            shell: "printf '%*s' 1500 '' | tr ' ' x",
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1200,
            maxStderrBytes: 1000,
            failureMode: "return",
          });
        }
      `,
    };

    const handle = await kernel(store).run<{
      stdout: { text: string; byteLength: number; truncated: boolean; omittedBytes: number };
      output: { resultArtifactBacked: boolean };
    }>(workflow, { workspace }, { name: "output", target: workspace });

    expect(handle.output?.stdout.byteLength).toBe(1500);
    expect(handle.output?.stdout.text).toHaveLength(1200);
    expect(handle.output?.stdout.truncated).toBe(true);
    expect(handle.output?.stdout.omittedBytes).toBe(300);
    expect(handle.output?.output.resultArtifactBacked).toBe(true);
    const row = store.getJournalRow("run_0", "command.big", 1);
    expect(row?.resultInline).toBeNull();
    expect(row?.resultArtifact).not.toBeNull();
    expect(existsSync(join(workspace, "x"))).toBe(false);
  });

  test("returns timeout results when failureMode is return", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-timeout-");
    const workflow = {
      name: "command-timeout",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { workspace: string }) {
          const workspace = await ctx.workspace({ key: "impl", mode: "direct", path: input.workspace });
          return await ctx.command({
            key: "timeout",
            workspace,
            cwd: ".",
            mode: "shell",
            shell: "sleep 2",
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 50,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
            failureMode: "return",
          });
        }
      `,
    };

    const handle = await kernel(store).run<{
      status: string;
      timedOut: boolean;
      error?: { kind: string };
    }>(workflow, { workspace }, { name: "timeout", target: workspace });

    expect(handle.output).toMatchObject({
      status: "timed-out",
      timedOut: true,
      error: { kind: "timeout" },
    });
  });
});
