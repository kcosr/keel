import type { Json } from "../hash.ts";
import type { ProviderConfigMap, ProviderConfigValue } from "./types.ts";

export class ProviderConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigValidationError";
  }
}

type PathSegment = string | number;

interface NormalizeArgs {
  context: string;
  selectedProvider: string;
  explicitProviderConfig?: ProviderConfigMap;
  profileName?: string;
  profileProviderConfig?: ProviderConfigMap;
}

export function resolveSelectedProviderConfig({
  context,
  selectedProvider,
  explicitProviderConfig,
  profileName,
  profileProviderConfig,
}: NormalizeArgs): Readonly<ProviderConfigValue> | undefined {
  const explicit = normalizeProviderConfigMap(context, explicitProviderConfig);
  const profile = normalizeProviderConfigMap(
    profileName ? `agent profile "${profileName}"` : context,
    profileProviderConfig,
  );
  if (explicit && hasOwn(explicit, selectedProvider)) return explicit[selectedProvider];
  if (profile && hasOwn(profile, selectedProvider)) return profile[selectedProvider];
  return undefined;
}

export function normalizeProviderConfigMap(
  context: string,
  providerConfig: ProviderConfigMap | undefined,
): Readonly<ProviderConfigMap> | undefined {
  if (providerConfig === undefined) return undefined;
  if (!isPlainObject(providerConfig)) {
    throw invalid(`${context} providerConfig must be a plain object map`);
  }
  rejectSymbolOrNonEnumerableKeys(context, providerConfig, ["providerConfig"]);
  const normalized: Record<string, ProviderConfigValue> = {};
  for (const provider of Object.keys(providerConfig)) {
    if (provider.length === 0) {
      throw invalid(`${context} providerConfig provider name must be a non-empty string`);
    }
    normalized[provider] = normalizeProviderConfigValueAt(context, providerConfig[provider], [
      "providerConfig",
      provider,
    ]);
  }
  return Object.freeze(normalized) as Readonly<ProviderConfigMap>;
}

export function normalizeProviderConfigValue(
  context: string,
  value: ProviderConfigValue,
): Readonly<ProviderConfigValue> {
  return normalizeProviderConfigValueAt(context, value, ["providerConfig"]);
}

function normalizeProviderConfigValueAt(
  context: string,
  value: unknown,
  path: PathSegment[],
): Readonly<ProviderConfigValue> {
  if (!isPlainObject(value)) {
    throw invalid(`${context} ${formatPath(path)} must be a plain JSON object`);
  }
  return normalizeJsonObject(
    context,
    value,
    path,
    new WeakSet<object>(),
  ) as Readonly<ProviderConfigValue>;
}

function normalizeJsonValue(
  context: string,
  value: unknown,
  path: PathSegment[],
  active: WeakSet<object>,
): Json {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw invalid(
          `${context} ${formatPath(path)} must be JSON-serializable (non-finite number)`,
        );
      }
      return value === 0 ? 0 : value;
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw invalid(
        `${context} ${formatPath(path)} must be JSON-serializable (got ${typeof value})`,
      );
    case "object":
      if (Array.isArray(value)) return normalizeJsonArray(context, value, path, active);
      if (!isPlainObject(value)) {
        throw invalid(
          `${context} ${formatPath(path)} must be a plain JSON object (got ${describe(value)})`,
        );
      }
      return normalizeJsonObject(context, value, path, active);
  }
  throw invalid(`${context} ${formatPath(path)} must be JSON-serializable`);
}

function normalizeJsonArray(
  context: string,
  value: unknown[],
  path: PathSegment[],
  active: WeakSet<object>,
): Json[] {
  if (active.has(value)) {
    throw invalid(`${context} ${formatPath(path)} must be JSON-serializable (cycle detected)`);
  }
  active.add(value);
  try {
    const out: Json[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw invalid(
          `${context} ${formatPath([...path, i])} must be JSON-serializable (sparse array hole)`,
        );
      }
      out.push(normalizeJsonValue(context, value[i], [...path, i], active));
    }
    return Object.freeze(out) as Json[];
  } finally {
    active.delete(value);
  }
}

function normalizeJsonObject(
  context: string,
  value: object,
  path: PathSegment[],
  active: WeakSet<object>,
): { [key: string]: Json } {
  if (active.has(value)) {
    throw invalid(`${context} ${formatPath(path)} must be JSON-serializable (cycle detected)`);
  }
  active.add(value);
  try {
    rejectSymbolOrNonEnumerableKeys(context, value, path);
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value)) {
      out[key] = normalizeJsonValue(
        context,
        (value as Record<string, unknown>)[key],
        [...path, key],
        active,
      );
    }
    return Object.freeze(out);
  } finally {
    active.delete(value);
  }
}

function rejectSymbolOrNonEnumerableKeys(
  context: string,
  value: object,
  path: PathSegment[],
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw invalid(`${context} ${formatPath(path)} must be JSON-serializable (symbol key)`);
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc?.enumerable) {
      throw invalid(
        `${context} ${formatPath([...path, key])} must be JSON-serializable (non-enumerable property)`,
      );
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function formatPath(path: PathSegment[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (out.length === 0) {
      out = segment;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      out += `.${segment}`;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out;
}

function describe(value: object): string {
  return (value as { constructor?: { name?: string } }).constructor?.name ?? "object";
}

function invalid(message: string): ProviderConfigValidationError {
  return new ProviderConfigValidationError(message);
}
