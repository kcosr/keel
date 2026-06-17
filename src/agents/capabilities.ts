// Capability model (DESIGN.md §11) — one normalized declaration
// mapped to per-vendor enforcement in one place. The OS-sandbox backstop (§11.1)
// is a later hardening; this is the vendor-flag layer.

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface Capabilities {
  /** none = no fs tools; read = read/grep/ls; workspace-write = + edit/write. */
  fs: "none" | "read" | "workspace-write";
  /** none, or an allowlist of hosts (advisory until the OS backstop lands). */
  network: "none" | string[];
  /** allow shell/bash execution. */
  shell: boolean;
  /** named secret refs this agent may receive (§11.2). */
  secrets: string[];
}

export type ToolPolicy = "none" | "read-only" | "workspace-write" | "unrestricted";

export interface ResolvedToolPolicy {
  toolPolicy: ToolPolicy;
  allowTools: string[];
  denyTools: string[];
  capabilities: Capabilities;
}

export interface ToolPolicyResolutionOptions {
  path?: string;
}

export const CAPABILITY_KEYS = [
  "fs",
  "network",
  "shell",
  "secrets",
] as const satisfies readonly (keyof Capabilities)[];

export const DENY_ALL: Capabilities = { fs: "none", network: "none", shell: false, secrets: [] };

/** Read-only review policy. */
export const READ_ONLY: Capabilities = { ...DENY_ALL, fs: "read" };

const DEFAULT_TOOL_POLICY: ToolPolicy = "read-only";

export const WORKSPACE_WRITE: Capabilities = {
  ...DENY_ALL,
  fs: "workspace-write",
};

export const UNRESTRICTED: Capabilities = {
  fs: "workspace-write",
  network: ["*"],
  shell: true,
  secrets: [],
};

/** Resolve the effective capabilities from a ctx.agent spec. */
export function resolveCapabilities(spec: {
  capabilities?: Partial<Capabilities>;
  toolPolicy?: ToolPolicy;
  allowTools?: string[];
  denyTools?: string[];
}): Capabilities {
  return resolveToolPolicy(spec).capabilities;
}

export function resolveToolPolicy(
  spec: {
    capabilities?: Partial<Capabilities>;
    toolPolicy?: ToolPolicy;
    allowTools?: string[];
    denyTools?: string[];
  },
  opts: ToolPolicyResolutionOptions = {},
): ResolvedToolPolicy {
  const toolPolicy = spec.toolPolicy;
  const baseCaps =
    toolPolicy !== undefined
      ? capabilitiesForToolPolicy(toolPolicy)
      : spec.capabilities
        ? capabilitiesFromPartial(spec.capabilities)
        : capabilitiesForToolPolicy(DEFAULT_TOOL_POLICY);
  const allowTools = normalizeRuntimeToolList(
    spec.allowTools,
    toolListPath(opts.path, "allowTools"),
  );
  const denyTools = normalizeRuntimeToolList(spec.denyTools, toolListPath(opts.path, "denyTools"));
  const resolvedPolicy =
    toolPolicy ?? (spec.capabilities ? toolPolicyForCapabilities(baseCaps) : DEFAULT_TOOL_POLICY);
  rejectUnrestrictedAdjustments({ toolPolicy: resolvedPolicy, allowTools, denyTools });
  return {
    toolPolicy: resolvedPolicy,
    allowTools,
    denyTools,
    capabilities: baseCaps,
  };
}

export function resolveInvocationToolPolicy(
  spec: {
    capabilities?: Capabilities;
    toolPolicy?: ToolPolicy;
    allowTools?: string[];
    denyTools?: string[];
  },
  opts: ToolPolicyResolutionOptions = {},
): ResolvedToolPolicy {
  if (!spec.capabilities) return resolveToolPolicy(spec, opts);
  const capabilities = cloneCapabilities(spec.capabilities);
  const allowTools = normalizeRuntimeToolList(
    spec.allowTools,
    toolListPath(opts.path, "allowTools"),
  );
  const denyTools = normalizeRuntimeToolList(spec.denyTools, toolListPath(opts.path, "denyTools"));
  rejectUnrestrictedAdjustments({
    toolPolicy: spec.toolPolicy ?? toolPolicyForCapabilities(capabilities),
    allowTools,
    denyTools,
  });
  return {
    toolPolicy: spec.toolPolicy ?? toolPolicyForCapabilities(capabilities),
    allowTools,
    denyTools,
    capabilities,
  };
}

