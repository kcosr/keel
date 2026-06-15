import { CODEX_CONNECT_TIMEOUT_MS, CODEX_RPC_RESPONSE_TIMEOUT_MS } from "../agents/codex.ts";
import {
  DEFAULT_AGENT_LENIENT,
  DEFAULT_AGENT_ON_FAILURE,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_SCHEMA_MAX_RETRIES,
  DEFAULT_STALL_RETRIES,
} from "../agents/defaults.ts";
import { canonicalJson, sha256Hex } from "../hash.ts";
import { DEFAULT_WORKFLOW_DEFINITION_TTL_MS } from "../workflow-definitions/snapshot.ts";

export type SettingClass = "workflow-visible" | "daemon-operational";
export type SettingSource = "catalog" | "default";

export interface SettingsDiagnostic {
  level: "error" | "warning" | "info";
  path: string;
  message: string;
}

export interface SettingView {
  key: string;
  class: SettingClass;
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  readOnly: boolean;
  generation: number | null;
  updatedAtMs: number | null;
  description: string;
}

export interface DaemonSettingCatalogRow {
  key: string;
  valueJson: string;
  generation: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RunSettingSnapshotRowLike {
  key: string;
  class: SettingClass;
  valueJson: string;
  defaultJson: string;
  source: SettingSource;
  catalogGeneration: number | null;
}

export interface WorkflowVisibleSettings {
  agentDefaultTimeoutMs: number;
  agentDefaultStallRetries: number;
  agentDefaultMaxRetries: number;
  agentDefaultLenient: boolean;
  agentDefaultOnFailure: "throw" | "null";
}

interface SettingDefinition {
  key: string;
  class: SettingClass;
  defaultValue: unknown;
  readOnly: boolean;
  description: string;
  validate(value: unknown): SettingsDiagnostic[];
}

const SETTINGS: SettingDefinition[] = [
  {
    key: "agent.defaultTimeoutMs",
    class: "workflow-visible",
    defaultValue: DEFAULT_AGENT_TIMEOUT_MS,
    readOnly: false,
    description:
      "Default per-attempt stall timeout for agents when the workflow spec and profile do not set timeoutMs.",
    validate: integerValidator("> 0", (n) => n > 0),
  },
  {
    key: "agent.defaultStallRetries",
    class: "workflow-visible",
    defaultValue: DEFAULT_STALL_RETRIES,
    readOnly: false,
    description:
      "Default number of extra stall retries for agents when the workflow spec and profile do not set stallRetries.",
    validate: integerValidator(">= 0", (n) => n >= 0),
  },
  {
    key: "agent.defaultMaxRetries",
    class: "workflow-visible",
    defaultValue: DEFAULT_SCHEMA_MAX_RETRIES,
    readOnly: false,
    description:
      "Default structured-output validation retries when the workflow spec and profile do not set maxRetries.",
    validate: integerValidator(">= 0", (n) => n >= 0),
  },
  {
    key: "agent.defaultLenient",
    class: "workflow-visible",
    defaultValue: DEFAULT_AGENT_LENIENT,
    readOnly: false,
    description:
      "Default tolerant output coercion when the workflow spec and profile do not set lenient.",
    validate: booleanValidator,
  },
  {
    key: "agent.defaultOnFailure",
    class: "workflow-visible",
    defaultValue: DEFAULT_AGENT_ON_FAILURE,
    readOnly: true,
    description:
      "Default failure handling when the workflow spec and profile do not set onFailure.",
    validate: enumValidator(["throw", "null"]),
  },
  {
    key: "codex.rpcTimeoutMs",
    class: "daemon-operational",
    defaultValue: CODEX_RPC_RESPONSE_TIMEOUT_MS,
    readOnly: false,
    description: "Timeout for short Codex app-server setup and RPC request-response calls.",
    validate: integerValidator("> 0", (n) => n > 0),
  },
  {
    key: "codex.connectTimeoutMs",
    class: "daemon-operational",
    defaultValue: CODEX_CONNECT_TIMEOUT_MS,
    readOnly: false,
    description: "Timeout for Codex WebSocket or Unix-domain socket connection attempts.",
    validate: integerValidator("> 0", (n) => n > 0),
  },
  {
    key: "workflowDefinition.gcTtlMs",
    class: "daemon-operational",
    defaultValue: DEFAULT_WORKFLOW_DEFINITION_TTL_MS,
    readOnly: false,
    description:
      "Default TTL used by workflow definition garbage collection when the request does not supply ttlMs.",
    validate: integerValidator(">= 0", (n) => n >= 0),
  },
];

export const SETTINGS_CATALOG = Object.freeze(SETTINGS);
const BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting] as const));

