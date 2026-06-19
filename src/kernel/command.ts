import { posix } from "node:path";
import {
  type Capabilities,
  DENY_ALL,
  validateCapabilitiesDeclaration,
} from "../agents/capabilities.ts";
import {
  type AgentEnvironmentSpec,
  type NormalizedAgentEnvironment,
  assertEnvironmentSecretsGranted,
  normalizeAgentEnvironment,
} from "../agents/environment.ts";
import type { Json } from "../hash.ts";
import { WORKFLOW_SDK_ABI_VERSION } from "../workflow-definitions/snapshot.ts";

export const WORKFLOW_COMMAND_RUNNER_VERSION = 1;
export const WORKFLOW_COMMAND_ENVIRONMENT_POLICY_VERSION = 1;
export const WORKFLOW_COMMAND_BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SSH_AUTH_SOCK",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
] as const;
export const MAX_WORKFLOW_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const MAX_WORKFLOW_COMMAND_STALL_TIMEOUT_MS = 30 * 60_000;
export const MAX_WORKFLOW_COMMAND_STDOUT_BYTES = 4 * 1024 * 1024;
export const MAX_WORKFLOW_COMMAND_STDERR_BYTES = 4 * 1024 * 1024;
export const WORKFLOW_COMMAND_KILL_GRACE_MS = 5_000;
export const WORKFLOW_COMMAND_EVENT_OUTPUT_SNIPPET_BYTES = 4 * 1024;
export const WORKFLOW_COMMAND_SHELL_EXECUTABLE = "/bin/sh";
export const COMMAND_STABLE_KEY_PREFIX = "command.";
const SESSION_STABLE_KEY_PREFIX = "__session.";

export type WorkflowCommandSpec = WorkflowCommandBase &
  (ArgvCommandInvocation | ShellCommandInvocation);

export interface WorkflowCommandBase {
  key: string;
  workspace: WorkspaceHandleLike;
  cwd: string;
  capabilities: Partial<Capabilities>;
  environment?: AgentEnvironmentSpec;
  timeoutMs: number;
  stallTimeoutMs?: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  successExitCodes?: number[];
  failureMode?: "throw" | "return";
  bump?: string | number;
}

export interface WorkspaceHandleLike {
  readonly id: string;
  readonly identityHash?: string;
  readonly setupIdentityHash?: string | null;
}

export interface ArgvCommandInvocation {
  mode: "argv";
  argv: [string, ...string[]];
}

export interface ShellCommandInvocation {
  mode: "shell";
  shell: string;
}

export interface BoundedText {
  text: string;
  byteLength: number;
  truncated: boolean;
  omittedBytes: number;
}

export type CommandResultStatus =
  | "exited"
  | "signaled"
  | "timed-out"
  | "stalled"
  | "spawn-error"
  | "output-capture-error";

export interface CommandResult {
  key: string;
  attempt: number;
  status: CommandResultStatus;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stalled: boolean;
  stdout: BoundedText;
  stderr: BoundedText;
  durationMs: number;
  startedAtMs: number;
  finishedAtMs: number;
  workspaceId: string;
  workspaceIdentityHash?: string;
  cwd: string;
  invocation:
    | { mode: "argv"; argv: string[] }
    | { mode: "shell"; shell: string; shellExecutable: typeof WORKFLOW_COMMAND_SHELL_EXECUTABLE };
  output: {
    stdoutCapBytes: number;
    stderrCapBytes: number;
    resultArtifactBacked: boolean;
  };
  error?: {
    kind: "nonzero-exit" | "signal" | "timeout" | "stall" | "spawn-error" | "output-capture-error";
    message: string;
  };
}

export interface NormalizedWorkflowCommandSpec {
  key: string;
  stableKey: string;
  workspaceId: string;
  workspaceIdentityHash: string | null;
  setupIdentityHash: string | null;
  cwd: string;
  invocation:
    | { mode: "argv"; argv: string[] }
    | { mode: "shell"; shell: string; shellExecutable: typeof WORKFLOW_COMMAND_SHELL_EXECUTABLE };
  capabilities: Capabilities;
  environment: NormalizedAgentEnvironment;
  timeoutMs: number;
  stallTimeoutMs: number | null;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  successExitCodes: number[];
  failureMode: "throw" | "return";
  identity: Json;
  bump: string | number | null;
}

