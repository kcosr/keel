#!/usr/bin/env bun
// Thin Keel CLI (DESIGN.md §6.1) — sends one RPC to the daemon and prints the
// result. The daemon (never the CLI) hosts the realm and spawns agents (L4).
//
//   keel daemon                         start the daemon (foreground)
//   keel launch [workflow.ts] [--input json]     launch a run and watch it
//   keel run [workflow.ts] [--input json]        launch and print terminal output
//   keel watch <runId>                  stream a run's events until terminal
//   keel get <runId>                    print the run projection
//   keel resume <runId>                 resume a non-terminal run
//   keel list                           list runs
//
// Socket + db paths default under ~/.keel (override with KEEL_SOCKET / KEEL_DB).

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProvider } from "../agents/claude.ts";
import { PiProvider } from "../agents/pi.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { redactCapabilityTokens } from "../auth/redaction.ts";
import { DaemonClient } from "../daemon/client.ts";
import { KeelDaemon } from "../daemon/server.ts";
import { runExecuteScript } from "../execute/runtime.ts";
import type { RunOutcome, WorkflowProvenance } from "../rpc/contract.ts";
import type { RunReport } from "../rpc/projection.ts";
import { createTextWatchFormatter, formatNdjsonWatchEvent } from "./watch-format.ts";
import type { WatchFormatOptions } from "./watch-format.ts";

const KEEL_DIR = process.env.KEEL_DIR ?? join(homedir(), ".keel");
const SOCKET = process.env.KEEL_SOCKET ?? join(KEEL_DIR, "keel.sock");
const DB = process.env.KEEL_DB ?? join(KEEL_DIR, "keel.db");
const CAP_DIR = process.env.KEEL_CAP_DIR ?? join(KEEL_DIR, "caps");