export function workflowVisibleSettingKeys(): string[] {
  return SETTINGS.filter((setting) => setting.class === "workflow-visible").map(
    (setting) => setting.key,
  );
}

export function getSettingDefinition(key: string): SettingDefinition | null {
  return BY_KEY.get(key) ?? null;
}

export function validateSettingWrite(key: string, value: unknown): SettingsDiagnostic[] {
  const definition = getSettingDefinition(key);
  if (!definition) {
    return [
      {
        level: "error",
        path: key,
        message: `unknown setting "${key}"`,
      },
    ];
  }
  if (definition.readOnly) {
    return [
      {
        level: "error",
        path: key,
        message: `setting "${key}" is read-only`,
      },
    ];
  }
  return definition.validate(value);
}

export function assertValidSettingWrite(key: string, value: unknown): void {
  const diagnostics = validateSettingWrite(key, value);
  const error = diagnostics.find((diagnostic) => diagnostic.level === "error");
  if (error) {
    throw new Error(`${error.message}; rejected value ${JSON.stringify(value)}`);
  }
}

export function canonicalSettingValueJson(key: string, value: unknown): string {
  const definition = getSettingDefinition(key);
  if (!definition) throw new Error(`unknown setting "${key}"`);
  const diagnostics = definition.validate(value);
  const error = diagnostics.find((diagnostic) => diagnostic.level === "error");
  if (error) throw new Error(`${error.message}; rejected value ${JSON.stringify(value)}`);
  return canonicalJson(value);
}

export function settingViews(rows: DaemonSettingCatalogRow[]): SettingView[] {
  const byKey = new Map(rows.map((row) => [row.key, row] as const));
  return SETTINGS.map((definition) => settingView(definition, byKey.get(definition.key)));
}

export function settingViewByKey(key: string, rows: DaemonSettingCatalogRow[]): SettingView | null {
  const definition = getSettingDefinition(key);
  if (!definition) return null;
  return settingView(
    definition,
    rows.find((row) => row.key === key),
  );
}

export function captureWorkflowVisibleSettingsSnapshot(
  rows: DaemonSettingCatalogRow[],
  capturedAtMs: number,
): {
  settingsHash: string;
  capturedAtMs: number;
  rows: Array<{
    key: string;
    class: SettingClass;
    valueJson: string;
    defaultJson: string;
    source: SettingSource;
    catalogGeneration: number | null;
  }>;
} {
  const byKey = new Map(rows.map((row) => [row.key, row] as const));
  const snapshotRows = SETTINGS.filter((definition) => definition.class === "workflow-visible").map(
    (definition) => {
      const row = byKey.get(definition.key);
      const defaultJson = canonicalJson(definition.defaultValue);
      const valueJson = row?.valueJson ?? defaultJson;
      const value = parseSettingJson(definition.key, valueJson);
      const diagnostics = definition.validate(value);
      const error = diagnostics.find((diagnostic) => diagnostic.level === "error");
      if (error) {
        throw new Error(`persisted setting "${definition.key}" is invalid: ${error.message}`);
      }
      return {
        key: definition.key,
        class: definition.class,
        valueJson,
        defaultJson,
        source: row ? ("catalog" as const) : ("default" as const),
        catalogGeneration: row?.generation ?? null,
      };
    },
  );
  return {
    settingsHash: effectiveSettingsHash(snapshotRows),
    capturedAtMs,
    rows: snapshotRows,
  };
}