export class CommandFailure extends Error {
  readonly result: CommandResult;

  constructor(result: CommandResult) {
    super(commandFailureMessage(result));
    this.name = "CommandFailure";
    this.result = result;
  }
}

export function normalizeWorkflowCommandSpec(
  value: unknown,
  opts: { path?: string } = {},
): NormalizedWorkflowCommandSpec {
  const path = opts.path ?? "ctx.command";
  if (!isPlainObject(value)) throw new Error(`${path} spec must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  const raw = value as Record<string, unknown>;
  const mode = raw.mode;
  const allowed = new Set([
    "key",
    "workspace",
    "cwd",
    "capabilities",
    "environment",
    "timeoutMs",
    "stallTimeoutMs",
    "maxStdoutBytes",
    "maxStderrBytes",
    "successExitCodes",
    "failureMode",
    "bump",
    "mode",
    mode === "argv" ? "argv" : "shell",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
  for (const removed of ["toolPolicy", "allowTools", "denyTools"]) {
    if (raw[removed] !== undefined) {
      throw new Error(`${path}.${removed} is not supported; use capabilities`);
    }
  }

  const key = normalizeCommandKey(raw.key, path);
  const workspace = normalizeWorkspaceHandle(raw.workspace, `${path}.workspace`);
  const cwd = normalizeCommandCwd(raw.cwd, `${path}.cwd`);
  const capabilities = normalizeCommandCapabilities(raw.capabilities, `${path}.capabilities`);
  const environment = normalizeAgentEnvironment(raw.environment, {
    path: `${path}.environment`,
  });
  assertEnvironmentSecretsGranted(environment, capabilities, path);
  const timeoutMs = normalizePositiveInteger(
    raw.timeoutMs,
    `${path}.timeoutMs`,
    MAX_WORKFLOW_COMMAND_TIMEOUT_MS,
  );
  const stallTimeoutMs =
    raw.stallTimeoutMs === undefined
      ? null
      : normalizePositiveInteger(
          raw.stallTimeoutMs,
          `${path}.stallTimeoutMs`,
          Math.min(timeoutMs, MAX_WORKFLOW_COMMAND_STALL_TIMEOUT_MS),
        );
  const maxStdoutBytes = normalizePositiveInteger(
    raw.maxStdoutBytes,
    `${path}.maxStdoutBytes`,
    MAX_WORKFLOW_COMMAND_STDOUT_BYTES,
  );
  const maxStderrBytes = normalizePositiveInteger(
    raw.maxStderrBytes,
    `${path}.maxStderrBytes`,
    MAX_WORKFLOW_COMMAND_STDERR_BYTES,
  );
  const successExitCodes = normalizeSuccessExitCodes(raw.successExitCodes, path);
  const failureMode = normalizeFailureMode(raw.failureMode, path);
  const invocation = normalizeInvocation(raw, path);
  const stableKey = `${COMMAND_STABLE_KEY_PREFIX}${key}`;
  const bump =
    raw.bump === undefined
      ? null
      : typeof raw.bump === "string" || typeof raw.bump === "number"
        ? raw.bump
        : (() => {
            throw new Error(`${path}.bump must be a string or number`);
          })();
  const identity = commandIdentity({
    key,
    workspaceId: workspace.id,
    workspaceIdentityHash: workspace.identityHash ?? null,
    setupIdentityHash: workspace.setupIdentityHash ?? null,
    cwd,
    invocation,
    capabilities,
    environment,
    timeoutMs,
    stallTimeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    successExitCodes,
    failureMode,
    bump,
  });

  return Object.freeze({
    key,
    stableKey,
    workspaceId: workspace.id,
    workspaceIdentityHash: workspace.identityHash ?? null,
    setupIdentityHash: workspace.setupIdentityHash ?? null,
    cwd,
    invocation,
    capabilities: Object.freeze({
      ...capabilities,
      network: capabilities.network === "none" ? "none" : Object.freeze([...capabilities.network]),
      secrets: Object.freeze([...capabilities.secrets]),
    }) as Capabilities,
    environment,
    timeoutMs,
    stallTimeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    successExitCodes: Object.freeze([...successExitCodes]) as number[],
    failureMode,
    identity,
    bump,
  });
}

export function commandFailed(result: CommandResult): boolean {
  return result.error !== undefined;
}

export function applyCommandFailureMode(result: CommandResult, failureMode: "throw" | "return") {
  if (failureMode === "throw" && commandFailed(result)) throw new CommandFailure(result);
}

export function commandFailureMessage(result: CommandResult): string {
  const exit =
    result.exitCode !== null
      ? `exit=${result.exitCode}`
      : result.signal !== null
        ? `signal=${result.signal}`
        : "no-exit";
  const output = result.stderr.text || result.stdout.text;
  const summary = output ? ` output=${singleLineSnippet(output, 800)}` : "";
  return `command ${result.key} failed: status=${result.status} ${exit} timedOut=${String(
    result.timedOut,
  )} stalled=${String(result.stalled)} workspace=${result.workspaceId} cwd=${
    result.cwd
  } durationMs=${result.durationMs}${summary}`;
}

export function withCommandFailure(
  result: CommandResult,
  successExitCodes: readonly number[],
): CommandResult {
  if (result.error) return result;
  if (result.status === "exited") {
    if (result.exitCode !== null && successExitCodes.includes(result.exitCode)) return result;
    return {
      ...result,
      error: {
        kind: "nonzero-exit",
        message: `command exited with code ${result.exitCode ?? "unknown"}`,
      },
    };
  }
  if (result.status === "signaled") {
    return {
      ...result,
      error: {
        kind: "signal",
        message: `command terminated by signal ${result.signal ?? "unknown"}`,
      },
    };
  }
  if (result.status === "timed-out") {
    return { ...result, error: { kind: "timeout", message: "command timed out" } };
  }
  if (result.status === "stalled") {
    return { ...result, error: { kind: "stall", message: "command stalled" } };
  }
  if (result.status === "spawn-error") {
    return result.error
      ? result
      : { ...result, error: { kind: "spawn-error", message: "command failed to spawn" } };
  }
  return result.error
    ? result
    : {
        ...result,
        error: { kind: "output-capture-error", message: "command output capture failed" },
      };
}

export function commandStartedEvent(command: NormalizedWorkflowCommandSpec, attempt: number): Json {
  return {
    key: command.key,
    stableKey: command.stableKey,
    attempt,
    workspaceId: command.workspaceId,
    ...(command.workspaceIdentityHash
      ? { workspaceIdentityHash: command.workspaceIdentityHash }
      : {}),
    cwd: command.cwd,
    invocation:
      command.invocation.mode === "argv"
        ? { mode: "argv", argvPreview: command.invocation.argv }
        : {
            mode: "shell",
            shellPreview: command.invocation.shell,
            shellExecutable: command.invocation.shellExecutable,
          },
    capabilities: command.capabilities,
    environment: {
      varNames: Object.keys(command.environment.vars).sort(),
      secretNames: [...command.environment.secrets].sort(),
      baseAllowlistNames: [...WORKFLOW_COMMAND_BASE_ENV_ALLOWLIST],
    },
    timeoutMs: command.timeoutMs,
    stallTimeoutMs: command.stallTimeoutMs,
    maxStdoutBytes: command.maxStdoutBytes,
    maxStderrBytes: command.maxStderrBytes,
  } as unknown as Json;
}

export function commandCompletedEvent(
  command: NormalizedWorkflowCommandSpec,
  result: CommandResult,
): Json {
  return {
    key: command.key,
    stableKey: command.stableKey,
    attempt: result.attempt,
    workspaceId: result.workspaceId,
    cwd: result.cwd,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stalled: result.stalled,
    durationMs: result.durationMs,
    success: !commandFailed(result),
    ...(result.error ? { failureKind: result.error.kind } : {}),
    stdout: outputEventSummary(result.stdout),
    stderr: outputEventSummary(result.stderr),
    resultArtifactBacked: result.output.resultArtifactBacked,
  } as unknown as Json;
}

export function buildCommandEnvironment(
  environment: NormalizedAgentEnvironment,
  resolvedSecrets: readonly { name: string; value: string }[],
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of WORKFLOW_COMMAND_BASE_ENV_ALLOWLIST) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(environment.vars)) env[name] = value;
  for (const { name, value } of resolvedSecrets) env[name] = value;
  return env;
}

function commandIdentity(fields: {
  key: string;
  workspaceId: string;
  workspaceIdentityHash: string | null;
  setupIdentityHash: string | null;
  cwd: string;
  invocation: NormalizedWorkflowCommandSpec["invocation"];
  capabilities: Capabilities;
  environment: NormalizedAgentEnvironment;
  timeoutMs: number;
  stallTimeoutMs: number | null;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  successExitCodes: number[];
  failureMode: "throw" | "return";
  bump: string | number | null;
}): Json {
  return {
    commandRunnerVersion: WORKFLOW_COMMAND_RUNNER_VERSION,
    workflowSdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
    key: fields.key,
    workspaceId: fields.workspaceId,
    ...(fields.workspaceIdentityHash
      ? { workspaceIdentityHash: fields.workspaceIdentityHash }
      : {}),
    ...(fields.setupIdentityHash ? { setupIdentityHash: fields.setupIdentityHash } : {}),
    cwd: fields.cwd,
    invocation: fields.invocation,
    capabilities: {
      fs: fields.capabilities.fs,
      shell: fields.capabilities.shell,
      network: fields.capabilities.network === "none" ? "none" : [...fields.capabilities.network],
      secrets: [...fields.capabilities.secrets].sort(),
    },
    environmentPolicyVersion: WORKFLOW_COMMAND_ENVIRONMENT_POLICY_VERSION,
    baseEnvironmentAllowlistNames: [...WORKFLOW_COMMAND_BASE_ENV_ALLOWLIST],
    environment: {
      vars: fields.environment.vars,
      secretNames: [...fields.environment.secrets].sort(),
    },
    timeoutMs: fields.timeoutMs,
    stallTimeoutMs: fields.stallTimeoutMs,
    maxStdoutBytes: fields.maxStdoutBytes,
    maxStderrBytes: fields.maxStderrBytes,
    successExitCodes: fields.successExitCodes,
    failureMode: fields.failureMode,
    ...(fields.bump !== null ? { bump: fields.bump } : {}),
  } satisfies Json;
}

function normalizeCommandKey(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.key must be a non-empty string`);
  }
  if (value.startsWith(SESSION_STABLE_KEY_PREFIX)) {
    throw new Error(`${path}.key "${value}" uses reserved prefix ${SESSION_STABLE_KEY_PREFIX}`);
  }
  return value;
}

