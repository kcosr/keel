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
import { type Json, hashJson } from "../hash.ts";
import { WORKFLOW_SDK_ABI_VERSION } from "../workflow-definitions/abi.ts";
import {
  type NormalizedWorkflowCommandSpec,
  type WorkflowCommandBase,
  normalizeCommandCwd,
} from "./command.ts";

export const WORKSPACE_SETUP_RULES_VERSION = 1;
export const WORKSPACE_SETUP_ENVIRONMENT_POLICY_VERSION = 1;
export const WORKSPACE_SETUP_STABLE_KEY_PREFIX = "workspace.setup.";
export const DEFAULT_WORKSPACE_SETUP_TIMEOUT_MS = 120_000;
export const DEFAULT_WORKSPACE_SETUP_STDOUT_BYTES = 200_000;
export const DEFAULT_WORKSPACE_SETUP_STDERR_BYTES = 100_000;
export const MAX_WORKSPACE_SETUP_TIMEOUT_MS = 30 * 60_000;
export const MAX_WORKSPACE_SETUP_STDOUT_BYTES = 4 * 1024 * 1024;
export const MAX_WORKSPACE_SETUP_STDERR_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_SETUP_BASE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
] as const;

const SESSION_STABLE_KEY_PREFIX = "__session.";
const COMMAND_KEY_RE = /^[A-Za-z0-9_-]+$/;

export interface WorkspaceSetupSpec {
  capabilities: Partial<Capabilities>;
  commands: WorkspaceSetupCommand[];
}

export interface WorkspaceSetupCommand {
  key: string;
  command: string;
  args?: string[];
  cwd?: string;
  environment?: AgentEnvironmentSpec;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  successExitCodes?: number[];
}

export interface NormalizedWorkspaceSetupSpec {
  identity: Json;
  identityHash: string;
  capabilities: Capabilities;
  commands: readonly NormalizedWorkspaceSetupCommand[];
}

export interface NormalizedWorkspaceSetupCommand {
  key: string;
  command: string;
  args: string[];
  cwd: string;
  environment: NormalizedAgentEnvironment;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  successExitCodes: number[];
  identity: Json;
}

