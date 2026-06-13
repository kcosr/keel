import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../agents/mock.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { KeelDaemon } from "../daemon/server.ts";
import {
  formatRunHeader,
  formatWatchEvent,
  parseExecuteArgs,
  parseLaunchArgs,
  parseLaunchInput,
  parseLifecycleArgs,
  parseRunArgs,
  parseWatchArgs,
  resolveWorkflowPath,
  workflowName,
} from "./keel.ts";

const CLI = new URL("./keel.ts", import.meta.url).pathname;
const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = new URL("chain.workflow.ts", FIX).pathname;
const gateUrl = new URL("gate.workflow.ts", FIX).pathname;

async function runCli(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("keel CLI", () => {
  test("help is a daemon-free install smoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-cli-help-"));
    try {
      const out = await runCli(["help"], dir);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("Usage: keel <command>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("link creates an @kcosr/keel SDK symlink for out-of-repo workflows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-link-"));
    try {
      const out = await runCli(["link", dir], dir);
      expect(out.code).toBe(0);

      const link = join(dir, "node_modules", "@kcosr", "keel");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);

      const workflow = join(dir, "wf.ts");
      await Bun.write(
        workflow,
        `import { passthrough } from "@kcosr/keel";\nexport const schema = passthrough<number>();\n`,
      );
      const imported = (await import(`${workflow}?t=${Date.now()}`)) as {
        schema: { parse(value: unknown): number };
      };
      expect(imported.schema.parse(3)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("link refuses to replace a real package directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-link-existing-"));
    try {
      const existing = join(dir, "node_modules", "@kcosr", "keel");
      mkdirSync(existing, { recursive: true });
      await Bun.write(join(existing, "package.json"), '{"name":"real-package"}\n');

      const out = await runCli(["link", dir], dir);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain("refusing to replace non-symlink");
      expect(existsSync(join(existing, "package.json"))).toBe(true);
      expect(readFileSync(join(existing, "package.json"), "utf8")).toContain("real-package");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("watch formatter renders agent event payloads", () => {
    expect(
      formatWatchEvent({
        seq: 234,
        type: "agent.event",
        payload: { key: "run-date", event: { type: "text", data: "RESULT 50\n" } },
        atMs: 123,
      }),
    ).toBe("[234] agent run-date text: RESULT 50\\n\n");
  });

  test("watch formatter supports raw JSON lines", () => {
    const event = {
      seq: 235,
      type: "agent.event",
      payload: { key: "run-date", event: { type: "tool_call", data: { command: "date" } } },
      atMs: 456,
    };
    expect(formatWatchEvent(event, { json: true })).toBe(`${JSON.stringify(event)}\n`);
  });

  test("watch formatter keeps unexpected agent event payloads visible", () => {
    expect(
      formatWatchEvent({
        seq: 236,
        type: "agent.event",
        payload: { provider: "future", detail: "new shape" },
        atMs: 789,
      }),
    ).toBe('[236] agent: {"provider":"future","detail":"new shape"}\n');
  });

  test("watch formatter redacts capability-looking strings", () => {
    const event = {
      seq: 238,
      type: "log",
      payload: { message: "cap kc_run_secretValue and kc_admin_secretValue" },
      atMs: 891,
    };
    expect(formatWatchEvent(event)).toContain("«redacted-capability»");
    expect(formatWatchEvent(event, { json: true })).not.toContain("kc_run_secretValue");
  });

  test("watch formatter tolerates missing agent event payloads", () => {
    expect(
      formatWatchEvent({
        seq: 237,
        type: "agent.event",
        payload: undefined,
        atMs: 890,
      }),
    ).toBe("[237] agent: undefined\n");
  });

  test("watch args parse raw JSON mode before the run id", () => {
    expect(parseWatchArgs(["run_123"])).toEqual({ runId: "run_123", json: false });
    expect(parseWatchArgs(["--json", "run_123"])).toEqual({ runId: "run_123", json: true });
  });

  test("lifecycle args default to attached mode and support --detach", () => {
    expect(parseLifecycleArgs(["wf.ts", '{"n":1}'])).toEqual({
      detach: false,
      args: ["wf.ts", '{"n":1}'],
    });
    expect(parseLifecycleArgs(["--detach", "run_123"])).toEqual({
      detach: true,
      args: ["run_123"],
    });
  });

  test("launch args parse source path, input, name, detach, and capability emission", () => {
    expect(
      parseLaunchArgs([
        "--emit-capability",
        "--detach",
        "--name",
        "review",
        "wf.ts",
        "--input",
        '{"n":1}',
      ]),
    ).toEqual({
      detach: true,
      emitCapability: true,
      file: "wf.ts",
      name: "review",
      input: { n: 1 },
    });
    expect(parseLaunchArgs(["--detach", "wf.ts"])).toEqual({
      detach: true,
      emitCapability: false,
      file: "wf.ts",
      input: {},
    });
    expect(() => parseLaunchArgs(["wf.ts", '{"n":1}'])).toThrow(
      "workflow input must use --input",
    );
  });

  test("run args parse json mode with optional source path", () => {
    expect(parseRunArgs(["--json", "--input", "null"])).toEqual({
      json: true,
      input: null,
    });
  });

  test("execute args parse source, state, cap file, entry, and script args", () => {
    expect(
      parseExecuteArgs([
        "--entry",
        "resume",
        "--state",
        "state.json",
        "--cap-file",
        "run.cap",
        "--emit-capability",
        "control.ts",
        "--",
        "a",
        "b",
      ]),
    ).toEqual({
      file: "control.ts",
      entry: "resume",
      stateFile: "state.json",
      capFile: "run.cap",
      emitCapability: true,
      args: ["a", "b"],
    });
  });

  test("attached lifecycle commands print the run id before streaming events", () => {
    expect(formatRunHeader("run_123")).toBe("run run_123\n");
  });

  test("launch input defaults to an object and rejects empty --input values", () => {
    expect(parseLaunchInput(undefined)).toEqual({});
    expect(parseLaunchInput('{"n":1}')).toEqual({ n: 1 });
    expect(parseLaunchInput("null")).toBeNull();
    expect(() => parseLaunchInput("")).toThrow("omit it for {}");
    expect(() => parseLaunchInput("  ")).toThrow("omit it for {}");
  });

  test("launch workflow paths are normalized before RPC", () => {
    expect(resolveWorkflowPath("fixtures/demo.workflow.ts", "/repo")).toBe(
      "/repo/fixtures/demo.workflow.ts",
    );
    expect(resolveWorkflowPath("/repo/demo.workflow.ts", "/other")).toBe("/repo/demo.workflow.ts");
    expect(resolveWorkflowPath("file:///repo/demo.workflow.ts", "/other")).toBe(
      "/repo/demo.workflow.ts",
    );
    expect(workflowName("/repo/demo.workflow.ts")).toBe("demo.workflow.ts");
    expect(workflowName("file:///repo/demo.workflow.ts")).toBe("demo.workflow.ts");
  });

  test("launch rejects empty --input before connecting to the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-launch-empty-input-"));
    try {
      const out = await runCli(["launch", "wf.ts", "--input", ""], dir, {
        KEEL_SOCKET: join(dir, "missing.sock"),
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("omit it for {}");
      expect(out.stderr).not.toContain("Failed to connect");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detached launch writes a capability file that authorizes follow-up get", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-launch-cap-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const capDir = join(dir, "caps");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
    });
    await daemon.start();
    try {
      const env = {
        KEEL_SOCKET: socketPath,
        KEEL_DB: dbPath,
        KEEL_DIR: dir,
        KEEL_CAP_DIR: capDir,
      };
      const launched = await runCli(
        ["launch", "--detach", chainUrl, "--input", '{"n":1}'],
        dir,
        env,
      );
      expect(launched.code).toBe(0);
      expect(launched.stdout).not.toContain("kc_run_");
      const payload = JSON.parse(launched.stdout) as { runId: string; capabilityRef: string };
      expect(payload.capabilityRef).toBe(join(capDir, `${payload.runId}.cap`));
      const capFile = JSON.parse(readFileSync(payload.capabilityRef, "utf8")) as {
        capability: string;
      };
      expect(capFile.capability.startsWith("kc_run_")).toBe(true);

      const got = await runCli(["get", payload.runId], dir, {
        ...env,
        KEEL_CAP_FILE: payload.capabilityRef,
      });
      expect(got.code).toBe(0);
      expect(JSON.parse(got.stdout).runId).toBe(payload.runId);
      await waitForCliStatus(payload.runId, dir, { ...env, KEEL_CAP_FILE: payload.capabilityRef });
      const output = await runCli(["output", payload.runId], dir, {
        ...env,
        KEEL_CAP_FILE: payload.capabilityRef,
      });
      expect(output.code).toBe(0);
      expect(output.stdout).toBe("1\n");

      const raw = await runCli(
        ["launch", "--detach", "--emit-capability", chainUrl, "--input", '{"n":3}'],
        dir,
        env,
      );
      expect(raw.code).toBe(0);
      const rawPayload = JSON.parse(raw.stdout) as { runId: string; capability: string };
      expect(rawPayload.capability.startsWith("kc_run_")).toBe(true);
      expect(raw.stdout).not.toContain("capabilityRef");
      await waitForCliStatus(rawPayload.runId, dir, {
        ...env,
        KEEL_RUN_CAP: rawPayload.capability,
      });
    } finally {
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run launches a workflow file and prints a JSON envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-run-json-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
    });
    await daemon.start();
    try {
      const env = { KEEL_SOCKET: socketPath, KEEL_DB: dbPath, KEEL_DIR: dir };
      const out = await runCli(
        ["run", "--json", chainUrl, "--input", '{"n":2}'],
        dir,
        env,
      );
      expect(out.code).toBe(0);
      const payload = JSON.parse(out.stdout) as {
        runId: string;
        capabilityRef: string;
        status: string;
        output: number;
      };
      expect(payload.status).toBe("finished");
      expect(payload.output).toBe(2);
      expect(payload.capabilityRef).toBe(join(dir, "caps", `${payload.runId}.cap`));
    } finally {
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("launch reads workflow source from stdin when no file is passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-launch-stdin-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
      adminToken: "kc_admin_cli_test",
    });
    await daemon.start();
    try {
      const env = {
        KEEL_SOCKET: socketPath,
        KEEL_DB: dbPath,
        KEEL_DIR: dir,
        KEEL_ADMIN_TOKEN: "kc_admin_cli_test",
      };
      const launched = await runCli(
        ["launch", "--detach", "--input", '{"n":2}'],
        dir,
        env,
        readFileSync(chainUrl, "utf8"),
      );
      expect(launched.code).toBe(0);
      const payload = JSON.parse(launched.stdout) as { runId: string; capabilityRef: string };
      await waitForCliStatus(payload.runId, dir, { ...env, KEEL_CAP_FILE: payload.capabilityRef });

      const listed = await runCli(["list"], dir, env);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("(unnamed)");
    } finally {
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gc runs as an admin daemon operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-gc-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
      adminToken: "kc_admin_gc_test",
    });
    await daemon.start();
    try {
      const out = await runCli(["gc"], dir, {
        KEEL_SOCKET: socketPath,
        KEEL_DB: dbPath,
        KEEL_DIR: dir,
        KEEL_ADMIN_TOKEN: "kc_admin_gc_test",
      });
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual({
        workflowDefinitionsRemoved: 0,
        definitionCacheEntriesRemoved: 0,
      });
    } finally {
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("execute runs a stateless TypeScript control script over the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-execute-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const capDir = join(dir, "caps");
    const script = join(dir, "control.ts");
    writeControlScript(script, chainUrl);
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
    });
    await daemon.start();
    try {
      const env = {
        KEEL_SOCKET: socketPath,
        KEEL_DB: dbPath,
        KEEL_DIR: dir,
        KEEL_CAP_DIR: capDir,
      };
      const out = await runCli(["execute", script], dir, env);
      expect(out.code).toBe(0);
      const result = JSON.parse(out.stdout) as {
        runId: string;
        status: string;
        output: number;
        capabilityRef: string;
      };
      expect(result.status).toBe("finished");
      expect(result.output).toBe(2);
      expect(result.capabilityRef).toBe(join(capDir, `${result.runId}.cap`));
      expect(readFileSync(result.capabilityRef, "utf8")).toContain("kc_run_");

      const raw = await runCli(["execute", "--emit-capability", script], dir, env);
      expect(raw.code).toBe(0);
      const rawResult = JSON.parse(raw.stdout) as { capability: string; capabilityRef?: string };
      expect(rawResult.capability.startsWith("kc_run_")).toBe(true);
      expect(rawResult.capabilityRef).toBeUndefined();
    } finally {
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("execute approve reuses the original admin credential after launching a child run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-execute-approve-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const script = join(dir, "approve.ts");
    writeFileSync(
      script,
      `
        const run = await keel.launch({ workflow: ${JSON.stringify(gateUrl)}, input: null });
        await keel.wait(run.runId, { timeoutMs: 2000 });
        const decision = await keel.approve(run.runId, "approve-deploy");
        const done = await keel.wait(run.runId);
        return { decision: decision.status, output: done.output };
      `,
    );
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
      adminToken: "kc_admin_execute_test",
    });
    await daemon.start();
    try {
      const out = await runCli(["execute", script], dir, {
        KEEL_SOCKET: socketPath,
        KEEL_DB: dbPath,
        KEEL_DIR: dir,
        KEEL_ADMIN_TOKEN: "kc_admin_execute_test",
      });
      expect(out.code).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual({
        decision: "finished",
        output: "deploy:approved",
      });
    } finally {
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("execute writes structured errors to stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-execute-error-"));
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const script = join(dir, "bad.ts");
    writeFileSync(script, 'throw new Error("bad control script kc_run_secretValue");\n');
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
    });
    await daemon.start();
    try {
      const out = await runCli(["execute", script], dir, {
        KEEL_SOCKET: socketPath,
        KEEL_DB: dbPath,
        KEEL_DIR: dir,
      });
      expect(out.code).toBe(1);
      expect(JSON.parse(out.stderr).error).toMatchObject({
        code: "execute_failed",
        message: "bad control script «redacted-capability»",
      });
    } finally {
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("execute writes structured errors for argument/setup failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-execute-arg-error-"));
    try {
      const out = await runCli(["execute", "--unknown"], dir, {
        KEEL_SOCKET: join(dir, "missing.sock"),
      });
      expect(out.code).toBe(1);
      expect(JSON.parse(out.stderr).error).toMatchObject({
        code: "execute_failed",
        message: "unknown execute flag --unknown",
      });
      expect(out.stderr).not.toContain("keel:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeControlScript(path: string, workflowUrl: string): void {
  writeFileSync(
    path,
    `
      const run = await keel.launch({
        workflow: ${JSON.stringify(workflowUrl)},
        input: { n: 2 },
      });
      const settled = await keel.wait(run.runId);
        return {
          runId: run.runId,
          capabilityRef: run.capabilityRef,
          capability: run.capability,
          status: settled.status,
          output: settled.output,
        };
    `,
  );
}

async function waitForCliStatus(
  runId: string,
  cwd: string,
  env: Record<string, string>,
  status = "finished",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const out = await runCli(["get", runId], cwd, env);
    if (out.code === 0 && JSON.parse(out.stdout).status === status) return;
    await Bun.sleep(50);
  }
  throw new Error(`run ${runId} did not reach ${status}`);
}