function normalizeWorkspaceHandle(value: unknown, path: string): WorkspaceHandleLike {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be a WorkspaceHandle produced by ctx.workspace`);
  }
  rejectSymbolOrNonEnumerableKeys(value, path);
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== "id" && key !== "identityHash" && key !== "setupIdentityHash") {
      throw new Error(`${path}.${key} is not supported`);
    }
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error(`${path}.id must be a non-empty string`);
  }
  if (raw.identityHash !== undefined && typeof raw.identityHash !== "string") {
    throw new Error(`${path}.identityHash must be a string`);
  }
  if (
    raw.setupIdentityHash !== undefined &&
    raw.setupIdentityHash !== null &&
    typeof raw.setupIdentityHash !== "string"
  ) {
    throw new Error(`${path}.setupIdentityHash must be a string or null`);
  }
  return {
    id: raw.id,
    ...(raw.identityHash !== undefined ? { identityHash: raw.identityHash } : {}),
    ...(raw.setupIdentityHash !== undefined
      ? { setupIdentityHash: raw.setupIdentityHash as string | null }
      : {}),
  };
}

export function normalizeCommandCwd(value: unknown, path = "cwd"): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  if (value.length === 0) throw new Error(`${path} must not be empty`);
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`${path} must be relative to the workspace`);
  }
  const slash = value.replace(/\\/g, "/");
  const parts = slash.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(`${path} must not contain .. path segments`);
  }
  const normalized = posix.normalize(slash);
  if (normalized === "" || normalized === ".") return ".";
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    throw new Error(`${path} must stay inside the workspace`);
  }
  return normalized;
}

function normalizeInvocation(
  raw: Record<string, unknown>,
  path: string,
): NormalizedWorkflowCommandSpec["invocation"] {
  if (raw.mode === "argv") {
    if (!Array.isArray(raw.argv)) throw new Error(`${path}.argv must be an array`);
    rejectArrayKeys(raw.argv, `${path}.argv`);
    if (raw.argv.length === 0) throw new Error(`${path}.argv must not be empty`);
    const argv: string[] = [];
    for (let i = 0; i < raw.argv.length; i += 1) {
      if (!(i in raw.argv)) throw new Error(`${path}.argv[${i}] must not be a sparse array hole`);
      const item = raw.argv[i];
      if (typeof item !== "string" || item.length === 0) {
        throw new Error(`${path}.argv[${i}] must be a non-empty string`);
      }
      argv.push(item);
    }
    return { mode: "argv", argv };
  }
  if (raw.mode === "shell") {
    if (typeof raw.shell !== "string" || raw.shell.trim().length === 0) {
      throw new Error(`${path}.shell must be a non-empty string`);
    }
    return {
      mode: "shell",
      shell: raw.shell,
      shellExecutable: WORKFLOW_COMMAND_SHELL_EXECUTABLE,
    };
  }
  throw new Error(`${path}.mode must be "argv" or "shell"`);
}

function normalizeCommandCapabilities(value: unknown, path: string): Capabilities {
  if (!isPlainObject(value)) throw new Error(`${path} is required and must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  const declared = validateCapabilitiesDeclaration(value as Record<string, unknown>, path);
  const capabilities: Capabilities = {
    ...DENY_ALL,
    ...declared,
    network:
      declared.network === undefined
        ? DENY_ALL.network
        : declared.network === "none"
          ? "none"
          : [...declared.network],
    secrets: declared.secrets ? [...declared.secrets].sort() : [],
  };
  if (capabilities.shell !== true) throw new Error(`${path}.shell must be true for ctx.command`);
  if (capabilities.fs !== "workspace-write") {
    throw new Error(`${path}.fs must be "workspace-write" for ctx.command`);
  }
  return capabilities;
}

