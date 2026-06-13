#!/usr/bin/env bun
// Thin Keel CLI (DESIGN.md §6.1) — sends one RPC to the daemon and prints the
// result. The daemon (never the CLI) hosts the realm and spawns agents (L4).
//
//   keel daemon                         start the daemon (foreground)
//   keel launch [--detach] <workflow.ts> [json]  launch a run and watch it
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
import { ClaudeProvider } from "../agents/claude.ts";
import { PiProvider } from "../agents/pi.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { DaemonClient } from "../daemon/client.ts";
import { KeelDaemon } from "../daemon/server.ts";
import { runExecuteScript } from "../execute/runtime.ts";
import type { EventEnvelope } from "../rpc/contract.ts";

const KEEL_DIR = process.env.KEEL_DIR ?? join(homedir(), ".keel");
const SOCKET = process.env.KEEL_SOCKET ?? join(KEEL_DIR, "keel.sock");
const DB = process.env.KEEL_DB ?? join(KEEL_DIR, "keel.db");
const CAP_DIR = process.env.KEEL_CAP_DIR ?? join(KEEL_DIR, "caps");

/** Connect a client, authenticating with the caller's presented capability. */
async function openClient(credential = loadCredential()): Promise<DaemonClient> {
  const c = await DaemonClient.connect(SOCKET);
  if (credential) await c.authenticate(credential);
  return c;
}

