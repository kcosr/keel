import { posix } from "node:path";
import type { Json } from "../hash.ts";
import { WORKFLOW_SDK_ABI_VERSION } from "../workflow-definitions/abi.ts";
import type { BoundedText, WorkspaceHandleLike } from "./command.ts";

export const COMPLETION_CHECK_RUNNER_VERSION = 1;
export const COMPLETION_CHECK_STABLE_KEY_PREFIX = "completion-check.";
export const COMPLETION_CHECK_ENVIRONMENT_POLICY_VERSION = 1;
export const COMPLETION_COMMAND_BASE_ENV_ALLOWLIST = [
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
export const DEFAULT_COMPLETION_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const MAX_COMPLETION_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_COMPLETION_COMMAND_STDOUT_BYTES = 64 * 1024;
export const DEFAULT_COMPLETION_COMMAND_STDERR_BYTES = 64 * 1024;
export const MAX_COMPLETION_COMMAND_OUTPUT_BYTES = 256 * 1024;
export const GIT_COMPLETION_TIMEOUT_MS = 60_000;
export const GIT_COMPLETION_OUTPUT_BYTES = 16 * 1024;
export const COMPLETION_CHECK_PATH_LIMIT = 200;
export const COMPLETION_CHECK_COMMIT_LIMIT = 20;

const CHECK_KEY_RE = /^[A-Za-z0-9_-]+$/;

export type CompletionCheck =
  | CommandCompletionCheck
  | GitCleanCompletionCheck
  | HasCommitsCompletionCheck
  | BranchPushedCompletionCheck;

export interface CommandCompletionCheck {
  key: string;
  type: "command";
  command: string;
  args?: string[];
  shell?: boolean;
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: Record<string, string>;
}

export interface GitCleanCompletionCheck {
  key: string;
  type: "git-clean";
}

export interface HasCommitsCompletionCheck {
  key: string;
  type: "has-commits";
  minCount?: number;
  baseRef?: string;
}

export interface BranchPushedCompletionCheck {
  key: string;
  type: "branch-pushed";
  remote?: string;
  remoteRef?: string;
}

export type NormalizedCompletionCheck =
  | NormalizedCommandCompletionCheck
  | NormalizedGitCleanCompletionCheck
  | NormalizedHasCommitsCompletionCheck
  | NormalizedBranchPushedCompletionCheck;

export interface NormalizedCommandCompletionCheck {
  key: string;
  type: "command";
  command: string;
  args: string[];
  shell: boolean;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  env: Record<string, string>;
}

export interface NormalizedGitCleanCompletionCheck {
  key: string;
  type: "git-clean";
}

export interface NormalizedHasCommitsCompletionCheck {
  key: string;
  type: "has-commits";
  minCount: number;
  baseRef?: string;
}

export interface NormalizedBranchPushedCompletionCheck {
  key: string;
  type: "branch-pushed";
  remote: string;
  remoteRef?: string;
}

export type CompletionCheckFailureAction = "continue-loop" | "park" | "block";
export type CompletionCheckTrigger = "auto" | "pre-park" | "final";
export type CompletionCheckStatus = "passed" | "failed" | "not-run";
export type CompletionCheckFailureKind =
  | "nonzero-exit"
  | "timeout"
  | "spawn-error"
  | "dirty-worktree"
  | "no-commits"
  | "base-not-ancestor"
  | "branch-not-pushed"
  | "branch-mismatch"
  | "workspace-unsupported"
  | "git-error"
  | "invalid-check";

export interface CompletionCheckResult {
  key: string;
  type: NormalizedCompletionCheck["type"];
  status: CompletionCheckStatus;
  durationMs?: number;
  summary: string;
  failureKind?: CompletionCheckFailureKind;
  diagnostics?: Json;
}

export interface CompletionCheckAttempt {
  attempt: number;
  trigger: CompletionCheckTrigger;
  status: "passed" | "failed";
  workspaceId: string;
  workspaceIdentityHash?: string;
  startedAtMs: number;
  finishedAtMs: number;
  checks: CompletionCheckResult[];
}

export interface CompletionCheckEffectSpec {
  key: string;
  workspace: WorkspaceHandleLike;
  attempt: number;
  trigger: CompletionCheckTrigger;
  check: NormalizedCompletionCheck;
  markFailureSeenOnFailure: boolean;
}

export interface NormalizedCompletionCheckEffectSpec {
  key: string;
  stableKey: string;
  workspaceId: string;
  workspaceIdentityHash: string | null;
  attempt: number;
  trigger: CompletionCheckTrigger;
  check: NormalizedCompletionCheck;
  markFailureSeenOnFailure: boolean;
  identity: Json;
}

export function normalizeCompletionChecks(
  value: unknown,
  opts: {
    path?: string;
    workspaceMode?: "direct" | "worktree" | "any";
  } = {},
): NormalizedCompletionCheck[] {
  const path = opts.path ?? "completionChecks";
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  rejectArrayKeys(value, path);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const check = normalizeCompletionCheck(item, `${path}[${index}]`);
    if (seen.has(check.key)) throw new Error(`${path} contains duplicate key "${check.key}"`);
    seen.add(check.key);
    if (opts.workspaceMode === "direct" && check.type === "has-commits" && !check.baseRef) {
      throw new Error(`${path}[${index}].baseRef is required for direct has-commits checks`);
    }
    if (opts.workspaceMode === "worktree" && check.type === "has-commits" && check.baseRef) {
      throw new Error(`${path}[${index}].baseRef is not supported for worktree has-commits checks`);
    }
    return check;
  });
}

