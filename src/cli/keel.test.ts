import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../agents/mock.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { KeelDaemon } from "../daemon/server.ts";
import {
  formatRunHeader,
  formatWatchEvent,
  parseLaunchArgs,
  parseLaunchInput,
  parseLifecycleArgs,
  parseWatchArgs,
  resolveWorkflowPath,
  workflowName,
} from "./keel.ts";

const CLI = new URL("./keel.ts", import.meta.url).pathname;
const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = new URL("chain.workflow.ts", FIX).pathname;

async function runCli(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
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

  test("launch args require explicit raw capability opt-in", () => {
    expect(parseLaunchArgs(["--emit-capability", "--detach", "wf.ts"])).toEqual({
      emitCapability: true,
      args: ["--detach", "wf.ts"],
    });
    expect(parseLaunchArgs(["--detach", "wf.ts"])).toEqual({
      emitCapability: false,
      args: ["--detach", "wf.ts"],
    });
  });

  test("attached lifecycle commands print the run id before streaming events", () => {
    expect(formatRunHeader("run_123")).toBe("run run_123\n");
  });

  test("launch input defaults to an object and rejects empty positional input", () => {
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
      "file:///repo/demo.workflow.ts",
    );
    expect(workflowName("/repo/demo.workflow.ts")).toBe("demo.workflow.ts");
    expect(workflowName("file:///repo/demo.workflow.ts")).toBe("demo.workflow.ts");
  });

  test("launch rejects empty positional input before connecting to the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-launch-empty-input-"));
    try {
      const out = await runCli(["launch", "wf.ts", ""], dir, {
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
      const launched = await runCli(["launch", "--detach", chainUrl, '{"n":1}'], dir, env);
      expect(launched.code).toBe(0);
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
    } finally {
      daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