export const OUTPUT_FORMATS = ["json", "text", "ndjson"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// Every client opened during a command is tracked here and closed by `main`'s
// dispatch `finally`. A leaked socket keeps the event loop alive and hangs the
// CLI, so cleanup must be a structural guarantee — not per-command discipline
// that the throw path skips. Commands therefore never close their own client.
const trackedClients = new Set<DaemonClient>();

/** Connect a client, authenticating with the caller's presented capability. */
async function openClient(credential = loadCredential()): Promise<DaemonClient> {
  const c = await DaemonClient.connect(SOCKET);
  // Track before authenticate so a failed authentication is still cleaned up.
  trackedClients.add(c);
  if (credential) await c.authenticate(credential);
  return c;
}

function closeTrackedClients(): void {
  for (const c of trackedClients) c.close();
  trackedClients.clear();
}

/** [name, args, summary] — single source for help + dispatch. */
const COMMANDS: [string, string, string][] = [
  ["daemon", "", "start the daemon (foreground; owns the journal + runs workflows)"],
  ["link", "[dir]", "make <dir> (default: cwd) able to import the @kcosr/keel SDK"],
  [
    "launch",
    "[workflow.ts] [--name n] [--input json] [--output json|text|ndjson] [--tools] [--detach] [--emit-capability]",
    "start a run from client-captured workflow source",
  ],
  [
    "run",
    "[workflow.ts] [--name n] [--input json] [--output json|text|ndjson] [--tools]",
    "launch and print the result",
  ],
  ["watch", "<runId> [--output ndjson|text] [--tools]", "stream a run's events until it finishes"],
  ["get", "<runId>", "print a run's projection as JSON"],
  ["output", "<runId> [--output json|text]", "print a run's terminal output"],
  ["report", "<runId> [--output json|text]", "print a run's per-node result digest"],
  ["list", "", "list runs"],
  ["gc", "", "prune unreferenced workflow definitions and cache entries"],
  ["resume", "[--detach] [--tools] <runId>", "resume a parked or incomplete run"],
  ["retry", "[--detach] [--tools] <runId>", "re-run a failed run from its failed step"],
  [
    "rewind",
    "[--detach] [--tools] <runId> <stepKey>",
    "discard everything after a step and re-run",
  ],
  ["fork", "<runId> [atStepKey]", "copy a run into a new independent run"],
  [
    "execute",
    "[file] [--entry name] [--state file] [--cap-file file] [--output json] [--emit-capability] [-- args...]",
    "run a stateless TypeScript control script",
  ],
  ["approve", "<runId> <key> [note]", "approve a ctx.human gate"],
  ["deny", "<runId> <key> [note]", "deny a ctx.human gate"],
  ["signal", "<runId> <name> [json]", "deliver a ctx.signal payload"],
  ["help", "[command]", "show this help, or help for one command"],
];
const cmdNames = new Set(COMMANDS.map((c) => c[0]));

function topHelp(): string {
  const w = Math.max(...COMMANDS.map((c) => `${c[0]} ${c[1]}`.trim().length));
  const rows = COMMANDS.map(([n, a, s]) => `  ${`${n} ${a}`.trim().padEnd(w)}  ${s}`);
  return [
    "keel — durable agent-workflow orchestrator",
    "",
    "Usage: keel <command> [args]",
    "",
    "Commands:",
    ...rows,
    "",
    "Environment: KEEL_SOCKET, KEEL_DB, KEEL_DIR, KEEL_ADMIN_TOKEN, KEEL_RUN_CAP, KEEL_CAP_FILE, KEEL_CAP_DIR, KEEL_WORKSPACE_ROOT",
    "Run `keel help <command>` for one command.",
    "",
  ].join("\n");
}
function cmdHelp(name: string): string {
  const c = COMMANDS.find((x) => x[0] === name);
  if (!c) return topHelp();
  return `Usage: keel ${`${c[0]} ${c[1]}`.trim()}\n  ${c[2]}\n`;
}

async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } finally {
    closeTrackedClients();
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // help: `keel`, `keel help [cmd]`, `keel --help`, `keel <cmd> --help`
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(rest[0] && cmdNames.has(rest[0]) ? cmdHelp(rest[0]) : topHelp());
    return 0;
  }
  if (cmdNames.has(cmd) && (rest[0] === "--help" || rest[0] === "-h")) {
    process.stdout.write(cmdHelp(cmd));
    return 0;
  }
  switch (cmd) {
    case "daemon": {
      await import("node:fs").then((fs) => fs.mkdirSync(KEEL_DIR, { recursive: true }));
      const agents = new AgentProviderRegistry()
        .register(new PiProvider())
        .register(new ClaudeProvider());
      const daemon = new KeelDaemon({
        socketPath: SOCKET,
        dbPath: DB,
        agents,
        ...(process.env.KEEL_ADMIN_TOKEN ? { adminToken: process.env.KEEL_ADMIN_TOKEN } : {}),
        ...(process.env.KEEL_WORKSPACE_ROOT
          ? { workspaceRoot: process.env.KEEL_WORKSPACE_ROOT }
          : {}),
      });
      await daemon.start();
      process.stdout.write(`keel daemon listening on ${SOCKET} (owner ${daemon.ownerId})\n`);
      process.on("SIGINT", () => {
        daemon.stop();
        process.exit(0);
      });
      await new Promise(() => {}); // run forever
      return 0;
    }
    case "link": {
      // Make a directory able to `import … from "@kcosr/keel"` without a registry,
      // by symlinking the package into its node_modules. Idempotent — re-run to
      // repair/update the link (e.g. after the repo moves). Like `npm link`.
      const target = rest[0] ? resolve(rest[0]) : process.cwd();
      const repoRoot = resolve(import.meta.dir, "..", ".."); // <repo> from src/cli/
      const scopeDir = join(target, "node_modules", "@kcosr");
      const link = join(scopeDir, "keel");
      mkdirSync(scopeDir, { recursive: true });
      try {
        const existing = lstatSync(link);
        if (!existing.isSymbolicLink()) {
          process.stderr.write(
            `keel: refusing to replace non-symlink at ${link}\nremove it yourself, or choose another directory\n`,
          );
          return 2;
        }
        rmSync(link, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // nothing there
      }
      symlinkSync(repoRoot, link, "dir");
      process.stdout.write(`linked @kcosr/keel → ${repoRoot}\n  ${link}\n`);
      return 0;
    }
    case "launch": {
      const launchOpts = parseLaunchArgs(rest);
      const output = launchOpts.output ?? (launchOpts.detach ? "json" : "ndjson");
      assertToolsAllowed("launch", launchOpts.tools, output, launchOpts.detach);
      if (launchOpts.detach && output === "ndjson") {
        throw new Error("--output ndjson is not available for launch --detach");
      }
      if (!launchOpts.detach && output === "json") {
        throw new Error("--output json is not available for attached launch");
      }
      const captured = await readCommandSource(launchOpts.file, "workflow");
      const client = await openClient();
      const launched = await client.launchRun({
        source: captured.source,
        input: launchOpts.input,
        name: launchOpts.name ?? captured.defaultName,
        provenance: captured.provenance,
      });
      const { runId } = launched;
      const capabilityRef =
        launched.capability && !launchOpts.emitCapability
          ? writeCapabilityFile(runId, launched.capability)
          : null;
      if (launched.capability) await client.authenticate(launched.capability);
      if (launchOpts.detach) {
        const payload = launchOpts.emitCapability
          ? { runId, capability: launched.capability ?? null }
          : { runId, capabilityRef };
        process.stdout.write(
          output === "json" ? `${JSON.stringify(payload)}\n` : formatLaunchText(payload),
        );
        return 0;
      }
      if (output === "text") {
        process.stdout.write(formatRunHeader(runId));
        if (capabilityRef) process.stdout.write(`capability ${capabilityRef}\n`);
        if (launchOpts.emitCapability && launched.capability) {
          process.stdout.write(`capability ${launched.capability}\n`);
        }
      } else if (output === "ndjson") {
        process.stdout.write(
          `${JSON.stringify({
            seq: 0,
            type: "launch.started",
            payload: launchOpts.emitCapability
              ? { runId, capability: launched.capability ?? null }
              : { runId, capabilityRef },
            atMs: Date.now(),
          })}\n`,
        );
      }
      const terminal = await watchRun(client, runId, { output, tools: launchOpts.tools });
      return statusExitCode(terminal);
    }
    case "run": {
      const runOpts = parseRunArgs(rest);
      const output = runOpts.output ?? "json";
      assertToolsAllowed("run", runOpts.tools, output, false);
      const captured = await readCommandSource(runOpts.file, "workflow");
      const client = await openClient();
      const launched = await client.launchRun({
        source: captured.source,
        input: runOpts.input,
        name: runOpts.name ?? captured.defaultName,
        provenance: captured.provenance,
      });
      const capabilityRef = launched.capability
        ? writeCapabilityFile(launched.runId, launched.capability)
        : null;
      if (launched.capability) await client.authenticate(launched.capability);
      if (output === "json") {
        const outcome = await client.waitForRun(launched.runId);
        const blockage = isParked(outcome.status) ? await client.getBlockage(launched.runId) : null;
        process.stdout.write(`${JSON.stringify(runEnvelope(outcome, capabilityRef, blockage))}\n`);
        return statusExitCode(outcome.status);
      }
      if (output === "text") {
        process.stdout.write(`run ${launched.runId}\n`);
      }
      const terminal = await watchRun(client, launched.runId, { output, tools: runOpts.tools });
      return statusExitCode(terminal);
    }
    case "watch": {
      const parsed = parseWatchArgs(rest);
      const { runId } = parsed;
      if (!runId) return usage("watch needs a runId");
      const client = await openClient();
      const terminal = await watchRun(client, runId, {
        output: parsed.output ?? "ndjson",
        tools: parsed.tools,
      });
      return statusExitCode(terminal);
    }
    case "get": {
      const [runId] = rest;
      if (!runId) return usage("get needs a runId");
      const client = await openClient();
      process.stdout.write(`${JSON.stringify(await client.getRun(runId), null, 2)}\n`);
      return 0;
    }
    case "output": {
      const parsed = parseRunIdOutputArgs(rest, "output", "json", ["json", "text"]);
      const { runId } = parsed;
      if (!runId) return usage("output needs a runId");
      const client = await openClient();
      const out = await client.getRunOutput(runId);
      if (out.status !== "finished") {
        process.stderr.write(`run ${runId} is ${out.status}; no terminal output available\n`);
        return out.status === "failed" ? 1 : 3;
      }
      process.stdout.write(
        parsed.output === "json"
          ? `${JSON.stringify(out.output ?? null)}\n`
          : formatHumanOutput(out.output),
      );
      return 0;
    }
    case "report": {
      const parsed = parseRunIdOutputArgs(rest, "report", "json", ["json", "text"]);
      const { runId } = parsed;
      if (!runId) return usage("report needs a runId");
      const client = await openClient();
      const report = await client.getRunReport(runId);
      if (!report) {
        process.stderr.write(`run ${runId} not found\n`);
        return 1;
      }
      process.stdout.write(
        parsed.output === "json" ? `${JSON.stringify(report)}\n` : formatRunReportText(report),
      );
      return statusExitCode(report.status);
    }
    case "resume": {
      const parsed = parseLifecycleArgs(rest);
      const [runId] = parsed.args;
      if (!runId) return usage("resume needs a runId");
      const client = await openClient();
      const out = await client.resumeRun(runId);
      if (!parsed.detach) process.stdout.write(formatRunHeader(out.runId));
      const terminal = parsed.detach
        ? null
        : await watchRun(client, out.runId, { output: "text", tools: parsed.tools });
      if (parsed.detach) process.stdout.write(`${out.runId}\t${out.status}\n`);
      return parsed.detach ? 0 : statusExitCode(terminal ?? out.status);
    }
    case "list": {
      const client = await openClient();
      for (const r of await client.listRuns()) {
        process.stdout.write(`${r.runId}\t${r.status}\t${displayName(r.workflowName)}\n`);
      }
      return 0;
    }
    case "gc": {
      const client = await openClient();
      const out = await client.gcDefinitions();
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return 0;
    }
    case "approve":
    case "deny": {
      const [runId, key, note] = rest;
      if (!runId || !key) return usage(`${cmd} needs <runId> <approvalKey> [note]`);
      const client = await openClient();
      const out = await client.decideApproval(runId, key, {
        status: cmd === "approve" ? "approved" : "denied",
        ...(note ? { note } : {}),
      });
      process.stdout.write(`${out.status}\n`);
      return 0;
    }
    case "signal": {
      const [runId, name, payloadJson] = rest;
      if (!runId || !name) return usage("signal needs <runId> <name> [json]");
      const client = await openClient();
      const out = await client.sendSignal(
        runId,
        name,
        payloadJson ? JSON.parse(payloadJson) : null,
      );
      process.stdout.write(`${out.status}\n`);
      return 0;
    }
    case "retry": {
      const parsed = parseLifecycleArgs(rest);
      const [runId] = parsed.args;
      if (!runId) return usage("retry needs a runId");
      const client = await openClient();
      const out = await client.retryRun(runId);
      if (!parsed.detach) process.stdout.write(formatRunHeader(out.runId));
      const terminal = parsed.detach
        ? null
        : await watchRun(client, out.runId, { output: "text", tools: parsed.tools });
      if (parsed.detach) process.stdout.write(`${out.runId}\t${out.status}\n`);
      return parsed.detach ? 0 : statusExitCode(terminal ?? out.status);
    }
    case "rewind": {
      const parsed = parseLifecycleArgs(rest);
      const [runId, step] = parsed.args;
      if (!runId || !step) return usage("rewind needs <runId> <stepKey>");
      const client = await openClient();
      const out = await client.rewindRun(runId, step);
      if (!parsed.detach) process.stdout.write(formatRunHeader(out.runId));
      const terminal = parsed.detach
        ? null
        : await watchRun(client, out.runId, { output: "text", tools: parsed.tools });
      if (parsed.detach) process.stdout.write(`${out.runId}\t${out.status}\n`);
      return parsed.detach ? 0 : statusExitCode(terminal ?? out.status);
    }
    case "fork": {
      const [runId, atStableKey] = rest;
      if (!runId) return usage("fork needs <runId> [atStepKey]");
      const client = await openClient();
      const out = await client.forkRun(runId, atStableKey ? { atStableKey } : {});
      const capabilityRef = out.capability ? writeCapabilityFile(out.runId, out.capability) : null;
      process.stdout.write(`${JSON.stringify({ runId: out.runId, capabilityRef })}\n`);
      return 0;
    }
    case "execute": {
      let client: DaemonClient | null = null;
      try {
        const parsed = parseExecuteArgs(rest);
        if (parsed.output !== "json") {
          throw new Error(`--output ${parsed.output} is not available for execute`);
        }
        const credential = parsed.capFile
          ? loadCredentialFromFile(parsed.capFile)
          : loadCredential();
        client = await openClient(credential);
        const source = (await readCommandSource(parsed.file, "control script")).source;
        const state = parsed.stateFile ? JSON.parse(readFileSync(parsed.stateFile, "utf8")) : null;
        const result = await runExecuteScript({
          client,
          credential,
          cwd: process.cwd(),
          source,
          ...(parsed.entry ? { entry: parsed.entry } : {}),
          args: parsed.args,
          state,
          env: process.env,
          emitCapability: parsed.emitCapability,
          writeCapability: writeCapabilityFile,
        });
        process.stdout.write(`${JSON.stringify(result ?? null)}\n`);
        return 0;
      } catch (err) {
        process.stderr.write(`${JSON.stringify({ error: structuredError(err) })}\n`);
        return 1;
      }
    }
    default:
      process.stderr.write(`keel: unknown command "${cmd}"\n\n${topHelp()}`);
      return 2;
  }
}