export function normalizeWorkspaceSetupSpec(
  value: unknown,
  opts: {
    path?: string;
    workspaceId: string;
    workspaceIdentityHash: string;
  },
): NormalizedWorkspaceSetupSpec | null {
  if (value === undefined) return null;
  const path = opts.path ?? "WorkspaceSpec.setup";
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["capabilities", "commands"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
  const capabilities = normalizeSetupCapabilities(raw.capabilities, `${path}.capabilities`);
  if (!Array.isArray(raw.commands)) throw new Error(`${path}.commands must be an array`);
  const rawCommands = raw.commands;
  rejectArrayKeys(rawCommands, `${path}.commands`);
  if (rawCommands.length === 0) throw new Error(`${path}.commands must not be empty`);
  const seen = new Set<string>();
  const commands = rawCommands.map((command, index) => {
    if (!(index in rawCommands)) {
      throw new Error(`${path}.commands[${index}] must not be a sparse array hole`);
    }
    const normalized = normalizeWorkspaceSetupCommand(command, {
      path: `${path}.commands[${index}]`,
      capabilities,
    });
    if (seen.has(normalized.key)) {
      throw new Error(`${path}.commands contains duplicate key "${normalized.key}"`);
    }
    seen.add(normalized.key);
    return normalized;
  });
  const identity = setupIdentity({
    workspaceId: opts.workspaceId,
    workspaceIdentityHash: opts.workspaceIdentityHash,
    capabilities,
    commands,
  });
  return Object.freeze({
    identity,
    identityHash: hashJson(identity),
    capabilities,
    commands: Object.freeze(commands),
  });
}

export function workspaceSetupCommandStableKey(workspaceId: string, commandKey: string): string {
  return `${WORKSPACE_SETUP_STABLE_KEY_PREFIX}${workspaceId}.${commandKey}`;
}

export function setupCommandToWorkflowCommand(
  workspaceId: string,
  workspaceIdentityHash: string,
  setup: NormalizedWorkspaceSetupSpec,
  command: NormalizedWorkspaceSetupCommand,
): NormalizedWorkflowCommandSpec {
  const stableKey = workspaceSetupCommandStableKey(workspaceId, command.key);
  const invocation = { mode: "argv" as const, argv: [command.command, ...command.args] };
  const identity: Json = {
    setupCommandRunnerVersion: WORKSPACE_SETUP_RULES_VERSION,
    workflowSdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
    setupIdentityHash: setup.identityHash,
    key: command.key,
    workspaceId,
    workspaceIdentityHash,
    cwd: command.cwd,
    invocation,
    capabilities: setupCapabilitiesIdentity(setup.capabilities),
    environmentPolicyVersion: WORKSPACE_SETUP_ENVIRONMENT_POLICY_VERSION,
    baseEnvironmentAllowlistNames: [...WORKSPACE_SETUP_BASE_ENV_ALLOWLIST],
    environment: {
      vars: command.environment.vars,
      secretNames: [...command.environment.secrets].sort(),
    },
    timeoutMs: command.timeoutMs,
    stallTimeoutMs: null,
    maxStdoutBytes: command.maxStdoutBytes,
    maxStderrBytes: command.maxStderrBytes,
    successExitCodes: command.successExitCodes,
    failureMode: "return",
  };
  return Object.freeze({
    key: command.key,
    stableKey,
    workspaceId,
    workspaceIdentityHash,
    setupIdentityHash: setup.identityHash,
    cwd: command.cwd,
    invocation,
    capabilities: setup.capabilities,
    environment: command.environment,
    timeoutMs: command.timeoutMs,
    stallTimeoutMs: null,
    maxStdoutBytes: command.maxStdoutBytes,
    maxStderrBytes: command.maxStderrBytes,
    successExitCodes: command.successExitCodes,
    failureMode: "return",
    identity,
    bump: null,
  });
}

export function buildWorkspaceSetupEnvironment(
  environment: NormalizedAgentEnvironment,
  resolvedSecrets: readonly { name: string; value: string }[],
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of WORKSPACE_SETUP_BASE_ENV_ALLOWLIST) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(environment.vars)) env[name] = value;
  for (const { name, value } of resolvedSecrets) env[name] = value;
  return env;
}

export function workspaceSetupStartedEvent(args: {
  workspaceId: string;
  workspaceKey: string;
  mode: string;
  workspacePath: string;
  setupIdentityHash: string;
  commandCount: number;
}): Json {
  return { ...args };
}

export function workspaceSetupCompletedEvent(args: {
  workspaceId: string;
  workspaceKey: string;
  mode: string;
  workspacePath: string;
  setupIdentityHash: string;
  durationMs: number;
}): Json {
  return { ...args };
}

export function workspaceSetupFailedEvent(args: {
  workspaceId: string;
  workspaceKey: string;
  mode: string;
  workspacePath: string;
  setupIdentityHash: string;
  error: { name: string; message: string };
}): Json {
  return { ...args };
}