export function workflowVisibleSettingsFromSnapshot(
  runId: string,
  rows: RunSettingSnapshotRowLike[],
): WorkflowVisibleSettings {
  const byKey = new Map(rows.map((row) => [row.key, row] as const));
  const value = (key: string): unknown => {
    const definition = getSettingDefinition(key);
    if (!definition || definition.class !== "workflow-visible") {
      throw new Error(`setting "${key}" is not a workflow-visible setting`);
    }
    const row = byKey.get(key);
    if (!row) throw new Error(`run ${runId} is missing workflow-visible setting "${key}"`);
    if (row.class !== "workflow-visible") {
      throw new Error(`run ${runId} setting "${key}" has class "${row.class}"`);
    }
    const parsed = parseSettingJson(key, row.valueJson);
    const diagnostics = definition.validate(parsed);
    const error = diagnostics.find((diagnostic) => diagnostic.level === "error");
    if (error) throw new Error(`run ${runId} setting "${key}" is invalid: ${error.message}`);
    return parsed;
  };
  return {
    agentDefaultTimeoutMs: value("agent.defaultTimeoutMs") as number,
    agentDefaultStallRetries: value("agent.defaultStallRetries") as number,
    agentDefaultMaxRetries: value("agent.defaultMaxRetries") as number,
    agentDefaultLenient: value("agent.defaultLenient") as boolean,
    agentDefaultOnFailure: value("agent.defaultOnFailure") as "throw" | "null",
  };
}

export function effectiveSettingsHash(rows: RunSettingSnapshotRowLike[]): string {
  return sha256Hex(
    canonicalJson(
      rows.map((row) => ({
        key: row.key,
        class: row.class,
        value: JSON.parse(row.valueJson),
        defaultValue: JSON.parse(row.defaultJson),
        source: row.source,
        catalogGeneration: row.catalogGeneration,
      })),
    ),
  );
}

export function effectiveOperationalSettings(rows: DaemonSettingCatalogRow[]): {
  codexRpcTimeoutMs: number;
  codexConnectTimeoutMs: number;
  workflowDefinitionGcTtlMs: number;
} {
  const view = (key: string) => {
    const row = rows.find((candidate) => candidate.key === key);
    const definition = getSettingDefinition(key);
    if (!definition) throw new Error(`unknown setting "${key}"`);
    const value = row ? parseSettingJson(key, row.valueJson) : definition.defaultValue;
    const diagnostics = definition.validate(value);
    const error = diagnostics.find((diagnostic) => diagnostic.level === "error");
    if (error) throw new Error(`persisted setting "${key}" is invalid: ${error.message}`);
    return value;
  };
  return {
    codexRpcTimeoutMs: view("codex.rpcTimeoutMs") as number,
    codexConnectTimeoutMs: view("codex.connectTimeoutMs") as number,
    workflowDefinitionGcTtlMs: view("workflowDefinition.gcTtlMs") as number,
  };
}

function settingView(
  definition: SettingDefinition,
  row: DaemonSettingCatalogRow | undefined,
): SettingView {
  const value = row ? parseSettingJson(definition.key, row.valueJson) : definition.defaultValue;
  const diagnostics = definition.validate(value);
  const error = diagnostics.find((diagnostic) => diagnostic.level === "error");
  if (error) throw new Error(`persisted setting "${definition.key}" is invalid: ${error.message}`);
  return {
    key: definition.key,
    class: definition.class,
    value,
    defaultValue: definition.defaultValue,
    isDefault: !row,
    readOnly: definition.readOnly,
    generation: row?.generation ?? null,
    updatedAtMs: row?.updatedAtMs ?? null,
    description: definition.description,
  };
}

function parseSettingJson(key: string, json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(
      `persisted setting "${key}" has invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function integerValidator(
  expectation: string,
  predicate: (value: number) => boolean,
): (value: unknown) => SettingsDiagnostic[] {
  return (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || !predicate(value)) {
      return [
        {
          level: "error",
          path: "value",
          message: `expected integer ${expectation}`,
        },
      ];
    }
    return [];
  };
}

function booleanValidator(value: unknown): SettingsDiagnostic[] {
  if (typeof value !== "boolean") {
    return [{ level: "error", path: "value", message: "expected boolean" }];
  }
  return [];
}

function enumValidator(values: string[]): (value: unknown) => SettingsDiagnostic[] {
  return (value) => {
    if (typeof value !== "string" || !values.includes(value)) {
      return [
        {
          level: "error",
          path: "value",
          message: `expected one of ${values.map((v) => JSON.stringify(v)).join(", ")}`,
        },
      ];
    }
    return [];
  };
}