export function parseLifecycleArgs(args: string[]): {
  detach: boolean;
  tools: boolean;
  args: string[];
} {
  let detach = false;
  let tools = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--detach") detach = true;
    else if (arg === "--tools") tools = true;
    else if (arg.startsWith("--")) throw new Error(`unknown lifecycle flag ${arg}`);
    else positional.push(arg);
  }
  if (detach && tools) {
    throw new Error("--tools is only available for attached lifecycle --output text");
  }
  return { detach, tools, args: positional };
}

export function parseOutputFormat(value: string): OutputFormat {
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new Error(`invalid --output ${value}; expected json, text, or ndjson`);
}

export interface LaunchArgs {
  detach: boolean;
  emitCapability: boolean;
  tools: boolean;
  output?: OutputFormat;
  file?: string;
  name?: string | null;
  input: unknown;
}

export interface RunArgs {
  tools: boolean;
  output?: OutputFormat;
  file?: string;
  name?: string | null;
  input: unknown;
}

export interface ExecuteArgs {
  file?: string;
  entry?: string;
  stateFile?: string;
  capFile?: string;
  output: OutputFormat;
  emitCapability: boolean;
  args: string[];
}

export function parseLaunchArgs(args: string[]): LaunchArgs {
  const out: LaunchArgs = { detach: false, emitCapability: false, tools: false, input: {} };
  parseSourceArgs(args, out, { detach: true, emitCapability: true, output: true, tools: true });
  return out;
}

