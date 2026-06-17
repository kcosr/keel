import { type Json, canonicalJson, sha256Hex } from "../hash.ts";
import {
  type ToolPolicy,
  codexSandboxForCapabilities,
  normalizeProviderToolList,
  rejectArrayNonJsonKeys,
  resolveToolPolicy,
  validateCapabilitiesDeclaration,
} from "./capabilities.ts";
import { normalizeCodexProviderConfig } from "./codex.ts";
import { normalizeProviderConfigMap, normalizeProviderConfigValue } from "./provider-config.ts";
import type { AgentProviderRegistry, ProviderConfigMap } from "./types.ts";

// Named agent profiles — daemon/kernel-configured presets
// (e.g. reviewer / verifier / synthesizer) so workflows don't repeat
// provider/model/toolPolicy/reasoning on every ctx.agent call.
//
// CRITICAL identity rule: a profile is resolved to its concrete fields BEFORE the
// version is computed, and those RESOLVED fields (not the profile name) enter the
// version + input hash. Durable daemon runs receive a frozen run profile snapshot;
// both resolveProfile and providerConfig lookup must use that same object.

export interface AgentProfile {
  provider?: string;
  model?: string;
  reasoning?: string;
  toolPolicy?: ToolPolicy;
  allowTools?: string[];
  denyTools?: string[];
  capabilities?: Record<string, unknown>;
  maxRetries?: number;
  lenient?: boolean;
  onFailure?: "throw" | "null";
  timeoutMs?: number;
  stallRetries?: number;
  providerConfig?: ProviderConfigMap;
}

export type AgentProfiles = Record<string, AgentProfile>;
export type AgentProfileSource = "catalog" | "programmatic";

export type PersistentAgentProfileConfig = AgentProfile;