function normalizePositiveInteger(value: unknown, path: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  if (value > max) throw new Error(`${path} must be <= ${max}`);
  return value;
}

function normalizeSuccessExitCodes(value: unknown, path: string): number[] {
  if (value === undefined) return [0];
  if (!Array.isArray(value)) throw new Error(`${path}.successExitCodes must be an array`);
  rejectArrayKeys(value, `${path}.successExitCodes`);
  if (value.length === 0) throw new Error(`${path}.successExitCodes must not be empty`);
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!(i in value)) {
      throw new Error(`${path}.successExitCodes[${i}] must not be a sparse array hole`);
    }
    const code = value[i];
    if (typeof code !== "number" || !Number.isInteger(code) || code < 0 || code > 255) {
      throw new Error(`${path}.successExitCodes[${i}] must be an integer from 0 to 255`);
    }
    if (seen.has(code)) throw new Error(`${path}.successExitCodes contains duplicate ${code}`);
    seen.add(code);
    out.push(code);
  }
  return out;
}

function normalizeFailureMode(value: unknown, path: string): "throw" | "return" {
  if (value === undefined) return "throw";
  if (value === "throw" || value === "return") return value;
  throw new Error(`${path}.failureMode must be "throw" or "return"`);
}

function outputEventSummary(text: BoundedText): Json {
  return {
    byteLength: text.byteLength,
    truncated: text.truncated,
    omittedBytes: text.omittedBytes,
    snippet: byteSnippet(text.text, WORKFLOW_COMMAND_EVENT_OUTPUT_SNIPPET_BYTES),
  };
}

function byteSnippet(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes));
}

function singleLineSnippet(text: string, maxBytes: number): string {
  return byteSnippet(text, maxBytes).replace(/\s+/g, " ").trim();
}

function rejectArrayKeys(value: unknown[], path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`${path} must not use symbol keys`);
    if (key === "length" || /^\d+$/.test(key)) continue;
    throw new Error(`${path} must not define non-index key ${key}`);
  }
}

function rejectSymbolOrNonEnumerableKeys(value: object, path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`${path} must not use symbol keys`);
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc?.enumerable) throw new Error(`${path}.${String(key)} must be enumerable`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