export function normalizeCompletionCheckFailureAction(
  value: unknown,
  completionMode: "auto" | "park-before-complete" | undefined,
  path = "completionCheckFailureAction",
): CompletionCheckFailureAction {
  const action =
    value === undefined
      ? "continue-loop"
      : value === "continue-loop" || value === "park" || value === "block"
        ? value
        : (() => {
            throw new Error(`${path} must be "continue-loop", "park", or "block"`);
          })();
  if (action === "park" && completionMode !== "park-before-complete") {
    throw new Error(`${path}: "park" requires completionMode "park-before-complete"`);
  }
  return action;
}

export function completionCheckStableKey(attempt: number, checkKey: string): string {
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new Error("completion check attempt must be a positive integer");
  }
  if (!CHECK_KEY_RE.test(checkKey)) {
    throw new Error(`completion check key "${checkKey}" must match ${CHECK_KEY_RE.source}`);
  }
  return `${COMPLETION_CHECK_STABLE_KEY_PREFIX}${attempt}.${checkKey}`;
}

export function normalizeCompletionCheckEffectSpec(
  value: unknown,
  opts: { path?: string } = {},
): NormalizedCompletionCheckEffectSpec {
  const path = opts.path ?? "ctx.completionCheck";
  if (!isPlainObject(value)) throw new Error(`${path} spec must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  const raw = value as Record<string, unknown>;
  const allowed = new Set([
    "key",
    "workspace",
    "attempt",
    "trigger",
    "check",
    "markFailureSeenOnFailure",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
  const workspace = normalizeWorkspaceHandle(raw.workspace, `${path}.workspace`);
  const attempt = normalizePositiveInteger(raw.attempt, `${path}.attempt`);
  const trigger = normalizeTrigger(raw.trigger, `${path}.trigger`);
  const check = normalizeCompletionCheck(raw.check, `${path}.check`);
  const stableKey = completionCheckStableKey(attempt, check.key);
  if (raw.key !== stableKey) {
    throw new Error(`${path}.key must be "${stableKey}" for attempt ${attempt} check ${check.key}`);
  }
  if (typeof raw.markFailureSeenOnFailure !== "boolean") {
    throw new Error(`${path}.markFailureSeenOnFailure must be a boolean`);
  }
  const identity = completionCheckIdentity({
    key: stableKey,
    workspaceId: workspace.id,
    workspaceIdentityHash: workspace.identityHash ?? null,
    attempt,
    trigger,
    check,
    markFailureSeenOnFailure: raw.markFailureSeenOnFailure,
  });
  return Object.freeze({
    key: stableKey,
    stableKey,
    workspaceId: workspace.id,
    workspaceIdentityHash: workspace.identityHash ?? null,
    attempt,
    trigger,
    check,
    markFailureSeenOnFailure: raw.markFailureSeenOnFailure,
    identity,
  });
}

export function completionCheckPromptSummary(checks: readonly NormalizedCompletionCheck[]): string {
  if (checks.length === 0) return "";
  const lines = ["Completion checks Keel will enforce after a clean review:"];
  for (const check of checks) lines.push(`- ${completionCheckPromptLine(check)}`);
  if (
    checks.some((check) => check.type === "has-commits") &&
    checks.some((check) => check.type === "git-clean")
  ) {
    lines.push("- Final state must be committed and clean.");
  }
  if (checks.some((check) => check.type === "branch-pushed")) {
    lines.push("- Keel will not push for you; push the branch before completion.");
  }
  return `${lines.join("\n")}\n`;
}

export function completionCheckStartedEvent(spec: NormalizedCompletionCheckEffectSpec): Json {
  return {
    attempt: spec.attempt,
    trigger: spec.trigger,
    key: spec.check.key,
    type: spec.check.type,
    workspaceId: spec.workspaceId,
    ...(spec.workspaceIdentityHash ? { workspaceIdentityHash: spec.workspaceIdentityHash } : {}),
  } satisfies Json;
}

export function completionCheckCompletedEvent(
  spec: NormalizedCompletionCheckEffectSpec,
  result: CompletionCheckResult,
): Json {
  return {
    attempt: spec.attempt,
    trigger: spec.trigger,
    key: result.key,
    type: result.type,
    workspaceId: spec.workspaceId,
    ...(spec.workspaceIdentityHash ? { workspaceIdentityHash: spec.workspaceIdentityHash } : {}),
    status: result.status,
    durationMs: result.durationMs ?? null,
    summary: result.summary,
    ...(result.failureKind ? { failureKind: result.failureKind } : {}),
    ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
  } satisfies Json;
}

export function outputTextSummary(text: BoundedText): Json {
  return {
    text: text.text,
    byteLength: text.byteLength,
    truncated: text.truncated,
    omittedBytes: text.omittedBytes,
  } satisfies Json;
}

function completionCheckIdentity(fields: {
  key: string;
  workspaceId: string;
  workspaceIdentityHash: string | null;
  attempt: number;
  trigger: CompletionCheckTrigger;
  check: NormalizedCompletionCheck;
  markFailureSeenOnFailure: boolean;
}): Json {
  return {
    completionCheckRunnerVersion: COMPLETION_CHECK_RUNNER_VERSION,
    workflowSdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
    key: fields.key,
    workspaceId: fields.workspaceId,
    ...(fields.workspaceIdentityHash
      ? { workspaceIdentityHash: fields.workspaceIdentityHash }
      : {}),
    attempt: fields.attempt,
    trigger: fields.trigger,
    check: fields.check as unknown as Json,
    markFailureSeenOnFailure: fields.markFailureSeenOnFailure,
    commandDefaults: {
      environmentPolicyVersion: COMPLETION_CHECK_ENVIRONMENT_POLICY_VERSION,
      baseEnvironmentAllowlistNames: [...COMPLETION_COMMAND_BASE_ENV_ALLOWLIST],
      defaultTimeoutMs: DEFAULT_COMPLETION_COMMAND_TIMEOUT_MS,
      maxTimeoutMs: MAX_COMPLETION_COMMAND_TIMEOUT_MS,
      defaultStdoutBytes: DEFAULT_COMPLETION_COMMAND_STDOUT_BYTES,
      defaultStderrBytes: DEFAULT_COMPLETION_COMMAND_STDERR_BYTES,
      maxOutputBytes: MAX_COMPLETION_COMMAND_OUTPUT_BYTES,
    },
    gitDefaults: {
      timeoutMs: GIT_COMPLETION_TIMEOUT_MS,
      outputBytes: GIT_COMPLETION_OUTPUT_BYTES,
      pathLimit: COMPLETION_CHECK_PATH_LIMIT,
      commitLimit: COMPLETION_CHECK_COMMIT_LIMIT,
    },
  } satisfies Json;
}

function completionCheckPromptLine(check: NormalizedCompletionCheck): string {
  if (check.type === "command") {
    const command = check.shell
      ? `shell: ${check.command}`
      : `argv: ${[check.command, ...check.args].map(shellWord).join(" ")}`;
    const cwd = check.cwd === "." ? "" : ` cwd=${check.cwd}`;
    return `${check.key} command ${command}${cwd} timeout=${formatDuration(check.timeoutMs)}.`;
  }
  if (check.type === "git-clean") {
    return `${check.key} git-clean: leave no staged, unstaged, deleted, or untracked files.`;
  }
  if (check.type === "has-commits") {
    return `${check.key} has-commits: commit completed work; requires at least ${check.minCount} commit${check.minCount === 1 ? "" : "s"}.`;
  }
  const remoteRef = check.remoteRef ? ` ${check.remoteRef}` : " the matching remote branch";
  return `${check.key} branch-pushed: push current branch to ${check.remote}${remoteRef}; remote ref SHA must equal local HEAD.`;
}

function normalizeCompletionCheck(value: unknown, path: string): NormalizedCompletionCheck {
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  const raw = value as Record<string, unknown>;
  const key = normalizeCheckKey(raw.key, `${path}.key`);
  const type = raw.type;
  if (type === "command") return normalizeCommandCheck(raw, path, key);
  if (type === "git-clean") {
    rejectUnsupportedKeys(raw, path, ["key", "type"]);
    return Object.freeze({ key, type });
  }
  if (type === "has-commits") return normalizeHasCommitsCheck(raw, path, key);
  if (type === "branch-pushed") return normalizeBranchPushedCheck(raw, path, key);
  throw new Error(`${path}.type must be "command", "git-clean", "has-commits", or "branch-pushed"`);
}

function normalizeCommandCheck(
  raw: Record<string, unknown>,
  path: string,
  key: string,
): NormalizedCommandCompletionCheck {
  rejectUnsupportedKeys(raw, path, [
    "key",
    "type",
    "command",
    "args",
    "shell",
    "cwd",
    "timeoutMs",
    "maxStdoutBytes",
    "maxStderrBytes",
    "env",
  ]);
  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    throw new Error(`${path}.command must be a non-empty string`);
  }
  const shell = raw.shell === undefined ? false : normalizeBoolean(raw.shell, `${path}.shell`);
  if (shell && raw.args !== undefined)
    throw new Error(`${path}.args is not supported with shell: true`);
  const args = raw.args === undefined ? [] : normalizeStringArray(raw.args, `${path}.args`);
  const cwd = raw.cwd === undefined ? "." : normalizeRelativeCwd(raw.cwd, `${path}.cwd`);
  const timeoutMs =
    raw.timeoutMs === undefined
      ? DEFAULT_COMPLETION_COMMAND_TIMEOUT_MS
      : normalizePositiveInteger(
          raw.timeoutMs,
          `${path}.timeoutMs`,
          MAX_COMPLETION_COMMAND_TIMEOUT_MS,
        );
  const maxStdoutBytes =
    raw.maxStdoutBytes === undefined
      ? DEFAULT_COMPLETION_COMMAND_STDOUT_BYTES
      : normalizePositiveInteger(
          raw.maxStdoutBytes,
          `${path}.maxStdoutBytes`,
          MAX_COMPLETION_COMMAND_OUTPUT_BYTES,
        );
  const maxStderrBytes =
    raw.maxStderrBytes === undefined
      ? DEFAULT_COMPLETION_COMMAND_STDERR_BYTES
      : normalizePositiveInteger(
          raw.maxStderrBytes,
          `${path}.maxStderrBytes`,
          MAX_COMPLETION_COMMAND_OUTPUT_BYTES,
        );
  const env = raw.env === undefined ? {} : normalizeStringRecord(raw.env, `${path}.env`);
  return Object.freeze({
    key,
    type: "command",
    command: raw.command.trim(),
    args: Object.freeze([...args]) as string[],
    shell,
    cwd,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    env: Object.freeze(env),
  });
}

function normalizeHasCommitsCheck(
  raw: Record<string, unknown>,
  path: string,
  key: string,
): NormalizedHasCommitsCompletionCheck {
  rejectUnsupportedKeys(raw, path, ["key", "type", "minCount", "baseRef"]);
  const minCount =
    raw.minCount === undefined ? 1 : normalizePositiveInteger(raw.minCount, `${path}.minCount`);
  if (raw.baseRef !== undefined && typeof raw.baseRef !== "string") {
    throw new Error(`${path}.baseRef must be a string`);
  }
  if (raw.baseRef === "") throw new Error(`${path}.baseRef must not be empty`);
  return Object.freeze({
    key,
    type: "has-commits",
    minCount,
    ...(raw.baseRef !== undefined ? { baseRef: raw.baseRef } : {}),
  });
}

function normalizeBranchPushedCheck(
  raw: Record<string, unknown>,
  path: string,
  key: string,
): NormalizedBranchPushedCompletionCheck {
  rejectUnsupportedKeys(raw, path, ["key", "type", "remote", "remoteRef"]);
  const remote =
    raw.remote === undefined ? "origin" : normalizeNonEmptyString(raw.remote, `${path}.remote`);
  if (raw.remoteRef !== undefined) {
    const remoteRef = normalizeNonEmptyString(raw.remoteRef, `${path}.remoteRef`);
    if (!remoteRef.startsWith("refs/")) {
      throw new Error(`${path}.remoteRef must be a fully qualified ref starting with refs/`);
    }
    return Object.freeze({ key, type: "branch-pushed", remote, remoteRef });
  }
  return Object.freeze({ key, type: "branch-pushed", remote });
}

function normalizeWorkspaceHandle(value: unknown, path: string): WorkspaceHandleLike {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must be a WorkspaceHandle produced by ctx.workspace`);
  }
  rejectSymbolOrNonEnumerableKeys(value, path);
  for (const key of Object.keys(value)) {
    if (key !== "id" && key !== "identityHash") throw new Error(`${path}.${key} is not supported`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error(`${path}.id must be a non-empty string`);
  }
  if (raw.identityHash !== undefined && typeof raw.identityHash !== "string") {
    throw new Error(`${path}.identityHash must be a string`);
  }
  return {
    id: raw.id,
    ...(raw.identityHash !== undefined ? { identityHash: raw.identityHash } : {}),
  };
}

function normalizeCheckKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !CHECK_KEY_RE.test(value)) {
    throw new Error(`${path} must match ${CHECK_KEY_RE.source}`);
  }
  return value;
}

function normalizeTrigger(value: unknown, path: string): CompletionCheckTrigger {
  if (value === "auto" || value === "pre-park" || value === "final") return value;
  throw new Error(`${path} must be "auto", "pre-park", or "final"`);
}

function normalizeRelativeCwd(value: unknown, path: string): string {
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

function normalizeBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function normalizeStringArray(value: unknown, path: string): string[] {
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

function normalizeStringRecord(value: unknown, path: string): Record<string, string> {
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`${path}.${key} must be a string`);
    out[key] = item;
  }
  return out;
}

function normalizeNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function normalizePositiveInteger(value: unknown, path: string, max?: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  if (max !== undefined && value > max) throw new Error(`${path} must be <= ${max}`);
  return value;
}

function rejectUnsupportedKeys(
  raw: Record<string, unknown>,
  path: string,
  allowed: string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
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

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}