export interface AgentProfileView {
  name: string;
  source: AgentProfileSource;
  config: PersistentAgentProfileConfig;
  configHash: string;
  generation: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

export interface AgentProfileSnapshotEntry {
  name: string;
  source: AgentProfileSource;
  config: PersistentAgentProfileConfig;
  configHash: string;
  catalogGeneration: number | null;
}

export interface AgentProfileDiagnostic {
  level: "error" | "warning" | "info";
  path: string;
  message: string;
}

export interface AgentProfileCheckResult {
  ok: boolean;
  diagnostics: AgentProfileDiagnostic[];
}

export const AGENT_PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const AGENT_PROFILE_NAME_MAX_BYTES = 128;

const ALLOWED_PROFILE_KEYS = [
  "provider",
  "model",
  "reasoning",
  "toolPolicy",
  "allowTools",
  "denyTools",
  "capabilities",
  "maxRetries",
  "lenient",
  "onFailure",
  "timeoutMs",
  "stallRetries",
  "providerConfig",
] as const;
const ALLOWED_PROFILE_KEY_SET = new Set<string>(ALLOWED_PROFILE_KEYS);

export const FORBIDDEN_PERSISTENT_AGENT_PROFILE_FIELDS = [
  "key",
  "prompt",
  "profile",
  "schema",
  "workspace",
  "workspaceIsolation",
  "workspaceRetention",
  "target",
  "secrets",
  "bump",
  "version",
] as const;

/** The fields a ctx.agent spec may inherit from a profile (explicit fields win). */
const INHERITED = [
  "provider",
  "model",
  "reasoning",
  "toolPolicy",
  "allowTools",
  "denyTools",
  "capabilities",
  "maxRetries",
  "lenient",
  "onFailure",
  "timeoutMs",
  "stallRetries",
] as const;

const REMOVED_WORKSPACE_FIELDS = ["workspaceIsolation", "workspaceRetention", "target"] as const;
const TOOL_POLICIES = new Set<ToolPolicy>(["none", "read-only", "workspace-write", "unrestricted"]);
const ON_FAILURE = new Set(["throw", "null"]);

/**
 * Merge a named profile UNDER an explicit spec: explicit fields always win, a
 * field absent from the spec inherits the profile's value. Returns a new spec
 * object with `profile` removed and the resolved fields applied. Throws if the
 * spec names a profile that is not configured (fail loud, don't silently ignore).
 */
export function resolveProfile<T extends { profile?: string }>(
  spec: T,
  profiles: AgentProfiles | undefined,
): Omit<T, "profile"> {
  const { profile, ...rest } = spec as T & Record<string, unknown>;
  if (!profile) return rest as Omit<T, "profile">;
  const preset = profiles?.[profile];
  if (!preset) {
    throw new Error(`unknown agent profile "${profile}" (configure it on the daemon/kernel)`);
  }
  const rawPreset = preset as Record<string, unknown>;
  for (const field of REMOVED_WORKSPACE_FIELDS) {
    if (rawPreset[field] !== undefined) {
      throw new Error(
        `agent profile "${profile}" no longer accepts ${field}; use ctx.workspace or ctx.withWorkspace`,
      );
    }
  }
  const merged = { ...rest } as Record<string, unknown>;
  for (const key of INHERITED) {
    if (merged[key] === undefined && preset[key] !== undefined) merged[key] = preset[key];
  }
  return merged as Omit<T, "profile">;
}

export function assertValidAgentProfileName(name: string): void {
  if (
    typeof name !== "string" ||
    !AGENT_PROFILE_NAME_PATTERN.test(name) ||
    Buffer.byteLength(name, "utf8") > AGENT_PROFILE_NAME_MAX_BYTES ||
    name === "." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error(`invalid agent profile name "${String(name)}"`);
  }
}

export function normalizeAgentProfileConfig(
  config: unknown,
  opts: {
    path?: string;
    providerRegistry?: AgentProviderRegistry;
    requireRegisteredProvider?: boolean;
  } = {},
): PersistentAgentProfileConfig {
  const path = opts.path ?? "profile";
  if (!isPlainObject(config)) throw new Error(`${path} must be a plain JSON object`);
  rejectSymbolOrNonEnumerableKeys(config, path);
  const raw = config as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (ALLOWED_PROFILE_KEY_SET.has(key)) continue;
    if ((FORBIDDEN_PERSISTENT_AGENT_PROFILE_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`${path}.${key} is not allowed in persistent agent profiles`);
    }
    throw new Error(`${path}.${key} is not a supported agent profile field`);
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    switch (key) {
      case "provider":
      case "model":
      case "reasoning":
        if (typeof value !== "string" || value.length === 0) {
          throw new Error(`${path}.${key} must be a non-empty string`);
        }
        out[key] = value;
        break;
      case "toolPolicy":
        if (typeof value !== "string" || !TOOL_POLICIES.has(value as ToolPolicy)) {
          throw new Error(
            `${path}.toolPolicy must be none, read-only, workspace-write, or unrestricted`,
          );
        }
        out.toolPolicy = value;
        break;
      case "allowTools":
      case "denyTools":
        out[key] = normalizeProviderToolList(value, `${path}.${key}`);
        break;
      case "capabilities":
        if (!isPlainObject(value))
          throw new Error(`${path}.capabilities must be a plain JSON object`);
        out.capabilities = validateCapabilitiesDeclaration(
          normalizeJsonObject(value, `${path}.capabilities`) as Record<string, Json>,
          `${path}.capabilities`,
        );
        break;
      case "maxRetries":
      case "stallRetries":
        if (!Number.isSafeInteger(value) || (value as number) < 0) {
          throw new Error(`${path}.${key} must be a safe integer >= 0`);
        }
        out[key] = value;
        break;
      case "timeoutMs":
        if (!Number.isSafeInteger(value) || (value as number) <= 0) {
          throw new Error(`${path}.timeoutMs must be a safe integer > 0`);
        }
        out.timeoutMs = value;
        break;
      case "lenient":
        if (typeof value !== "boolean") throw new Error(`${path}.lenient must be a boolean`);
        out.lenient = value;
        break;
      case "onFailure":
        if (typeof value !== "string" || !ON_FAILURE.has(value)) {
          throw new Error(`${path}.onFailure must be throw or null`);
        }
        out.onFailure = value;
        break;
      case "providerConfig":
        out.providerConfig = normalizeProviderConfigMap(path, value as ProviderConfigMap);
        break;
    }
  }

  resolveToolPolicy({
    ...(out.capabilities ? { capabilities: out.capabilities as Record<string, unknown> } : {}),
    ...(out.toolPolicy ? { toolPolicy: out.toolPolicy as ToolPolicy } : {}),
    ...(out.allowTools ? { allowTools: out.allowTools as string[] } : {}),
    ...(out.denyTools ? { denyTools: out.denyTools as string[] } : {}),
  });

  const provider = out.provider as string | undefined;
  const registry = opts.providerRegistry;
  if (provider && opts.requireRegisteredProvider && !registry?.has(provider)) {
    throw new Error(`provider "${provider}" is not registered`);
  }
  const providerConfig = out.providerConfig as ProviderConfigMap | undefined;
  if (provider && providerConfig?.[provider] !== undefined && registry?.has(provider)) {
    normalizeSelectedProviderConfig(provider, providerConfig[provider]);
  }

  // Re-canonicalize through JSON to drop object identities and freeze a deterministic shape.
  return JSON.parse(canonicalJson(out)) as PersistentAgentProfileConfig;
}

