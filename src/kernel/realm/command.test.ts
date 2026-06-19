import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { SecretStore } from "../../agents/secrets.ts";
import { hashJson } from "../../hash.ts";
import { JournalStore } from "../../journal/store.ts";
import { WORKFLOW_SDK_ABI_VERSION } from "../../workflow-definitions/snapshot.ts";
import {
  MAX_WORKFLOW_COMMAND_STALL_TIMEOUT_MS,
  MAX_WORKFLOW_COMMAND_STDERR_BYTES,
  MAX_WORKFLOW_COMMAND_STDOUT_BYTES,
  MAX_WORKFLOW_COMMAND_TIMEOUT_MS,
  WORKFLOW_COMMAND_KILL_GRACE_MS,
  WORKFLOW_COMMAND_RUNNER_VERSION,
  buildCommandEnvironment,
  normalizeWorkflowCommandSpec,
} from "../command.ts";
import {
  type BoundedProcessChild,
  type BoundedProcessSpawn,
  runBoundedProcess,
} from "../process-runner.ts";
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

function initGitRepo(path: string): void {
  execFileSync("git", ["init"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "keel@example.test"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Keel Test"], { cwd: path });
  writeFileSync(join(path, "README.md"), "base\n");
  execFileSync("git", ["add", "README.md"], { cwd: path });
  execFileSync("git", ["commit", "-m", "base"], { cwd: path, stdio: "ignore" });
}

function validCommandSpec(): Record<string, unknown> {
  return {
    key: "validate",
    workspace: { id: "workspace", identityHash: "workspace-hash" },
    cwd: ".",
    mode: "argv",
    argv: ["/bin/echo", "ok"],
    capabilities: {
      fs: "workspace-write",
      shell: true,
      network: "none",
      secrets: ["TOKEN"],
    },
    environment: {
      vars: { LITERAL: "value" },
      secrets: ["TOKEN"],
    },
    timeoutMs: 1000,
    stallTimeoutMs: 500,
    maxStdoutBytes: 1000,
    maxStderrBytes: 1000,
    successExitCodes: [0],
    failureMode: "throw",
  };
}

function validShellCommandSpec(shell = "printf ok"): Record<string, unknown> {
  const spec = validCommandSpec();
  spec.mode = "shell";
  removeCommandSpecField(spec, "argv");
  spec.shell = shell;
  return spec;
}

function removeCommandSpecField(spec: Record<string, unknown>, key: string): void {
  Reflect.deleteProperty(spec, key);
}

function commandInputHash(spec: Record<string, unknown>): string {
  return hashJson(normalizeWorkflowCommandSpec(spec).identity);
}

function commandCapabilities(spec: Record<string, unknown>): Record<string, unknown> {
  return spec.capabilities as Record<string, unknown>;
}

function commandEnvironment(spec: Record<string, unknown>): Record<string, unknown> {
  return spec.environment as Record<string, unknown>;
}

function commandWorkflow(commandSource: string): { name: string; source: string } {
  return {
    name: "command-case",
    source: `
      import { type Ctx } from "@kcosr/keel";
      export default async function wf(ctx: Ctx, input: { workspace: string }) {
        const workspace = await ctx.workspace({ key: "impl", mode: "direct", path: input.workspace });
        ${commandSource}
      }
    `,
  };
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await Bun.sleep(10);
  }
  throw new Error("condition not met in time");
}

class FakeChild extends EventEmitter implements BoundedProcessChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 12345;
  exitCode: number | null = null;
  signalCode: string | null = null;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    queueMicrotask(() => this.emit("close", null, this.signalCode));
    return true;
  }
}