export function resolvedToolPolicyToPiArgs(resolved: ResolvedToolPolicy): string[] {
  if (
    resolved.toolPolicy === "unrestricted" &&
    resolved.allowTools.length === 0 &&
    resolved.denyTools.length === 0
  ) {
    return [];
  }
  rejectUnrestrictedAdjustments(resolved);

  const tools = new Set(capabilitiesToPiTools(resolved.capabilities));
  for (const tool of resolved.allowTools) tools.add(requireExactPiToolName(tool));
  for (const tool of resolved.denyTools) tools.delete(requireExactPiToolName(tool));
  if (tools.size === 0) return ["--no-tools"];
  return ["--tools", [...tools].join(",")];
}

export function resolvedToolPolicyToClaudeArgs(resolved: ResolvedToolPolicy): string[] {
  if (
    resolved.toolPolicy === "unrestricted" &&
    resolved.allowTools.length === 0 &&
    resolved.denyTools.length === 0
  ) {
    return [];
  }
  rejectUnrestrictedAdjustments(resolved);

  const tools = new Set(capabilitiesToClaudeTools(resolved.capabilities));
  for (const tool of resolved.allowTools) tools.add(requireExactClaudeToolName(tool));
  for (const tool of resolved.denyTools) {
    tools.delete(requireExactClaudeToolName(tool));
  }
  if (tools.size === 0) return ["--allowed-tools", ""];
  return ["--allowed-tools", ...tools];
}

export interface CodexCapabilityParams {
  thread: {
    approvalPolicy: "never";
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
  };
  turn: {
    approvalPolicy: "never";
    sandboxPolicy:
      | { type: "readOnly"; networkAccess: false }
      | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: false }
      | { type: "dangerFullAccess" };
  };
}

export function resolvedToolPolicyToCodexParams(
  resolved: ResolvedToolPolicy,
  cwd: string | undefined,
): CodexCapabilityParams {
  const existingCwd = requireCodexCwd(cwd);

  if (resolved.allowTools.length > 0 || resolved.denyTools.length > 0) {
    throw new Error("codex provider does not support allowTools or denyTools");
  }

  const sandbox = codexSandboxForCapabilities(resolved.capabilities);
  switch (sandbox) {
    case "read-only":
      return {
        thread: { approvalPolicy: "never", sandbox: "read-only" },
        turn: {
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      };
    case "workspace-write":
      return {
        thread: { approvalPolicy: "never", sandbox: "workspace-write" },
        turn: {
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [existingCwd],
            networkAccess: false,
          },
        },
      };
    case "danger-full-access":
      return {
        thread: { approvalPolicy: "never", sandbox: "danger-full-access" },
        turn: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
      };
  }
}

export function codexSandboxForCapabilities(
  caps: Capabilities,
): "read-only" | "workspace-write" | "danger-full-access" {
  if (caps.fs === "none") {
    throw new Error(
      "codex provider does not support no-tools capability shapes; Codex app-server has no verified no-tools mapping",
    );
  }
  if (caps.fs === "read" && !caps.shell && caps.network === "none") return "read-only";
  if (caps.fs === "workspace-write" && !caps.shell && caps.network === "none") {
    return "workspace-write";
  }
  if (
    caps.fs === "workspace-write" &&
    caps.shell &&
    caps.network !== "none" &&
    caps.network.length === 1 &&
    caps.network[0] === "*"
  ) {
    return "danger-full-access";
  }
  throw new Error(
    `codex provider does not support capability shape ${formatCapabilityShape(caps)}; supported shapes are fs=read,shell=false,network=none; fs=workspace-write,shell=false,network=none; fs=workspace-write,shell=true,network=["*"]`,
  );
}

