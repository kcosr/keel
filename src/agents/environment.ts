import type { Capabilities } from "./capabilities.ts";

export interface AgentEnvironmentSpec {
  vars?: Record<string, string>;
  secrets?: string[];
}

export interface NormalizedAgentEnvironment {
  vars: Readonly<Record<string, string>>;
  secrets: readonly string[];
}

export const EMPTY_AGENT_ENVIRONMENT: NormalizedAgentEnvironment = Object.freeze({
  vars: Object.freeze({}),
  secrets: Object.freeze([]),
});

const ENVIRONMENT_KEYS = new Set(["vars", "secrets"]);
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEEL_ENV_PREFIX = "KEEL_";
const RESERVED_ENVIRONMENT_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function normalizeAgentEnvironment(
  value: unknown,
  opts: { path?: string } = {},
): NormalizedAgentEnvironment {
  const path = opts.path ?? "environment";
  if (value === undefined) return EMPTY_AGENT_ENVIRONMENT;
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  for (const key of Object.keys(value)) {
    if (!ENVIRONMENT_KEYS.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
  const raw = value as Record<string, unknown>;
  const vars = normalizeEnvironmentVars(raw.vars, `${path}.vars`);
  const secrets = normalizeEnvironmentSecretNames(raw.secrets, `${path}.secrets`);
  for (const name of secrets) {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`${path} cannot define ${name} in both vars and secrets`);
    }
  }
  if (Object.keys(vars).length === 0 && secrets.length === 0) return EMPTY_AGENT_ENVIRONMENT;
  return Object.freeze({
    vars: Object.freeze(vars),
    secrets: Object.freeze(secrets),
  });
}

export function normalizeRunSecrets(
  value: unknown,
  opts: { path?: string } = {},
): Record<string, string> {
  const path = opts.path ?? "runSecrets";
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  const out: Record<string, string> = {};
  for (const name of Object.keys(value).sort()) {
    validateEnvironmentName(name, `${path}.${name}`);
    const secret = (value as Record<string, unknown>)[name];
    if (typeof secret !== "string") throw new Error(`${path}.${name} must be a string`);
    out[name] = secret;
  }
  return out;
}

export function assertEnvironmentSecretsGranted(
  environment: NormalizedAgentEnvironment,
  capabilities: Capabilities,
  path: string,
): void {
  const allowed = new Set(capabilities.secrets);
  for (const name of environment.secrets) {
    if (!allowed.has(name)) {
      throw new Error(
        `${path}.environment.secrets includes ${name}, but ${path}.capabilities.secrets does not grant it`,
      );
    }
  }
}

export function hasAgentEnvironment(environment: NormalizedAgentEnvironment): boolean {
  return Object.keys(environment.vars).length > 0 || environment.secrets.length > 0;
}

export function validateEnvironmentName(name: string, path: string): void {
  if (typeof name !== "string" || !ENVIRONMENT_NAME_PATTERN.test(name)) {
    throw new Error(`${path} must match ${ENVIRONMENT_NAME_PATTERN}`);
  }
  if (name.startsWith(KEEL_ENV_PREFIX)) {
    throw new Error(`${path} must not start with ${KEEL_ENV_PREFIX}`);
  }
  if (RESERVED_ENVIRONMENT_NAMES.has(name)) {
    throw new Error(`${path} is reserved`);
  }
}

function normalizeEnvironmentVars(value: unknown, path: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain object`);
  rejectSymbolOrNonEnumerableKeys(value, path);
  const out: Record<string, string> = {};
  for (const name of Object.keys(value).sort()) {
    validateEnvironmentName(name, `${path}.${name}`);
    const envValue = (value as Record<string, unknown>)[name];
    if (typeof envValue !== "string") throw new Error(`${path}.${name} must be a string`);
    out[name] = envValue;
  }
  return out;
}

function normalizeEnvironmentSecretNames(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  rejectArrayKeys(value, path);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!(i in value)) throw new Error(`${path}[${i}] must not be a sparse array hole`);
    const name = value[i];
    if (typeof name !== "string") throw new Error(`${path}[${i}] must be a string`);
    validateEnvironmentName(name, `${path}[${i}]`);
    if (seen.has(name)) throw new Error(`${path} must not contain duplicate ${name}`);
    seen.add(name);
    out.push(name);
  }
  return out.sort();
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