export function parseRunArgs(args: string[]): RunArgs {
  const out: RunArgs = { tools: false, input: {} };
  parseSourceArgs(args, out, { detach: false, emitCapability: false, output: true, tools: true });
  return out;
}

export function parseExecuteArgs(args: string[]): ExecuteArgs {
  const out: ExecuteArgs = { output: "json", emitCapability: false, args: [] };
  const script: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--") {
      out.args = args.slice(i + 1);
      break;
    }
    if (arg === "--entry") {
      out.entry = requireFlagValue(args, i, "--entry");
      i += 2;
    } else if (arg === "--state") {
      out.stateFile = requireFlagValue(args, i, "--state");
      i += 2;
    } else if (arg === "--cap-file") {
      out.capFile = requireFlagValue(args, i, "--cap-file");
      i += 2;
    } else if (arg === "--emit-capability") {
      out.emitCapability = true;
      i += 1;
    } else if (arg === "--output") {
      out.output = parseOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown execute flag ${arg}`);
    } else {
      script.push(arg);
      i += 1;
    }
  }
  if (script.length > 1) throw new Error("execute accepts at most one TypeScript file");
  if (script.length === 1) {
    out.file = script[0];
  }
  return out;
}

function parseSourceArgs(
  args: string[],
  out: {
    file?: string;
    name?: string | null;
    input: unknown;
    detach?: boolean;
    emitCapability?: boolean;
    tools?: boolean;
    output?: OutputFormat;
  },
  flags: { detach: boolean; emitCapability: boolean; output: boolean; tools: boolean },
): void {
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--detach" && flags.detach) {
      out.detach = true;
      i += 1;
    } else if (arg === "--emit-capability" && flags.emitCapability) {
      out.emitCapability = true;
      i += 1;
    } else if (arg === "--tools" && flags.tools) {
      out.tools = true;
      i += 1;
    } else if (arg === "--output" && flags.output) {
      out.output = parseOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg === "--name") {
      out.name = requireFlagValue(args, i, "--name");
      i += 2;
    } else if (arg === "--input") {
      out.input = parseLaunchInput(requireFlagValue(args, i, "--input"));
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (positional.length > 1) {
    throw new Error(`unexpected argument ${positional[1]}; workflow input must use --input`);
  }
  if (positional.length === 1) {
    const file = positional[0] as string;
    if (looksLikeWorkflowInput(file)) {
      throw new Error(`unexpected argument ${file}; workflow input must use --input`);
    }
    out.file = file;
  }
}

function looksLikeWorkflowInput(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function parseLaunchInput(inputJson: string | undefined): unknown {
  if (inputJson === undefined) return {};
  if (inputJson.trim() === "") {
    throw new Error("launch input must be valid JSON; omit it for {}");
  }
  return JSON.parse(inputJson);
}

export function parseRunIdOutputArgs(
  args: string[],
  command: string,
  defaultOutput: OutputFormat,
  allowed: readonly OutputFormat[],
): { runId?: string; output: OutputFormat } {
  let output = defaultOutput;
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--output") {
      output = parseOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown ${command} flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (!allowed.includes(output)) {
    throw new Error(`--output ${output} is not available for ${command}`);
  }
  if (positional.length > 1) {
    throw new Error(`unexpected argument ${positional[1]} for ${command}`);
  }
  return { runId: positional[0], output };
}

function assertToolsAllowed(
  command: string,
  tools: boolean,
  output: OutputFormat,
  detached: boolean,
): void {
  if (!tools) return;
  if (detached || output !== "text") {
    throw new Error(`--tools is only available for attached ${command} --output text`);
  }
}

export function resolveWorkflowPath(workflow: string, cwd = process.cwd()): string {
  if (workflow.startsWith("file:")) return fileURLToPath(workflow);
  return resolve(cwd, workflow);
}

export function workflowName(workflowUrl: string): string {
  const path = workflowUrl.startsWith("file:") ? fileURLToPath(workflowUrl) : workflowUrl;
  return basename(path) || "workflow";
}

interface CapturedCommandSource {
  source: string;
  defaultName: string | null;
  provenance: WorkflowProvenance;
}

async function readCommandSource(
  file: string | undefined,
  label: "workflow" | "control script",
): Promise<CapturedCommandSource> {
  if (file) {
    const path = resolveWorkflowPath(file);
    return {
      source: readFileSync(path, "utf8"),
      defaultName: workflowName(path),
      provenance: { kind: "clientPath", path },
    };
  }
  if (process.stdin.isTTY) {
    throw new Error(`no ${label} source: pass a file or pipe stdin`);
  }
  return {
    source: await new Response(Bun.stdin.stream()).text(),
    defaultName: null,
    provenance: { kind: "stdin" },
  };
}

function displayName(name: string | null | undefined): string {
  return name ?? "(unnamed)";
}

function isParked(status: string): boolean {
  return status.startsWith("waiting-");
}

function statusExitCode(status: string): number {
  if (status === "failed") return 1;
  return status === "finished" || status === "continued" ? 0 : 3;
}

function parkedStatus(payload: unknown): WatchStatus {
  const kind = prop(payload, "kind");
  if (kind === "timer") return "waiting-timer";
  if (kind === "human") return "waiting-human";
  return "waiting-signal";
}

function runEnvelope(
  outcome: RunOutcome,
  capabilityRef: string | null,
  blockage: unknown,
): Record<string, unknown> {
  return {
    runId: outcome.runId,
    capabilityRef,
    status: outcome.status,
    ...(outcome.output !== undefined ? { output: outcome.output } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(blockage ? { blockage } : {}),
  };
}

function formatHumanOutput(output: unknown): string {
  if (typeof output === "string") return output.endsWith("\n") ? output : `${output}\n`;
  return `${JSON.stringify(output ?? null)}\n`;
}

function formatLaunchText(payload: {
  runId: string;
  capability?: string | null;
  capabilityRef?: string | null;
}): string {
  return [
    `run ${payload.runId}`,
    ...(payload.capabilityRef ? [`capability ${payload.capabilityRef}`] : []),
    ...(payload.capability ? [`capability ${payload.capability}`] : []),
    "",
  ].join("\n");
}

export function formatRunReportText(report: RunReport): string {
  const lines = [
    `run ${report.runId}`,
    `status ${report.status}`,
    `workflow ${displayName(report.workflowName)}`,
  ];
  if (report.outputOmitted) {
    lines.push(`output omitted ${report.outputByteLength ?? 0} bytes`);
  } else if ("output" in report) {
    lines.push(`output ${compact(report.output)}`);
  }
  if (report.error) lines.push(`error ${report.error.name}: ${report.error.message}`);
  if (report.blockage) lines.push(`blockage ${report.blockage.reason}: ${report.blockage.context}`);
  lines.push(
    `stats steps=${report.stats.steps} agents=${report.stats.agents} artifacts=${report.stats.artifacts}`,
  );
  for (const node of report.nodes) {
    const label = `${node.stableKey} ${node.status} ${node.effectType} attempt=${node.attempt}`;
    if (node.resultOmitted) {
      lines.push(`${label} result omitted ${node.resultByteLength ?? 0} bytes`);
    } else if ("result" in node) {
      lines.push(`${label} result ${compact(node.result)}`);
    } else {
      lines.push(label);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatRunHeader(runId: string): string {
  return `run ${runId}\n`;
}

export function parseWatchArgs(args: string[]): {
  runId?: string;
  output: OutputFormat;
  tools: boolean;
} {
  let output: OutputFormat = "ndjson";
  let tools = false;
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--output") {
      output = parseOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg === "--tools") {
      tools = true;
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown watch flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (output === "json") throw new Error("--output json is not available for watch");
  if (tools && output !== "text") {
    throw new Error("--tools is only available for attached watch --output text");
  }
  if (positional.length > 1) {
    throw new Error(`unexpected argument ${positional[1]} for watch`);
  }
  return { runId: positional[0], output, tools };
}

type WatchStatus = RunOutcome["status"];

export async function watchRun(
  client: DaemonClient,
  runId: string,
  opts: WatchFormatOptions,
): Promise<WatchStatus> {
  return new Promise<WatchStatus>((resolve) => {
    let caughtUp = false;
    let settled = false;
    let pendingStatus: WatchStatus | null = null;
    let unsubscribe = () => {};
    const output = opts.output ?? "text";
    if (output !== "text" && output !== "ndjson") {
      throw new Error(`watchRun only supports text or ndjson output, got ${output}`);
    }
    const textFormatter = output === "text" ? createTextWatchFormatter(opts) : null;
    const flushTextFormatter = (): void => {
      if (!textFormatter) return;
      for (const chunk of textFormatter.flush()) process.stdout.write(chunk);
    };
    const finish = (status: WatchStatus): void => {
      if (settled) return;
      settled = true;
      flushTextFormatter();
      unsubscribe();
      resolve(status);
    };
    const noteStatus = (status: WatchStatus | null): void => {
      pendingStatus = status;
      if (caughtUp && status) finish(status);
    };
    unsubscribe = client.subscribeEvents(
      runId,
      0,
      (e) => {
        if (textFormatter) {
          for (const chunk of textFormatter.push(e)) process.stdout.write(chunk);
        } else {
          process.stdout.write(formatNdjsonWatchEvent(e));
        }
        if (e.type === "run.finished") noteStatus("finished");
        else if (e.type === "run.failed") noteStatus("failed");
        else if (e.type === "run.continued") noteStatus("continued");
        else if (e.type === "run.parked") noteStatus(parkedStatus(e.payload));
        else if (e.type === "authorization.failed") noteStatus("failed");
        else if (
          e.type === "run.resumed" ||
          e.type === "run.retry" ||
          e.type === "run.rewind" ||
          e.type === "run.rerun"
        ) {
          // A lifecycle restart supersedes any earlier terminal/parked status seen in backfill.
          noteStatus(null);
        }
      },
      (err) => {
        flushTextFormatter();
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        finish("failed");
      },
      () => {
        caughtUp = true;
        if (pendingStatus) finish(pendingStatus);
      },
    );
  });
}

function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function compact(value: unknown, max = 300): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = redactCapabilityTokens(text);
  text = text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function usage(message: string): number {
  // `message` starts with the command name (e.g. "launch needs …"); show its usage.
  const name = message.split(/\s+/)[0] ?? "";
  process.stderr.write(`keel: ${message}\n`);
  if (cmdNames.has(name)) process.stderr.write(`${cmdHelp(name)}`);
  else process.stderr.write("Run `keel help` for usage.\n");
  return 2;
}

function structuredError(err: unknown): { code: string; message: string; name: string } {
  if (err instanceof Error) {
    return { code: "execute_failed", name: err.name, message: redactCapabilityTokens(err.message) };
  }
  return { code: "execute_failed", name: "Error", message: redactCapabilityTokens(String(err)) };
}

function loadCredential(): string | null {
  if (process.env.KEEL_ADMIN_TOKEN) return process.env.KEEL_ADMIN_TOKEN;
  if (process.env.KEEL_RUN_CAP) return process.env.KEEL_RUN_CAP;
  if (process.env.KEEL_CAP_FILE) return loadCredentialFromFile(process.env.KEEL_CAP_FILE);
  return null;
}

function loadCredentialFromFile(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    capability?: unknown;
  };
  if (typeof parsed.capability !== "string") {
    throw new Error(`capability file ${path} is missing capability`);
  }
  return parsed.capability;
}

function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

function writeCapabilityFile(runId: string, capability: string): string {
  mkdirSync(CAP_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CAP_DIR, 0o700);
  const path = join(CAP_DIR, `${runId}.cap`);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        kind: "keel-capability",
        runId,
        capability,
        createdAtMs: Date.now(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`keel: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