function requireCodexCwd(cwd: string | undefined): string {
  if (!cwd) throw new Error("codex cwd is missing");
  if (!isAbsolute(cwd)) throw new Error(`codex cwd is not absolute: ${cwd}`);
  if (!existingDirectory(cwd)) throw new Error(`codex cwd is not an existing directory: ${cwd}`);
  return cwd;
}

function formatCapabilityShape(caps: Capabilities): string {
  return `fs=${caps.fs}, shell=${String(caps.shell)}, network=${
    caps.network === "none" ? "none" : JSON.stringify(caps.network)
  }`;
}

function existingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function rejectUnrestrictedAdjustments(
  resolved: Pick<ResolvedToolPolicy, "toolPolicy" | "allowTools" | "denyTools">,
): void {
  if (
    resolved.toolPolicy === "unrestricted" &&
    (resolved.allowTools.length > 0 || resolved.denyTools.length > 0)
  ) {
    throw new Error(
      'toolPolicy "unrestricted" cannot be combined with allowTools or denyTools because provider-native deny semantics are not supported',
    );
  }
}

function capabilitiesForToolPolicy(policy: ToolPolicy): Capabilities {
  switch (policy) {
    case "none":
      return cloneCapabilities(DENY_ALL);
    case "read-only":
      return cloneCapabilities(READ_ONLY);
    case "workspace-write":
      return cloneCapabilities(WORKSPACE_WRITE);
    case "unrestricted":
      return cloneCapabilities(UNRESTRICTED);
  }
}

export function validateCapabilitiesDeclaration(
  caps: Record<string, unknown>,
  path = "capabilities",
): Partial<Capabilities> {
  const allowed = new Set<string>(CAPABILITY_KEYS);
  const out: Partial<Capabilities> = {};
  for (const key of Object.keys(caps)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not a supported capability`);
  }
  if (caps.fs !== undefined) {
    if (caps.fs !== "none" && caps.fs !== "read" && caps.fs !== "workspace-write") {
      throw new Error(`${path}.fs must be none, read, or workspace-write`);
    }
    out.fs = caps.fs;
  }
  if (caps.network !== undefined) {
    if (caps.network === "none") {
      out.network = "none";
    } else if (Array.isArray(caps.network)) {
      out.network = normalizeStringArrayCapability(caps.network, `${path}.network`);
    } else {
      throw new Error(`${path}.network must be "none" or an array of non-empty strings`);
    }
  }
  if (caps.shell !== undefined) {
    if (typeof caps.shell !== "boolean") throw new Error(`${path}.shell must be a boolean`);
    out.shell = caps.shell;
  }
  if (caps.secrets !== undefined) {
    if (!Array.isArray(caps.secrets)) {
      throw new Error(`${path}.secrets must be an array of non-empty strings`);
    }
    out.secrets = normalizeStringArrayCapability(caps.secrets, `${path}.secrets`);
  }
  return out;
}

function normalizeStringArrayCapability(value: unknown[], path: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    if (!(i in value)) throw new Error(`${path}[${i}] must not be a sparse array hole`);
    const item = value[i];
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${path} must be an array of non-empty strings`);
    }
    out.push(item);
  }
  return out;
}

function capabilitiesFromPartial(caps: Partial<Capabilities>): Capabilities {
  return cloneCapabilities({
    ...DENY_ALL,
    ...validateCapabilitiesDeclaration(caps as Record<string, unknown>),
  });
}

function cloneCapabilities(caps: Capabilities): Capabilities {
  return {
    fs: caps.fs,
    network: caps.network === "none" ? "none" : [...caps.network],
    shell: caps.shell,
    secrets: [...caps.secrets],
  };
}

function toolPolicyForCapabilities(caps: Capabilities): ToolPolicy {
  if (caps.network !== "none" || caps.shell || caps.fs === "workspace-write")
    return "workspace-write";
  if (caps.fs === "read") return "read-only";
  return "none";
}