/** [name, args, summary] — single source for help + dispatch. */
const COMMANDS: [string, string, string][] = [
  ["daemon", "", "start the daemon (foreground; owns the journal + runs workflows)"],
  ["link", "[dir]", "make <dir> (default: cwd) able to import the @kcosr/keel SDK"],
  [
    "launch",
    "[--detach] [--emit-capability] <workflow.ts> [json]",
    "start a run from a workflow file",
  ],
  ["watch", "[--json] <runId>", "stream a run's events until it finishes"],
  ["get", "<runId>", "print a run's projection as JSON"],
  ["list", "", "list runs"],
  ["resume", "[--detach] <runId>", "resume a parked or incomplete run"],
  ["retry", "[--detach] <runId>", "re-run a failed run from its failed step"],
  ["rewind", "[--detach] <runId> <stepKey>", "discard everything after a step and re-run"],
  ["fork", "<runId> [atStepKey]", "copy a run into a new independent run"],
  [
    "execute",
    "[--stdin|file] [--entry name] [--state file] [--cap-file file] [--emit-capability] [-- args...]",
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
      const parsed = parseLifecycleArgs(launchOpts.args);
      const [workflow, inputJson] = parsed.args;
      if (!workflow) return usage("launch needs a workflow path");
      const input = parseLaunchInput(inputJson);
      const workflowUrl = resolveWorkflowPath(workflow);
      const client = await openClient();
      const launched = await client.launchRun({
        workflowUrl,
        input,
        name: workflowName(workflowUrl),
      });
      const { runId } = launched;
      const capabilityRef =
        launched.capability && !launchOpts.emitCapability
          ? writeCapabilityFile(runId, launched.capability)
          : null;
      if (launched.capability) await client.authenticate(launched.capability);
      if (!parsed.detach) process.stdout.write(formatRunHeader(runId));
      if (!parsed.detach && capabilityRef) process.stdout.write(`capability ${capabilityRef}\n`);
      if (!parsed.detach && launchOpts.emitCapability && launched.capability) {
        process.stdout.write(`capability ${launched.capability}\n`);
      }
      const terminal = parsed.detach ? null : await watchRun(client, runId, { json: false });
      if (parsed.detach) {
        const payload = launchOpts.emitCapability
          ? { runId, capability: launched.capability ?? null }
          : { runId, capabilityRef };
        process.stdout.write(`${JSON.stringify(payload)}\n`);
      }
      client.close();
      return terminal === "failed" ? 1 : 0;
    }
    case "watch": {
      const parsed = parseWatchArgs(rest);
      const { runId } = parsed;
      if (!runId) return usage("watch needs a runId");
      const client = await openClient();
      const terminal = await watchRun(client, runId, { json: parsed.json });
      client.close();
      return terminal === "failed" ? 1 : 0;
    }
    case "get": {
      const [runId] = rest;
      if (!runId) return usage("get needs a runId");
      const client = await openClient();
      process.stdout.write(`${JSON.stringify(await client.getRun(runId), null, 2)}\n`);
      client.close();
      return 0;
    }
    case "resume": {
      const parsed = parseLifecycleArgs(rest);
      const [runId] = parsed.args;
      if (!runId) return usage("resume needs a runId");
      const client = await openClient();
      const out = await client.resumeRun(runId);
      if (!parsed.detach) process.stdout.write(formatRunHeader(out.runId));
      const terminal = parsed.detach ? null : await watchRun(client, out.runId, { json: false });
      if (parsed.detach) process.stdout.write(`${out.runId}\t${out.status}\n`);
      client.close();
      return terminal === "failed" ? 1 : 0;
    }
    case "list": {
      const client = await openClient();
      for (const r of await client.listRuns()) {
        process.stdout.write(`${r.runId}\t${r.status}\t${r.workflowName}\n`);
      }
      client.close();
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
      client.close();
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
      client.close();
      return 0;
    }
    case "retry": {
      const parsed = parseLifecycleArgs(rest);
      const [runId] = parsed.args;
      if (!runId) return usage("retry needs a runId");
      const client = await openClient();
      const out = await client.retryRun(runId);
      if (!parsed.detach) process.stdout.write(formatRunHeader(out.runId));
      const terminal = parsed.detach ? null : await watchRun(client, out.runId, { json: false });
      if (parsed.detach) process.stdout.write(`${out.runId}\t${out.status}\n`);
      client.close();
      return terminal === "failed" ? 1 : 0;
    }
    case "rewind": {
      const parsed = parseLifecycleArgs(rest);
      const [runId, step] = parsed.args;
      if (!runId || !step) return usage("rewind needs <runId> <stepKey>");
      const client = await openClient();
      const out = await client.rewindRun(runId, step);
      if (!parsed.detach) process.stdout.write(formatRunHeader(out.runId));
      const terminal = parsed.detach ? null : await watchRun(client, out.runId, { json: false });
      if (parsed.detach) process.stdout.write(`${out.runId}\t${out.status}\n`);
      client.close();
      return terminal === "failed" ? 1 : 0;
    }
    case "fork": {
      const [runId, atStableKey] = rest;
      if (!runId) return usage("fork needs <runId> [atStepKey]");
      const client = await openClient();
      const out = await client.forkRun(runId, atStableKey ? { atStableKey } : {});
      const capabilityRef = out.capability ? writeCapabilityFile(out.runId, out.capability) : null;
      process.stdout.write(`${JSON.stringify({ runId: out.runId, capabilityRef })}\n`);
      client.close();
      return 0;
    }
    case "execute": {
      const parsed = parseExecuteArgs(rest);
      const credential = parsed.capFile ? loadCredentialFromFile(parsed.capFile) : loadCredential();
      const client = await openClient(credential);
      try {
        const source = parsed.stdin
          ? await new Response(Bun.stdin.stream()).text()
          : readFileSync(parsed.file as string, "utf8");
        const state = parsed.stateFile ? JSON.parse(readFileSync(parsed.stateFile, "utf8")) : null;
        const result = await runExecuteScript({
          client,
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
      } finally {
        client.close();
      }
    }
    default:
      process.stderr.write(`keel: unknown command "${cmd}"\n\n${topHelp()}`);
      return 2;
  }
}

export function parseLifecycleArgs(args: string[]): { detach: boolean; args: string[] } {
  if (args[0] === "--detach") return { detach: true, args: args.slice(1) };
  return { detach: false, args };
}

export function parseLaunchArgs(args: string[]): { emitCapability: boolean; args: string[] } {
  return {
    emitCapability: args.includes("--emit-capability"),
    args: args.filter((arg) => arg !== "--emit-capability"),
  };
}

export interface ExecuteArgs {
  stdin: boolean;
  file?: string;
  entry?: string;
  stateFile?: string;
  capFile?: string;
  emitCapability: boolean;
  args: string[];
}

export function parseExecuteArgs(args: string[]): ExecuteArgs {
  const out: ExecuteArgs = { stdin: false, emitCapability: false, args: [] };
  const script: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--") {
      out.args = args.slice(i + 1);
      break;
    }
    if (arg === "--stdin") {
      out.stdin = true;
      i += 1;
    } else if (arg === "--entry") {
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
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown execute flag ${arg}`);
    } else {
      script.push(arg);
      i += 1;
    }
  }
  if (out.stdin && script.length > 0)
    throw new Error("execute accepts --stdin or a file, not both");
  if (!out.stdin) {
    if (script.length !== 1)
      throw new Error("execute needs exactly one TypeScript file or --stdin");
    out.file = script[0];
  }
  return out;
}

export function parseLaunchInput(inputJson: string | undefined): unknown {
  if (inputJson === undefined) return {};
  if (inputJson.trim() === "") {
    throw new Error("launch input must be valid JSON; omit it for {}");
  }
  return JSON.parse(inputJson);
}

export function resolveWorkflowPath(workflow: string, cwd = process.cwd()): string {
  if (workflow.startsWith("file:")) return workflow;
  return resolve(cwd, workflow);
}

export function workflowName(workflowUrl: string): string {
  const path = workflowUrl.startsWith("file:") ? new URL(workflowUrl).pathname : workflowUrl;
  return basename(path) || "workflow";
}

export function formatRunHeader(runId: string): string {
  return `run ${runId}\n`;
}

export function parseWatchArgs(args: string[]): { runId?: string; json: boolean } {
  if (args[0] === "--json") return { runId: args[1], json: true };
  return { runId: args[0], json: false };
}

async function watchRun(
  client: DaemonClient,
  runId: string,
  opts: { json?: boolean },
): Promise<"finished" | "failed" | "continued"> {
  return new Promise<"finished" | "failed" | "continued">((resolve) => {
    client.subscribeEvents(runId, 0, (e) => {
      process.stdout.write(formatWatchEvent(e, opts));
      if (e.type === "run.finished") resolve("finished");
      if (e.type === "run.failed") resolve("failed");
      if (e.type === "run.continued") resolve("continued");
    });
  });
}

export function formatWatchEvent(event: EventEnvelope, opts: { json?: boolean } = {}): string {
  if (opts.json) return `${JSON.stringify(event)}\n`;

  const prefix = `[${event.seq}]`;
  const payload = event.payload;
  switch (event.type) {
    case "agent.event":
      return `${prefix} ${formatAgentEvent(payload)}\n`;
    case "phase": {
      const title = prop(payload, "title");
      return `${prefix} phase${title ? `: ${compact(title)}` : ""}\n`;
    }
    case "log": {
      const message = prop(payload, "message");
      const data = prop(payload, "data");
      return `${prefix} log${message ? `: ${compact(message)}` : ""}${
        hasContent(data) ? ` ${compact(data)}` : ""
      }\n`;
    }
    case "step.completed": {
      const stableKey = prop(payload, "stableKey");
      const effectType = prop(payload, "effectType");
      return `${prefix} step.completed${stableKey ? ` ${compact(stableKey)}` : ""}${
        effectType ? ` (${compact(effectType)})` : ""
      }\n`;
    }
    case "run.parked": {
      const kind = prop(payload, "kind");
      const key = prop(payload, "key");
      return `${prefix} run.parked${kind ? ` ${compact(kind)}` : ""}${
        key ? ` ${compact(key)}` : ""
      }\n`;
    }
    case "run.failed": {
      const message = prop(payload, "message") ?? prop(payload, "error");
      return `${prefix} run.failed${message ? `: ${compact(message)}` : formatPayload(payload)}\n`;
    }
    default:
      return `${prefix} ${event.type}${formatPayload(payload)}\n`;
  }
}

function formatAgentEvent(payload: unknown): string {
  const key = prop(payload, "key");
  const event = prop(payload, "event");
  const traceType = prop(event, "type");
  const data = prop(event, "data");
  const parts = ["agent"];
  if (key) parts.push(compact(key));
  if (traceType) parts.push(compact(traceType));
  const label = parts.join(" ");
  if (!key && !traceType && !hasContent(data)) return `${label}: ${compact(payload)}`;
  if (!traceType && hasContent(event)) return `${label}: ${compact(event)}`;
  return hasContent(data) ? `${label}: ${compact(data)}` : label;
}

function formatPayload(payload: unknown): string {
  return hasContent(payload) ? ` ${compact(payload)}` : "";
}

function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function hasContent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
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
    return { code: "execute_failed", name: err.name, message: err.message };
  }
  return { code: "execute_failed", name: "Error", message: String(err) };
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
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
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
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`keel: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
