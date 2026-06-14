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
import type { DaemonClient } from "../daemon/client.ts";
import { KeelDaemon } from "../daemon/server.ts";
import {
  formatListRuns,
  formatRunHeader,
  parseExecuteArgs,
  parseLaunchArgs,
  parseLaunchInput,
  parseLifecycleArgs,
  parseListArgs,
  parseOutputFormat,
  parseRunArgs,
  parseWatchArgs,
  resolveWorkflowPath,
  watchRun,
  workflowName,
} from "./keel.ts";

const CLI = new URL("./keel.ts", import.meta.url).pathname;
const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = new URL("chain.workflow.ts", FIX).pathname;
const flakyUrl = new URL("flaky.workflow.ts", FIX).pathname;
const gateUrl = new URL("gate.workflow.ts", FIX).pathname;
const DAEMON_TEST_TIMEOUT_MS = 20_000;

async function runCli(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  stdin?: string,
  timeoutMs?: number,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("KEEL_")),
  ) as Record<string, string>;
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: { ...baseEnv, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout =
    timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("keel CLI", () => {
  test("help is a daemon-free install smoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-cli-help-"));
    try {
      const out = await runCli(["help"], dir);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("Usage: keel <command>");
      expect(out.stdout).toContain("list [--output text|json]");
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

  test("list args default to text and reject unsupported output modes", () => {
    expect(parseListArgs([])).toEqual({ output: "text" });
    expect(parseListArgs(["--output", "text"])).toEqual({ output: "text" });
    expect(parseListArgs(["--output", "json"])).toEqual({ output: "json" });
    expect(() => parseListArgs(["--output", "ndjson"])).toThrow(
      "--output ndjson is not available for list",
    );
    expect(() => parseListArgs(["--output", "xml"])).toThrow("invalid --output xml for list");
    expect(() => parseListArgs(["run_123"])).toThrow("unexpected argument run_123 for list");
  });

  test("list formatter renders deterministic UTC timestamps and durations", () => {
    expect(
      formatListRuns(
        [
          {
            runId: "run_older",
            status: "finished",
            workflowName: "chain",
            createdAtMs: Date.UTC(2026, 5, 14, 1, 2, 3, 4),
            finishedAtMs: Date.UTC(2026, 5, 14, 1, 14, 3, 4),
            parentRunId: null,
          },
          {
            runId: "run_active",
            status: "waiting-signal",
            workflowName: "very long workflow name that is truncated for humans only",
            createdAtMs: Date.UTC(2026, 5, 14, 2, 0, 0, 0),
            finishedAtMs: null,
            parentRunId: "run_older",
          },
        ],
        Date.UTC(2026, 5, 14, 2, 0, 5, 0),
      ),
    ).toBe(
      [
        "RUN ID      STATUS          WORKFLOW                                  CREATED                   DURATION",
        "run_older   finished        chain                                     2026-06-14T01:02:03.004Z  12m",
        "run_active  waiting-signal  very long workflow name that is truncat…  2026-06-14T02:00:00.000Z  5s",
        "",
      ].join("\n"),
    );
  });

  test("watch args default to ndjson and parse --output", () => {
    expect(parseWatchArgs(["run_123"])).toEqual({
      runId: "run_123",
      output: "ndjson",
      tools: false,
    });
    expect(parseWatchArgs(["run_123", "--output", "text"])).toEqual({
      runId: "run_123",
      output: "text",
      tools: false,
    });
    expect(parseWatchArgs(["run_123", "--output", "text", "--tools"])).toEqual({
      runId: "run_123",
      output: "text",
      tools: true,
    });
    expect(() => parseWatchArgs(["run_123", "--tools"])).toThrow("attached watch --output text");
    expect(parseOutputFormat("json")).toBe("json");
    expect(() => parseOutputFormat("events")).toThrow("expected json, text, or ndjson");
  });

  test("lifecycle args default to attached mode and support --detach", () => {
    expect(parseLifecycleArgs(["wf.ts", '{"n":1}'])).toEqual({
      detach: false,
      tools: false,
      args: ["wf.ts", '{"n":1}'],
    });
    expect(parseLifecycleArgs(["--detach", "run_123"])).toEqual({
      detach: true,
      tools: false,
      args: ["run_123"],
    });
    expect(parseLifecycleArgs(["--tools", "run_123"])).toEqual({
      detach: false,
      tools: true,
      args: ["run_123"],
    });
    expect(() => parseLifecycleArgs(["--detach", "--tools", "run_123"])).toThrow(
      "attached lifecycle --output text",
    );
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
      tools: false,
      file: "wf.ts",
      name: "review",
      input: { n: 1 },
    });
    expect(parseLaunchArgs(["--detach", "--output", "text", "wf.ts"])).toEqual({
      detach: true,
      emitCapability: false,
      tools: false,
      output: "text",
      file: "wf.ts",
      input: {},
    });
    expect(parseLaunchArgs(["--output", "text", "--tools", "wf.ts"])).toEqual({
      detach: false,
      emitCapability: false,
      tools: true,
      output: "text",
      file: "wf.ts",
      input: {},
    });
    expect(parseLaunchArgs(["--detach", "wf.ts"])).toEqual({
      detach: true,
      emitCapability: false,
      tools: false,
      file: "wf.ts",
      input: {},
    });
    expect(() => parseLaunchArgs(["wf.ts", '{"n":1}'])).toThrow("workflow input must use --input");
    expect(() => parseLaunchArgs(['{"n":1}'])).toThrow("workflow input must use --input");
  });

  test("run args parse output mode with optional source path", () => {
    expect(parseRunArgs(["--output", "ndjson", "--input", "null"])).toEqual({
      tools: false,
      output: "ndjson",
      input: null,
    });
    expect(parseRunArgs(["--output", "text", "--tools"])).toEqual({
      tools: true,
      output: "text",
      input: {},
    });
    expect(() => parseRunArgs(["--json"])).toThrow("unknown flag --json");
    expect(() => parseRunArgs(['{"n":1}'])).toThrow("workflow input must use --input");
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
      output: "json",
      emitCapability: true,
      args: ["a", "b"],
    });
    expect(parseExecuteArgs(["--output", "json", "control.ts"])).toMatchObject({
      file: "control.ts",
      output: "json",
    });
    expect(parseExecuteArgs(["--output", "text", "control.ts"]).output).toBe("text");
  });

  test("attached lifecycle commands print the run id before streaming events", () => {
    expect(formatRunHeader("run_123")).toBe("run run_123\n");
  });

  test("watchRun flushes partial text streams before terminal events", async () => {
    const client = fakeWatchClient(({ onEvent, onCaughtUp }) => {
      onEvent({
        kind: "ephemeral",
        type: "agent.event",
        payload: { key: "review", event: { type: "text", data: "partial" } },
        atMs: 1,
      });
      onEvent({ kind: "durable", seq: 2, type: "run.finished", payload: {}, atMs: 2 });
      onCaughtUp?.();
    });

    const captured = await captureProcessWrites(() =>
      watchRun(client, "run_terminal_flush", { output: "text" }),
    );

    expect(captured.result).toBe("finished");
    expect(captured.writes).toEqual([
      { stream: "stdout", text: "[live] agent review text: " },
      { stream: "stdout", text: "partial" },
      { stream: "stdout", text: "\n" },
      { stream: "stdout", text: "[2] run.finished\n" },
    ]);
  });

  test("watchRun flushes partial text streams before subscription errors", async () => {
    const client = fakeWatchClient(({ onEvent, onError }) => {
      onEvent({
        kind: "ephemeral",
        type: "agent.event",
        payload: { key: "review", event: { type: "text", data: "partial" } },
        atMs: 1,
      });
      onError?.(new Error("subscribe failed"));
    });

    const captured = await captureProcessWrites(() =>
      watchRun(client, "run_error_flush", { output: "text" }),
    );

    expect(captured.result).toBe("failed");
    expect(captured.writes).toEqual([
      { stream: "stdout", text: "[live] agent review text: " },
      { stream: "stdout", text: "partial" },
      { stream: "stdout", text: "\n" },
      { stream: "stderr", text: "subscribe failed\n" },
    ]);
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

  test(
    "detached launch writes a capability file that authorizes follow-up get",
    async () => {
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
        const unauthorizedWatch = await runCli(["watch", payload.runId], dir, env);
        expect(unauthorizedWatch.code).toBe(1);
        expect(unauthorizedWatch.stderr).toContain("not authorized");
        await waitForCliStatus(payload.runId, dir, {
          ...env,
          KEEL_CAP_FILE: payload.capabilityRef,
        });
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

        const attached = await runCli(["launch", chainUrl, "--input", '{"n":2}'], dir, env);
        expect(attached.code).toBe(0);
        expect(attached.stdout.startsWith("run ")).toBe(false);
        const attachedEvents = attached.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
        expect(attachedEvents[0]).toMatchObject({
          type: "launch.started",
          payload: { capabilityRef: join(capDir, `${attachedEvents[0]?.payload.runId}.cap`) },
        });
        expect(attachedEvents.find((e) => e.type === "run.finished")?.payload).toEqual({
          output: 2,
        });
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "run launches a workflow file and prints a JSON envelope by default",
    async () => {
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
        const out = await runCli(["run", chainUrl, "--input", '{"n":2}'], dir, env);
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

        const streamed = await runCli(
          ["run", "--output", "ndjson", chainUrl, "--input", '{"n":2}'],
          dir,
          env,
        );
        expect(streamed.code).toBe(0);
        const events = streamed.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; subId?: string; payload: unknown });
        expect(events.find((e) => e.type === "run.finished")?.payload).toEqual({ output: 2 });
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.subId === undefined)).toBe(true);
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "run closes the client and exits when the daemon rejects the launch",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-run-reject-"));
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
        // A forbidden import makes the daemon reject launchRun mid-command. The CLI
        // must close the socket and exit rather than hang on the dangling handle —
        // the bounded timeout trips `timedOut` if the leak regresses.
        const rejected = await runCli(
          ["run", "--output", "json"],
          dir,
          env,
          'import fs from "node:fs";\nexport default async () => fs;\n',
          5_000,
        );
        expect(rejected.timedOut).toBe(false);
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toContain("no-forbidden-import");
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "report prints a per-node result digest",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-report-"));
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
        const run = await runCli(["run", chainUrl, "--input", '{"n":2}'], dir, env);
        const { runId, capabilityRef } = JSON.parse(run.stdout) as {
          runId: string;
          capabilityRef: string;
        };

        const report = await runCli(["report", runId], dir, {
          ...env,
          KEEL_CAP_FILE: capabilityRef,
        });
        expect(report.code).toBe(0);
        const payload = JSON.parse(report.stdout) as {
          runId: string;
          output: number;
          stats: { steps: number; agents: number; artifacts: number };
          nodes: Array<{ stableKey: string; result: number; artifactBacked: boolean }>;
        };
        expect(payload.runId).toBe(runId);
        expect(payload.output).toBe(2);
        expect(payload.stats).toEqual({ steps: 2, agents: 0, artifacts: 0 });
        expect(payload.nodes.map((n) => [n.stableKey, n.result])).toEqual([
          ["s0", 1],
          ["s1", 2],
        ]);

        const text = await runCli(["report", runId, "--output", "text"], dir, {
          ...env,
          KEEL_CAP_FILE: capabilityRef,
        });
        expect(text.code).toBe(0);
        expect(text.stdout).toContain(`run ${runId}`);
        expect(text.stdout).toContain("s0 completed pure attempt=1 result 1");

        const unauthorized = await runCli(["report", runId], dir, env, undefined, 1_000);
        expect(unauthorized.timedOut).toBe(false);
        expect(unauthorized.code).toBe(1);
        expect(unauthorized.stderr).toContain("not authorized");

        const invalid = await runCli(["report", runId, "--output", "ndjson"], dir, {
          ...env,
          KEEL_CAP_FILE: capabilityRef,
        });
        expect(invalid.code).toBe(1);
        expect(invalid.stderr).toContain("--output ndjson is not available for report");
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "attached lifecycle commands exit 3 when the run parks",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-lifecycle-parked-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_lifecycle_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_lifecycle_test",
        };
        const launched = await runCli(["launch", "--detach", gateUrl], dir, env);
        expect(launched.code).toBe(0);
        const payload = JSON.parse(launched.stdout) as { runId: string; capabilityRef: string };
        await waitForCliStatus(payload.runId, dir, env, "waiting-human");

        const detached = await runCli(["resume", "--detach", payload.runId], dir, env);
        expect(detached.code).toBe(0);
        expect(detached.stdout).toContain(`${payload.runId}\t`);
        await waitForCliStatus(payload.runId, dir, env, "waiting-human");

        const resumed = await runCli(["resume", payload.runId], dir, env);
        expect(resumed.code).toBe(3);
        expect(resumed.stdout).toContain(`run ${payload.runId}`);
        expect(resumed.stdout).toContain("run.parked human approve-deploy");

        const approved = await runCli(["approve", payload.runId, "approve-deploy"], dir, env);
        expect(approved.code).toBe(0);
        await waitForCliStatus(payload.runId, dir, env);

        const watched = await runCli(["watch", payload.runId, "--output", "text"], dir, env);
        expect(watched.code).toBe(0);
        expect(watched.stdout).toContain("run.parked human approve-deploy");
        expect(watched.stdout).toContain("run.resumed");
        expect(watched.stdout).toContain("run.finished");
        expect(watched.stdout.indexOf("run.parked human approve-deploy")).toBeLessThan(
          watched.stdout.indexOf("run.resumed"),
        );
        expect(watched.stdout.indexOf("run.resumed")).toBeLessThan(
          watched.stdout.indexOf("run.finished"),
        );
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "attached retry ignores stale backfilled failure while the new attempt is running",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-lifecycle-retry-tail-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(
          new MockProvider({
            responses: {
              flaky: { outputs: ["bad", "bad", "bad", '{"ok":true}'], delayMs: 400 },
            },
          }),
        ),
        adminToken: "kc_admin_lifecycle_retry_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_lifecycle_retry_test",
        };
        const launched = await runCli(["launch", "--detach", flakyUrl], dir, env);
        expect(launched.code).toBe(0);
        const payload = JSON.parse(launched.stdout) as { runId: string };
        await waitForCliStatus(payload.runId, dir, env, "failed");

        const retried = await runCli(["retry", payload.runId], dir, env);
        expect(retried.code).toBe(0);
        expect(retried.stdout).toContain(`run ${payload.runId}`);
        expect(retried.stdout).toContain("run.failed");
        expect(retried.stdout).toContain("run.retry");
        expect(retried.stdout).toContain("run.finished");
        expect(retried.stdout.indexOf("run.failed")).toBeLessThan(
          retried.stdout.indexOf("run.retry"),
        );
        expect(retried.stdout.indexOf("run.retry")).toBeLessThan(
          retried.stdout.indexOf("run.finished"),
        );
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "launch reads workflow source from stdin when no file is passed",
    async () => {
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
        await waitForCliStatus(payload.runId, dir, {
          ...env,
          KEEL_CAP_FILE: payload.capabilityRef,
        });

        const listed = await runCli(["list"], dir, env);
        expect(listed.code).toBe(0);
        expect(listed.stdout).toContain("(unnamed)");
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "list renders a table by default and JSON envelope on request",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-list-output-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_list_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_list_test",
        };

        const emptyText = await runCli(["list"], dir, env);
        expect(emptyText.code).toBe(0);
        expect(emptyText.stdout).toBe("RUN ID  STATUS  WORKFLOW  CREATED  DURATION\n");

        const emptyJson = await runCli(["list", "--output", "json"], dir, env);
        expect(emptyJson.code).toBe(0);
        expect(JSON.parse(emptyJson.stdout)).toEqual({ runs: [] });

        const first = await runCli(
          ["run", "--name", "older", chainUrl, "--input", '{"n":1}'],
          dir,
          env,
        );
        expect(first.code).toBe(0);
        const firstRun = JSON.parse(first.stdout) as { runId: string };

        const second = await runCli(
          ["run", "--name", "newer", chainUrl, "--input", '{"n":2}'],
          dir,
          env,
        );
        expect(second.code).toBe(0);
        const secondRun = JSON.parse(second.stdout) as { runId: string };

        const listedJson = await runCli(["list", "--output", "json"], dir, env);
        expect(listedJson.code).toBe(0);
        const payload = JSON.parse(listedJson.stdout) as {
          runs: Array<{
            runId: string;
            status: string;
            workflowName: string | null;
            createdAtMs: number;
            finishedAtMs: number | null;
            parentRunId: string | null;
          }>;
        };
        expect(payload.runs.map((run) => run.runId)).toEqual([firstRun.runId, secondRun.runId]);
        expect(Object.keys(payload.runs[0] ?? {}).sort()).toEqual([
          "createdAtMs",
          "finishedAtMs",
          "parentRunId",
          "runId",
          "status",
          "workflowName",
        ]);
        expect(payload.runs[0]).toMatchObject({
          runId: firstRun.runId,
          status: "finished",
          workflowName: "older",
          parentRunId: null,
        });
        expect(typeof payload.runs[0]?.createdAtMs).toBe("number");
        expect(typeof payload.runs[0]?.finishedAtMs).toBe("number");

        const listedText = await runCli(["list"], dir, env);
        expect(listedText.code).toBe(0);
        const lines = listedText.stdout.trimEnd().split("\n");
        expect(lines[0]).toContain("RUN ID");
        expect(lines[0]).toContain("STATUS");
        expect(lines[0]).toContain("WORKFLOW");
        expect(lines[0]).toContain("CREATED");
        expect(lines[0]).toContain("DURATION");
        expect(lines[1]).toMatch(
          new RegExp(
            `^${escapeRegExp(firstRun.runId)}\\s{2,}finished\\s{2,}older\\s{2,}\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\s{2,}\\d+(?:ms|s|m|h|d)$`,
          ),
        );
        expect(lines[2]).toMatch(
          new RegExp(
            `^${escapeRegExp(secondRun.runId)}\\s{2,}finished\\s{2,}newer\\s{2,}\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\s{2,}\\d+(?:ms|s|m|h|d)$`,
          ),
        );
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "gc runs as an admin daemon operation",
    async () => {
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
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "execute runs a stateless TypeScript control script over the daemon",
    async () => {
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
          reportNodeCount: number;
        };
        expect(result.status).toBe("finished");
        expect(result.output).toBe(2);
        expect(result.reportNodeCount).toBe(2);
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
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "execute approve reuses the original admin credential after launching a child run",
    async () => {
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
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "execute report restores the original credential for externally supplied runs",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-execute-report-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const script = join(dir, "report-parent.ts");
      writeFileSync(
        script,
        `
        const parentRunId = args[0];
        if (!parentRunId) throw new Error("missing parent run id");
        const child = await keel.launch({ workflow: ${JSON.stringify(chainUrl)}, input: { n: 1 } });
        await keel.wait(child.runId);
        const report = await keel.report(parentRunId);
        return { parentRunId, nodeCount: report.nodes.length };
      `,
      );
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_report_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_report_test",
        };
        const parent = await runCli(["run", chainUrl, "--input", '{"n":2}'], dir, env);
        expect(parent.code).toBe(0);
        const parentRunId = (JSON.parse(parent.stdout) as { runId: string }).runId;

        const out = await runCli(["execute", script, "--", parentRunId], dir, env);
        expect(out.code).toBe(0);
        expect(JSON.parse(out.stdout)).toEqual({ parentRunId, nodeCount: 2 });
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "execute writes structured errors to stderr",
    async () => {
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
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

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

      const output = await runCli(["execute", "--output", "text"], dir, {
        KEEL_SOCKET: join(dir, "missing.sock"),
      });
      expect(output.code).toBe(1);
      expect(JSON.parse(output.stderr).error.message).toContain(
        "--output text is not available for execute",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unsupported output combinations fail before daemon connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-output-combos-"));
    try {
      const env = { KEEL_SOCKET: join(dir, "missing.sock") };
      const listNdjson = await runCli(["list", "--output", "ndjson"], dir, env);
      expect(listNdjson.code).toBe(1);
      expect(listNdjson.stderr).toContain("--output ndjson is not available for list");

      const listInvalid = await runCli(["list", "--output", "xml"], dir, env);
      expect(listInvalid.code).toBe(1);
      expect(listInvalid.stderr).toContain("invalid --output xml for list");

      const watch = await runCli(["watch", "run_123", "--output", "json"], dir, env);
      expect(watch.code).toBe(1);
      expect(watch.stderr).toContain("--output json is not available for watch");

      const watchTools = await runCli(["watch", "run_123", "--tools"], dir, env);
      expect(watchTools.code).toBe(1);
      expect(watchTools.stderr).toContain(
        "--tools is only available for attached watch --output text",
      );

      const runTools = await runCli(["run", "--tools", "wf.ts"], dir, env);
      expect(runTools.code).toBe(1);
      expect(runTools.stderr).toContain("--tools is only available for attached run --output text");

      const attached = await runCli(["launch", "--output", "json", "wf.ts"], dir, env);
      expect(attached.code).toBe(1);
      expect(attached.stderr).toContain("--output json is not available for attached launch");

      const detachedTextTools = await runCli(
        ["launch", "--detach", "--output", "text", "--tools", "wf.ts"],
        dir,
        env,
      );
      expect(detachedTextTools.code).toBe(1);
      expect(detachedTextTools.stderr).toContain(
        "--tools is only available for attached launch --output text",
      );

      const detached = await runCli(
        ["launch", "--detach", "--output", "ndjson", "wf.ts"],
        dir,
        env,
      );
      expect(detached.code).toBe(1);
      expect(detached.stderr).toContain("--output ndjson is not available for launch --detach");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

type FakeWatchSubscription = {
  onEvent: Parameters<DaemonClient["subscribeEvents"]>[2];
  onError: Parameters<DaemonClient["subscribeEvents"]>[3];
  onCaughtUp: Parameters<DaemonClient["subscribeEvents"]>[4];
};

function fakeWatchClient(run: (subscription: FakeWatchSubscription) => void): DaemonClient {
  return {
    subscribeEvents(
      _runId: string,
      _afterSeq: number,
      onEvent: FakeWatchSubscription["onEvent"],
      onError?: FakeWatchSubscription["onError"],
      onCaughtUp?: FakeWatchSubscription["onCaughtUp"],
    ) {
      queueMicrotask(() => run({ onEvent, onError, onCaughtUp }));
      return () => {};
    },
  } as DaemonClient;
}

async function captureProcessWrites<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; writes: Array<{ stream: "stdout" | "stderr"; text: string }> }> {
  const writes: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const decoder = new TextDecoder();
  const text = (chunk: string | Uint8Array): string =>
    typeof chunk === "string" ? chunk : decoder.decode(chunk);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push({ stream: "stdout", text: text(chunk) });
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push({ stream: "stderr", text: text(chunk) });
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, writes };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeControlScript(path: string, workflowUrl: string): void {
  writeFileSync(
    path,
    `
      const run = await keel.launch({
        workflow: ${JSON.stringify(workflowUrl)},
        input: { n: 2 },
      });
      const settled = await keel.wait(run.runId);
      const report = await keel.report(run.runId);
        return {
          runId: run.runId,
          capabilityRef: run.capabilityRef,
          capability: run.capability,
          status: settled.status,
          output: settled.output,
          reportNodeCount: report.nodes.length,
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