export function agentProfileConfigHash(config: PersistentAgentProfileConfig): string {
  return sha256Hex(canonicalJson(config));
}

export function effectiveProfileCatalogHash(entries: AgentProfileSnapshotEntry[]): string {
  return sha256Hex(
    canonicalJson(
      entries
        .map((entry) => ({
          name: entry.name,
          source: entry.source,
          configHash: entry.configHash,
          catalogGeneration: entry.catalogGeneration,
        }))
        .sort((a, b) => compareAgentProfileNames(a.name, b.name)),
    ),
  );
}

export function compareAgentProfileNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function agentProfilesFromSnapshot(entries: AgentProfileSnapshotEntry[]): AgentProfiles {
  const out: AgentProfiles = {};
  for (const entry of entries) out[entry.name] = entry.config;
  return Object.freeze(out);
}

export function checkAgentProfileConfig(
  config: unknown,
  opts: { path?: string; providerRegistry?: AgentProviderRegistry; connect?: boolean } = {},
): AgentProfileCheckResult {
  const path = opts.path ?? "profile";
  const diagnostics: AgentProfileDiagnostic[] = [];
  try {
    const normalized = normalizeAgentProfileConfig(config, {
      path,
      providerRegistry: opts.providerRegistry,
      requireRegisteredProvider: true,
    });
    if (normalized.provider) assertProviderSupportsProfile(normalized.provider, normalized, path);
    if (opts.connect) {
      diagnostics.push({
        level: "warning",
        path,
        message: "connection checks are not implemented; performed local validation only",
      });
    }
  } catch (err) {
    diagnostics.push({
      level: "error",
      path,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return { ok: diagnostics.every((d) => d.level !== "error"), diagnostics };
}

export function normalizeProgrammaticAgentProfiles(
  profiles: Record<string, unknown> | undefined,
  providerRegistry?: AgentProviderRegistry,
): AgentProfiles {
  const normalized: AgentProfiles = {};
  for (const [name, config] of Object.entries(profiles ?? {})) {
    assertValidAgentProfileName(name);
    normalized[name] = normalizeAgentProfileConfig(config, {
      path: `profile.${name}`,
      providerRegistry,
    });
  }
  return Object.freeze(normalized);
}

function assertProviderSupportsProfile(
  provider: string,
  config: PersistentAgentProfileConfig,
  path: string,
): void {
  if (provider !== "codex") return;
  const tools = resolveToolPolicy({
    ...(config.capabilities ? { capabilities: config.capabilities } : {}),
    ...(config.toolPolicy ? { toolPolicy: config.toolPolicy } : {}),
    ...(config.allowTools ? { allowTools: config.allowTools } : {}),
    ...(config.denyTools ? { denyTools: config.denyTools } : {}),
  });
  if (tools.allowTools.length > 0 || tools.denyTools.length > 0) {
    throw new Error(`${path} provider "codex" does not support allowTools or denyTools`);
  }
  try {
    codexSandboxForCapabilities(tools.capabilities);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${path} provider "codex": ${message}`);
  }
}

function normalizeSelectedProviderConfig(provider: string, value: unknown): void {
  if (provider === "codex") {
    normalizeCodexProviderConfig(
      normalizeProviderConfigValue("providerConfig.codex", value as never),
    );
  }
}

function normalizeJsonObject(value: unknown, path: string): Json {
  return normalizeJsonValue(value, path, new WeakSet<object>());
}

function normalizeJsonValue(value: unknown, path: string, active: WeakSet<object>): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be JSON-serializable`);
    return value === 0 ? 0 : value;
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new Error(`${path} must be JSON-serializable (got ${typeof value})`);
  }
  if (Array.isArray(value)) {
    if (active.has(value)) throw new Error(`${path} must be JSON-serializable (cycle detected)`);
    rejectArrayNonJsonKeys(value, path);
    active.add(value);
    try {
      const out: Json[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new Error(`${path}[${i}] must not be a sparse array hole`);
        out.push(normalizeJsonValue(value[i], `${path}[${i}]`, active));
      }
      return out;
    } finally {
      active.delete(value);
    }
  }
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain JSON object`);
  if (active.has(value)) throw new Error(`${path} must be JSON-serializable (cycle detected)`);
  active.add(value);
  try {
    rejectSymbolOrNonEnumerableKeys(value, path);
    const out: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalizeJsonValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        active,
      );
    }
    return out;
  } finally {
    active.delete(value);
  }
}

function rejectSymbolOrNonEnumerableKeys(value: object, path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`${path} must be JSON-serializable (symbol key)`);
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc?.enumerable)
      throw new Error(`${path}.${String(key)} must be JSON-serializable (non-enumerable property)`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