function capabilitiesToPiTools(caps: Capabilities): string[] {
  const tools: string[] = [];
  if (caps.fs === "read" || caps.fs === "workspace-write") tools.push("read", "grep", "ls");
  if (caps.fs === "workspace-write") tools.push("edit", "write");
  if (caps.shell) tools.push("bash");
  return tools;
}

function capabilitiesToClaudeTools(caps: Capabilities): string[] {
  const tools: string[] = [];
  if (caps.fs === "read" || caps.fs === "workspace-write") {
    tools.push("Read", "Grep", "Glob", "LS");
  }
  if (caps.fs === "workspace-write") {
    tools.push("Edit", "MultiEdit", "Write", "NotebookEdit");
  }
  if (caps.shell) tools.push("Bash");
  if (caps.network !== "none") tools.push("WebFetch", "WebSearch");
  return tools;
}

function normalizeRuntimeToolList(tools: string[] | undefined, path: string): string[] {
  if (tools === undefined) return [];
  return normalizeProviderToolList(tools, path);
}

function toolListPath(base: string | undefined, field: "allowTools" | "denyTools"): string {
  return base ? `${base}.${field}` : field;
}

export function normalizeProviderToolList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  rejectArrayNonJsonKeys(value, path);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    if (!(i in value)) throw new Error(`${path}[${i}] must not be a sparse array hole`);
    const raw = value[i];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new Error(`${path}[${i}] must be a non-empty string`);
    }
    const tool = raw.trim();
    const key = tool.toLowerCase();
    if (seen.has(key)) throw new Error(`${path} contains duplicate tool "${tool}"`);
    seen.add(key);
    out.push(tool);
  }
  return out;
}

export function rejectArrayNonJsonKeys(value: unknown[], path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key === "symbol") throw new Error(`${path} must be JSON-serializable (symbol key)`);
    if (!isArrayIndexKey(key, value.length)) {
      throw new Error(`${path}.${key} must be JSON-serializable (array extra property)`);
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc?.enumerable) {
      throw new Error(`${path}[${key}] must be JSON-serializable (non-enumerable property)`);
    }
  }
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const n = Number(key);
  return Number.isSafeInteger(n) && n >= 0 && n < length;
}

const PI_EXACT_TOOLS = new Set(["read", "grep", "ls", "edit", "write", "bash"]);
const PI_TOOL_ALIASES = new Map([
  ["glob", "grep"],
  ["list", "ls"],
  ["shell", "bash"],
  ["run", "bash"],
  ["exec", "bash"],
]);

function requireExactPiToolName(tool: string): string {
  if (PI_EXACT_TOOLS.has(tool)) return tool;
  const lower = tool.toLowerCase();
  const canonical = PI_EXACT_TOOLS.has(lower) ? lower : PI_TOOL_ALIASES.get(lower);
  if (canonical) {
    throw new Error(`pi provider tool "${tool}" is not canonical; use "${canonical}"`);
  }
  return tool;
}

const CLAUDE_EXACT_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
]);
const CLAUDE_CANONICAL_BY_KEY = new Map(
  [...CLAUDE_EXACT_TOOLS].map((tool) => [claudeToolKey(tool), tool]),
);
const CLAUDE_TOOL_ALIASES = new Map([
  ["list", "LS"],
  ["shell", "Bash"],
  ["run", "Bash"],
  ["exec", "Bash"],
  ["fetch", "WebFetch"],
  ["search", "WebSearch"],
]);

function requireExactClaudeToolName(tool: string): string {
  if (CLAUDE_EXACT_TOOLS.has(tool)) return tool;
  const key = claudeToolKey(tool);
  const canonical = CLAUDE_CANONICAL_BY_KEY.get(key) ?? CLAUDE_TOOL_ALIASES.get(key);
  if (canonical) {
    throw new Error(`claude provider tool "${tool}" is not canonical; use "${canonical}"`);
  }
  return tool;
}

function claudeToolKey(tool: string): string {
  return tool.toLowerCase().replace(/[-_\s]/g, "");
}