describe("ctx.command", () => {
  test("normalization rejects invalid command validation and identity inputs", () => {
    const cases: Array<{
      name: string;
      mutate: (spec: Record<string, unknown>) => void;
      error: RegExp;
    }> = [
      {
        name: "capabilities without shell true",
        mutate: (spec) => {
          commandCapabilities(spec).shell = false;
        },
        error: /capabilities\.shell must be true/,
      },
      {
        name: "fs without workspace-write",
        mutate: (spec) => {
          commandCapabilities(spec).fs = "read";
        },
        error: /capabilities\.fs must be "workspace-write"/,
      },
      {
        name: "unknown mode",
        mutate: (spec) => {
          spec.mode = "raw";
          removeCommandSpecField(spec, "argv");
          spec.shell = "printf ok";
        },
        error: /mode must be "argv" or "shell"/,
      },
      {
        name: "empty argv",
        mutate: (spec) => {
          spec.argv = [];
        },
        error: /argv must not be empty/,
      },
      {
        name: "non-string argv item",
        mutate: (spec) => {
          spec.argv = ["/bin/echo", 1];
        },
        error: /argv\[1\] must be a non-empty string/,
      },
      {
        name: "empty shell",
        mutate: (spec) => {
          spec.mode = "shell";
          removeCommandSpecField(spec, "argv");
          spec.shell = " ";
        },
        error: /shell must be a non-empty string/,
      },
      {
        name: "missing capabilities",
        mutate: (spec) => {
          removeCommandSpecField(spec, "capabilities");
        },
        error: /capabilities is required and must be a plain object/,
      },
      {
        name: "toolPolicy",
        mutate: (spec) => {
          spec.toolPolicy = "read-only";
        },
        error: /toolPolicy is not supported/,
      },
      {
        name: "allowTools",
        mutate: (spec) => {
          spec.allowTools = ["Read"];
        },
        error: /allowTools is not supported/,
      },
      {
        name: "denyTools",
        mutate: (spec) => {
          spec.denyTools = ["Bash"];
        },
        error: /denyTools is not supported/,
      },
      {
        name: "invalid env name",
        mutate: (spec) => {
          commandEnvironment(spec).vars = { "1BAD": "value" };
        },
        error: /environment\.vars\.1BAD must match/,
      },
      {
        name: "reserved KEEL_ env name",
        mutate: (spec) => {
          commandEnvironment(spec).vars = { KEEL_TOKEN: "value" };
        },
        error: /environment\.vars\.KEEL_TOKEN must not start with KEEL_/,
      },
      {
        name: "duplicate secret names",
        mutate: (spec) => {
          commandEnvironment(spec).secrets = ["TOKEN", "TOKEN"];
        },
        error: /environment\.secrets must not contain duplicate TOKEN/,
      },
      {
        name: "literal and secret name collision",
        mutate: (spec) => {
          commandEnvironment(spec).vars = { TOKEN: "literal" };
        },
        error: /cannot define TOKEN in both vars and secrets/,
      },
      {
        name: "ungranted secret ref",
        mutate: (spec) => {
          commandCapabilities(spec).secrets = [];
        },
        error: /environment\.secrets includes TOKEN.*capabilities\.secrets does not grant it/,
      },
      {
        name: "missing timeout",
        mutate: (spec) => {
          removeCommandSpecField(spec, "timeoutMs");
        },
        error: /timeoutMs must be a positive integer/,
      },
      {
        name: "timeout above maximum",
        mutate: (spec) => {
          spec.timeoutMs = MAX_WORKFLOW_COMMAND_TIMEOUT_MS + 1;
        },
        error: /timeoutMs must be <=/,
      },
      {
        name: "stall timeout above maximum",
        mutate: (spec) => {
          spec.timeoutMs = MAX_WORKFLOW_COMMAND_TIMEOUT_MS;
          spec.stallTimeoutMs = MAX_WORKFLOW_COMMAND_STALL_TIMEOUT_MS + 1;
        },
        error: /stallTimeoutMs must be <=/,
      },
      {
        name: "missing stdout cap",
        mutate: (spec) => {
          removeCommandSpecField(spec, "maxStdoutBytes");
        },
        error: /maxStdoutBytes must be a positive integer/,
      },
      {
        name: "stdout cap above maximum",
        mutate: (spec) => {
          spec.maxStdoutBytes = MAX_WORKFLOW_COMMAND_STDOUT_BYTES + 1;
        },
        error: /maxStdoutBytes must be <=/,
      },
      {
        name: "missing stderr cap",
        mutate: (spec) => {
          removeCommandSpecField(spec, "maxStderrBytes");
        },
        error: /maxStderrBytes must be a positive integer/,
      },
      {
        name: "stderr cap above maximum",
        mutate: (spec) => {
          spec.maxStderrBytes = MAX_WORKFLOW_COMMAND_STDERR_BYTES + 1;
        },
        error: /maxStderrBytes must be <=/,
      },
      {
        name: "empty success exit codes",
        mutate: (spec) => {
          spec.successExitCodes = [];
        },
        error: /successExitCodes must not be empty/,
      },
      {
        name: "out-of-range success exit code",
        mutate: (spec) => {
          spec.successExitCodes = [0, 256];
        },
        error: /successExitCodes\[1\] must be an integer from 0 to 255/,
      },
      {
        name: "duplicate success exit code",
        mutate: (spec) => {
          spec.successExitCodes = [0, 0];
        },
        error: /successExitCodes contains duplicate 0/,
      },
    ];

    for (const item of cases) {
      const spec = validCommandSpec();
      item.mutate(spec);
      try {
        expect(() => normalizeWorkflowCommandSpec(spec)).toThrow(item.error);
      } catch (err) {
        throw new Error(`${item.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  test("command identity hash changes for execution-affecting inputs", () => {
    const cases: Array<{
      name: string;
      base?: () => Record<string, unknown>;
      mutate: (spec: Record<string, unknown>) => void;
    }> = [
      {
        name: "cwd",
        mutate: (spec) => {
          spec.cwd = "nested";
        },
      },
      {
        name: "mode",
        mutate: (spec) => {
          spec.mode = "shell";
          removeCommandSpecField(spec, "argv");
          spec.shell = "printf ok";
        },
      },
      {
        name: "argv",
        mutate: (spec) => {
          spec.argv = ["/bin/echo", "changed"];
        },
      },
      {
        name: "shell",
        base: () => validShellCommandSpec("printf one"),
        mutate: (spec) => {
          spec.shell = "printf two";
        },
      },
      {
        name: "capabilities",
        mutate: (spec) => {
          commandCapabilities(spec).network = ["example.test"];
        },
      },
      {
        name: "environment vars",
        mutate: (spec) => {
          commandEnvironment(spec).vars = { LITERAL: "changed" };
        },
      },
      {
        name: "secret names",
        mutate: (spec) => {
          commandCapabilities(spec).secrets = ["OTHER"];
          commandEnvironment(spec).secrets = ["OTHER"];
        },
      },
      {
        name: "timeout",
        mutate: (spec) => {
          spec.timeoutMs = 2000;
        },
      },
      {
        name: "stall timeout",
        mutate: (spec) => {
          spec.stallTimeoutMs = 750;
        },
      },
      {
        name: "stdout cap",
        mutate: (spec) => {
          spec.maxStdoutBytes = 2000;
        },
      },
      {
        name: "stderr cap",
        mutate: (spec) => {
          spec.maxStderrBytes = 2000;
        },
      },
      {
        name: "success exit codes",
        mutate: (spec) => {
          spec.successExitCodes = [0, 2];
        },
      },
      {
        name: "failure mode",
        mutate: (spec) => {
          spec.failureMode = "return";
        },
      },
      {
        name: "bump",
        mutate: (spec) => {
          spec.bump = "v2";
        },
      },
    ];

    for (const item of cases) {
      const base = item.base?.() ?? validCommandSpec();
      const changed = item.base?.() ?? validCommandSpec();
      item.mutate(changed);
      const baseHash = commandInputHash(base);
      const changedHash = commandInputHash(changed);
      if (changedHash === baseHash) {
        throw new Error(`${item.name}: command identity hash did not change`);
      }
    }

    const identity = normalizeWorkflowCommandSpec(validCommandSpec()).identity;
    const baseHash = hashJson(identity);
    expect(
      hashJson({
        ...(identity as Record<string, unknown>),
        commandRunnerVersion: WORKFLOW_COMMAND_RUNNER_VERSION + 1,
      }),
    ).not.toBe(baseHash);
    expect(
      hashJson({
        ...(identity as Record<string, unknown>),
        workflowSdkAbiVersion: WORKFLOW_SDK_ABI_VERSION + 1,
      }),
    ).not.toBe(baseHash);
  });

  test("command identity excludes raw secrets, base env values, and runtime observations", () => {
    const spec = validCommandSpec();
    const command = normalizeWorkflowCommandSpec(spec);
    const identityHash = hashJson(command.identity);
    const firstEnv = buildCommandEnvironment(
      command.environment,
      [{ name: "TOKEN", value: "raw-secret-value-a" }],
      { PATH: "/tmp/base-env-a" },
    );
    const secondEnv = buildCommandEnvironment(
      command.environment,
      [{ name: "TOKEN", value: "raw-secret-value-b" }],
      { PATH: "/tmp/base-env-b" },
    );
    const observed = {
      stdout: "stdout-observation-a",
      stderr: "stderr-observation-a",
      exitCode: 9,
      durationMs: 1234,
      startedAtMs: 5000,
      finishedAtMs: 6234,
      pid: 98765,
      fileState: "observed-filesystem-state-a",
    };

    expect(firstEnv).toMatchObject({ PATH: "/tmp/base-env-a", TOKEN: "raw-secret-value-a" });
    expect(secondEnv).toMatchObject({ PATH: "/tmp/base-env-b", TOKEN: "raw-secret-value-b" });
    expect(observed.exitCode).toBe(9);
    expect(commandInputHash(spec)).toBe(identityHash);

    const identityText = JSON.stringify(command.identity);
    for (const excluded of [
      "raw-secret-value-a",
      "raw-secret-value-b",
      "/tmp/base-env-a",
      "/tmp/base-env-b",
      "stdout-observation-a",
      "stderr-observation-a",
      "observed-filesystem-state-a",
      "exitCode",
      "durationMs",
      "startedAtMs",
      "finishedAtMs",
      "pid",
    ]) {
      expect(identityText).not.toContain(excluded);
    }
  });

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

  test("missing executable returns a committed spawn-error result", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-spawn-error-");
    const workflow = commandWorkflow(`
      return await ctx.command({
        key: "missing",
        workspace,
        cwd: ".",
        mode: "argv",
        argv: ["/definitely/missing/keel-command-test-executable"],
        capabilities: { fs: "workspace-write", shell: true, network: "none" },
        timeoutMs: 5000,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
        failureMode: "return",
      });
    `);

    const handle = await kernel(store).run<{
      status: string;
      error?: { kind: string; message: string };
    }>(workflow, { workspace }, { name: "spawn-error", target: workspace });

    expect(handle.output).toMatchObject({
      status: "spawn-error",
      error: { kind: "spawn-error" },
    });
    expect(handle.output?.error?.message).toContain("ENOENT");
    expect(store.getJournalRow("run_0", "command.missing", 1)).toMatchObject({
      effectType: "command",
      status: "completed",
    });
  });

  test("runner records output-capture-error on stream errors with bounded output", async () => {
    const command = normalizeWorkflowCommandSpec({
      key: "stream-error",
      workspace: { id: "workspace" },
      cwd: ".",
      mode: "argv",
      argv: ["/bin/echo", "unused"],
      capabilities: { fs: "workspace-write", shell: true, network: "none" },
      timeoutMs: 5000,
      maxStdoutBytes: 4,
      maxStderrBytes: 1000,
      failureMode: "return",
    });
    const child = new FakeChild();
    const spawnProcess: BoundedProcessSpawn = () => {
      queueMicrotask(() => {
        child.stdout.write(Buffer.from("abcdef"));
        child.stdout.emit("error", new Error("pipe broke"));
      });
      return child;
    };

    const result = await runBoundedProcess({
      command,
      attempt: 1,
      cwd: process.cwd(),
      env: {},
      spawnProcess,
    });

    expect(result).toMatchObject({
      status: "output-capture-error",
      error: { kind: "output-capture-error" },
      stdout: {
        text: "abcd",
        byteLength: 6,
        truncated: true,
        omittedBytes: 2,
      },
    });
    expect(result.error?.message).toContain("stdout stream error");
    expect(result.error?.message).toContain("pipe broke");
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

  test("runs commands in a worktree workspace handle and releases the holder", async () => {
    const store = JournalStore.memory();
    const repo = tempDir("keel-command-repo-");
    initGitRepo(repo);
    const workspaceStore = tempDir("keel-command-workspaces-");
    const workflow = {
      name: "command-worktree",
      source: `
        import { type Ctx } from "@kcosr/keel";
        export default async function wf(ctx: Ctx, input: { repo: string }) {
          const workspace = await ctx.workspace({
            key: "impl",
            mode: "worktree",
            path: input.repo,
            retention: "retain",
          });
          const result = await ctx.command({
            key: "write",
            workspace,
            cwd: ".",
            mode: "shell",
            shell: "printf worktree > command.txt; pwd",
            capabilities: { fs: "workspace-write", shell: true, network: "none" },
            timeoutMs: 5000,
            maxStdoutBytes: 1000,
            maxStderrBytes: 1000,
          });
          return { workspaceId: result.workspaceId, stdout: result.stdout.text };
        }
      `,
    };

    const handle = await kernel(store, { workspaceStore }).run<{
      workspaceId: string;
      stdout: string;
    }>(workflow, { repo }, { name: "worktree", target: repo });

    expect(handle.status).toBe("finished");
    const row = store.getAgentWorkspace("run_0", handle.output?.workspaceId ?? "");
    expect(row).toMatchObject({
      mode: "worktree",
      status: "pending_review",
      activeHolderKind: null,
      activeHolderKey: null,
      activeHolderAttempt: null,
    });
    expect(row?.workspacePath).toBe(handle.output?.stdout.trim());
    expect(readFileSync(join(row?.workspacePath ?? "", "command.txt"), "utf8")).toBe("worktree");
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
    expect(store.getArtifact(row?.resultArtifact ?? "")).not.toBeNull();
    expect(existsSync(join(workspace, "x"))).toBe(false);
  });

  test("pending command after after-pending crash re-executes with the same attempt", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-after-pending-");
    const workflow = commandWorkflow(`
      const result = await ctx.command({
        key: "crash",
        workspace,
        cwd: ".",
        mode: "shell",
        shell: "echo run >> count.txt; printf ok",
        capabilities: { fs: "workspace-write", shell: true, network: "none" },
        timeoutMs: 5000,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
      });
      return { attempt: result.attempt, stdout: result.stdout.text };
    `);
    const crashing = kernel(store, {
      fault: (point: string, key: string) => {
        if (point === "after-pending" && key === "command.crash") throw new Error("CRASH");
      },
    });

    await expect(
      crashing.run(workflow, { workspace }, { name: "after-pending", target: workspace }),
    ).rejects.toThrow(/CRASH/);

    expect(store.getRun("run_0")?.status).toBe("running");
    expect(store.getJournalRow("run_0", "command.crash", 1)).toMatchObject({
      status: "pending",
      attempt: 1,
    });
    expect(existsSync(join(workspace, "count.txt"))).toBe(false);

    const resumed = await kernel(store).resume<{ attempt: number; stdout: string }>("run_0");

    expect(resumed.output).toEqual({ attempt: 1, stdout: "ok" });
    expect(readFileSync(join(workspace, "count.txt"), "utf8")).toBe("run\n");
    expect(store.getJournalRow("run_0", "command.crash", 1)).toMatchObject({
      status: "completed",
      attempt: 1,
    });
  });

  test("pending command after before-commit crash reruns without committing a partial result", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-before-commit-");
    const workflow = commandWorkflow(`
      const result = await ctx.command({
        key: "commit-crash",
        workspace,
        cwd: ".",
        mode: "shell",
        shell: "echo run >> count.txt; printf ok",
        capabilities: { fs: "workspace-write", shell: true, network: "none" },
        timeoutMs: 5000,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
      });
      return { attempt: result.attempt, stdout: result.stdout.text };
    `);
    const crashing = kernel(store, {
      fault: (point: string, key: string) => {
        if (point === "before-commit" && key === "command.commit-crash") {
          throw new Error("CRASH");
        }
      },
    });

    await expect(
      crashing.run(workflow, { workspace }, { name: "before-commit", target: workspace }),
    ).rejects.toThrow(/CRASH/);

    const pending = store.getJournalRow("run_0", "command.commit-crash", 1);
    expect(pending).toMatchObject({ status: "pending", resultArtifact: null, resultInline: null });
    expect(readFileSync(join(workspace, "count.txt"), "utf8")).toBe("run\n");

    const resumed = await kernel(store).resume<{ attempt: number; stdout: string }>("run_0");

    expect(resumed.output).toEqual({ attempt: 1, stdout: "ok" });
    expect(readFileSync(join(workspace, "count.txt"), "utf8")).toBe("run\nrun\n");
    expect(
      store.listEvents("run_0").filter((event) => event.type === "command.completed"),
    ).toHaveLength(1);
  });

  test("interrupted command execution remains pending and resumes with the same attempt", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-during-exec-");
    const workflow = commandWorkflow(`
      const result = await ctx.command({
        key: "during-exec",
        workspace,
        cwd: ".",
        mode: "shell",
        shell: "echo run >> count.txt; sleep 0.5; printf ok",
        capabilities: { fs: "workspace-write", shell: true, network: "none" },
        timeoutMs: 5000,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
      });
      return { attempt: result.attempt, stdout: result.stdout.text };
    `);
    const k = kernel(store);
    const { runId, done } = k.launch<{ attempt: number; stdout: string }>(
      workflow,
      { workspace },
      { name: "during-exec", target: workspace },
    );

    await until(
      () =>
        store.getJournalRow(runId, "command.during-exec", 1)?.status === "pending" &&
        existsSync(join(workspace, "count.txt")),
    );
    expect(k.interruptRun(runId, "pause")).toEqual({ runId, status: "interrupted" });

    await expect(done).resolves.toMatchObject({ runId, status: "interrupted" });
    expect(store.getJournalRow(runId, "command.during-exec", 1)).toMatchObject({
      status: "pending",
      attempt: 1,
      resultInline: null,
      resultArtifact: null,
    });
    expect(readFileSync(join(workspace, "count.txt"), "utf8")).toBe("run\n");

    const resumed = await k.resume<{ attempt: number; stdout: string }>(runId);

    expect(resumed.output).toEqual({ attempt: 1, stdout: "ok" });
    expect(readFileSync(join(workspace, "count.txt"), "utf8")).toBe("run\nrun\n");
  });

  test("pending command identity mismatch fails closed before re-execution", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-pending-mismatch-");
    const workflow = commandWorkflow(`
      const result = await ctx.command({
        key: "mismatch",
        workspace,
        cwd: ".",
        mode: "shell",
        shell: "echo run >> count.txt; printf ok",
        capabilities: { fs: "workspace-write", shell: true, network: "none" },
        timeoutMs: 5000,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
      });
      return result.stdout.text;
    `);
    const crashing = kernel(store, {
      fault: (point: string, key: string) => {
        if (point === "after-pending" && key === "command.mismatch") throw new Error("CRASH");
      },
    });

    await crashing
      .run(workflow, { workspace }, { name: "mismatch", target: workspace })
      .catch(() => null);
    const pending = store.getJournalRow("run_0", "command.mismatch", 1);
    if (!pending) throw new Error("expected pending command row");
    store.putJournalRow({ ...pending, inputHash: "changed-input-hash" });

    await expect(kernel(store).resume("run_0")).rejects.toThrow(/identity changed/);
    expect(existsSync(join(workspace, "count.txt"))).toBe(false);
  });

  test("changed identity after a completed command allocates the next attempt", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-attempt-plus-one-");
    const workflow = commandWorkflow(`
      const first = await ctx.command({
        key: "same-key",
        workspace,
        cwd: ".",
        mode: "shell",
        shell: "printf one",
        capabilities: { fs: "workspace-write", shell: true, network: "none" },
        timeoutMs: 5000,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
        failureMode: "return",
        bump: "one",
      });
      const second = await ctx.command({
        key: "same-key",
        workspace,
        cwd: ".",
        mode: "shell",
        shell: "printf two",
        capabilities: { fs: "workspace-write", shell: true, network: "none" },
        timeoutMs: 5000,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
        failureMode: "return",
        bump: "two",
      });
      return {
        first: { attempt: first.attempt, text: first.stdout.text },
        second: { attempt: second.attempt, text: second.stdout.text },
      };
    `);

    const handle = await kernel(store).run<{
      first: { attempt: number; text: string };
      second: { attempt: number; text: string };
    }>(workflow, { workspace }, { name: "attempt-plus-one", target: workspace });

    expect(handle.output).toEqual({
      first: { attempt: 1, text: "one" },
      second: { attempt: 2, text: "two" },
    });
    expect(store.getJournalRow("run_0", "command.same-key", 1)?.status).toBe("completed");
    expect(store.getJournalRow("run_0", "command.same-key", 2)?.status).toBe("completed");
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
      durationMs: number;
      error?: { kind: string };
    }>(workflow, { workspace }, { name: "timeout", target: workspace });

    expect(handle.output).toMatchObject({
      status: "timed-out",
      timedOut: true,
      error: { kind: "timeout" },
    });
    expect(handle.output?.durationMs).toBeLessThanOrEqual(
      50 + WORKFLOW_COMMAND_KILL_GRACE_MS + 500,
    );
  });

  test("returns stall results when no output arrives before stallTimeoutMs", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-stall-");
    const workflow = commandWorkflow(`
      return await ctx.command({
        key: "stall",
        workspace,
        cwd: ".",
        mode: "shell",
        shell: "sleep 2",
        capabilities: { fs: "workspace-write", shell: true, network: "none" },
        timeoutMs: 5000,
        stallTimeoutMs: 50,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
        failureMode: "return",
      });
    `);

    const handle = await kernel(store).run<{
      status: string;
      stalled: boolean;
      durationMs: number;
      error?: { kind: string };
    }>(workflow, { workspace }, { name: "stall", target: workspace });

    expect(handle.output).toMatchObject({
      status: "stalled",
      stalled: true,
      error: { kind: "stall" },
    });
    expect(handle.output?.durationMs).toBeLessThanOrEqual(
      50 + WORKFLOW_COMMAND_KILL_GRACE_MS + 500,
    );
  });

  test("silent commands do not stall when stallTimeoutMs is omitted", async () => {
    const store = JournalStore.memory();
    const workspace = tempDir("keel-command-no-stall-");
    const workflow = commandWorkflow(`
      return await ctx.command({
        key: "silent",
        workspace,
        cwd: ".",
        mode: "shell",
        shell: "sleep 0.1; printf done",
        capabilities: { fs: "workspace-write", shell: true, network: "none" },
        timeoutMs: 5000,
        maxStdoutBytes: 1000,
        maxStderrBytes: 1000,
        failureMode: "return",
      });
    `);

    const handle = await kernel(store).run<{
      status: string;
      timedOut: boolean;
      stalled: boolean;
      stdout: { text: string };
    }>(workflow, { workspace }, { name: "no-stall", target: workspace });

    expect(handle.output).toMatchObject({
      status: "exited",
      timedOut: false,
      stalled: false,
      stdout: { text: "done" },
    });
  });
});