function normalizeWorkspaceSetupCommand(
  value: unknown,
  opts: { path: string; capabilities: Capabilities },
): NormalizedWorkspaceSetupCommand {
  const { path, capabilities } = opts;
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "key",
    "command",
    "args",
    "cwd",
    "environment",
    "timeoutMs",
    "maxStdoutBytes",
    "maxStderrBytes",
    "successExitCodes",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
  const key = normalizeSetupCommandKey(raw.key, path);
  const command = normalizeCommandName(raw.command, `${path}.command`);
  const args = normalizeArgs(raw.args, `${path}.args`);
  const cwd = normalizeCommandCwd(raw.cwd ?? ".", `${path}.cwd`);
  const environment = normalizeAgentEnvironment(raw.environment, { path: `${path}.environment` });
  assertEnvironmentSecretsGranted(environment, capabilities, path);
  const timeoutMs = normalizePositiveInteger(
    raw.timeoutMs ?? DEFAULT_WORKSPACE_SETUP_TIMEOUT_MS,
    `${path}.timeoutMs`,
    MAX_WORKSPACE_SETUP_TIMEOUT_MS,
  );
  const maxStdoutBytes = normalizePositiveInteger(
    raw.maxStdoutBytes ?? DEFAULT_WORKSPACE_SETUP_STDOUT_BYTES,
    `${path}.maxStdoutBytes`,
    MAX_WORKSPACE_SETUP_STDOUT_BYTES,
  );
  const maxStderrBytes = normalizePositiveInteger(
    raw.maxStderrBytes ?? DEFAULT_WORKSPACE_SETUP_STDERR_BYTES,
    `${path}.maxStderrBytes`,
    MAX_WORKSPACE_SETUP_STDERR_BYTES,
  );
  const successExitCodes = normalizeSuccessExitCodes(raw.successExitCodes, path);
  const identity: Json = {
    key,
    command,
    args,
    cwd,
    environment: {
      vars: environment.vars,
      secretNames: [...environment.secrets].sort(),
    },
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    successExitCodes,
  };
  return Object.freeze({
    key,
    command,
    args: Object.freeze(args) as string[],
    cwd,
    environment,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    successExitCodes: Object.freeze(successExitCodes) as number[],
    identity,
  });
}

function setupIdentity(fields: {
  workspaceId: string;
  workspaceIdentityHash: string;
  capabilities: Capabilities;
  commands: readonly NormalizedWorkspaceSetupCommand[];
}): Json {
  return {
    workspaceSetupRulesVersion: WORKSPACE_SETUP_RULES_VERSION,
    workflowSdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
    workspaceId: fields.workspaceId,
    workspaceIdentityHash: fields.workspaceIdentityHash,
    capabilities: setupCapabilitiesIdentity(fields.capabilities),
    environmentPolicyVersion: WORKSPACE_SETUP_ENVIRONMENT_POLICY_VERSION,
    baseEnvironmentAllowlistNames: [...WORKSPACE_SETUP_BASE_ENV_ALLOWLIST],
    commands: fields.commands.map((command) => command.identity),
  };
}

function setupCapabilitiesIdentity(capabilities: Capabilities): Json {
  return {
    fs: capabilities.fs,
    shell: capabilities.shell,
    network: capabilities.network === "none" ? "none" : [...capabilities.network],
    secrets: [...capabilities.secrets].sort(),
  };
}

function normalizeSetupCapabilities(value: unknown, path: string): Capabilities {
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
  if (capabilities.shell !== true) {
    throw new Error(`${path}.shell must be true for workspace setup`);
  }
  if (capabilities.fs !== "workspace-write") {
    throw new Error(`${path}.fs must be "workspace-write" for workspace setup`);
  }
  return capabilities;
}

function normalizeSetupCommandKey(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path}.key must be a non-empty string`);
  }
  if (!COMMAND_KEY_RE.test(value)) {
    throw new Error(`${path}.key must match ${COMMAND_KEY_RE.source}`);
  }
  if (value.startsWith(SESSION_STABLE_KEY_PREFIX)) {
    throw new Error(`${path}.key "${value}" uses reserved prefix ${SESSION_STABLE_KEY_PREFIX}`);
  }
  return value;
}

function normalizeCommandName(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function normalizeArgs(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  rejectArrayKeys(value, path);
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!(i in value)) throw new Error(`${path}[${i}] must not be a sparse array hole`);
    const item = value[i];
    if (typeof item !== "string") throw new Error(`${path}[${i}] must be a string`);
    out.push(item);
  }
  return out;
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
