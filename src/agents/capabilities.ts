// Capability model (DESIGN.md §11) — one normalized declaration
// mapped to per-vendor enforcement in one place. The OS-sandbox backstop (§11.1)
// is a later hardening; this is the vendor-flag layer.

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

export function resolveToolPolicy(spec: {
  capabilities?: Partial<Capabilities>;
  toolPolicy?: ToolPolicy;
  allowTools?: string[];
  denyTools?: string[];
}): ResolvedToolPolicy {
  const toolPolicy = spec.toolPolicy;
  const baseCaps =
    toolPolicy !== undefined
      ? capabilitiesForToolPolicy(toolPolicy)
      : spec.capabilities
        ? capabilitiesFromPartial(spec.capabilities)
        : capabilitiesForToolPolicy(DEFAULT_TOOL_POLICY);
  const allowTools = normalizeToolList(spec.allowTools);
  const denyTools = normalizeToolList(spec.denyTools);
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

export function resolveInvocationToolPolicy(spec: {
  capabilities?: Capabilities;
  toolPolicy?: ToolPolicy;
  allowTools?: string[];
  denyTools?: string[];
}): ResolvedToolPolicy {
  if (!spec.capabilities) return resolveToolPolicy(spec);
  const capabilities = cloneCapabilities(spec.capabilities);
  const allowTools = normalizeToolList(spec.allowTools);
  const denyTools = normalizeToolList(spec.denyTools);
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
  for (const tool of resolved.allowTools) tools.add(normalizePiToolName(tool));
  for (const tool of resolved.denyTools)
    deleteToolCaseInsensitive(tools, normalizePiToolName(tool));
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
  for (const tool of resolved.allowTools) tools.add(normalizeClaudeToolName(tool));
  for (const tool of resolved.denyTools) {
    deleteToolCaseInsensitive(tools, normalizeClaudeToolName(tool));
  }
  if (tools.size === 0) return ["--tools", ""];
  return ["--tools", ...tools];
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

function capabilitiesFromPartial(caps: Partial<Capabilities>): Capabilities {
  return cloneCapabilities({ ...DENY_ALL, ...caps });
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

function normalizeToolList(tools: string[] | undefined): string[] {
  if (!tools) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tools) {
    const tool = raw.trim();
    const key = tool.toLowerCase();
    if (!tool || seen.has(key)) continue;
    seen.add(key);
    out.push(tool);
  }
  return out;
}

function normalizePiToolName(tool: string): string {
  const trimmed = tool.trim();
  const aliases: Record<string, string> = {
    read: "read",
    grep: "grep",
    glob: "grep",
    ls: "ls",
    list: "ls",
    edit: "edit",
    write: "write",
    bash: "bash",
    shell: "bash",
    run: "bash",
    exec: "bash",
  };
  return aliases[trimmed.toLowerCase()] ?? trimmed;
}

function normalizeClaudeToolName(tool: string): string {
  const key = tool
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
  const aliases: Record<string, string> = {
    read: "Read",
    grep: "Grep",
    glob: "Glob",
    ls: "LS",
    list: "LS",
    edit: "Edit",
    write: "Write",
    multiedit: "MultiEdit",
    notebookedit: "NotebookEdit",
    bash: "Bash",
    shell: "Bash",
    run: "Bash",
    exec: "Bash",
    webfetch: "WebFetch",
    fetch: "WebFetch",
    websearch: "WebSearch",
    search: "WebSearch",
  };
  return aliases[key] ?? tool.trim();
}

function deleteToolCaseInsensitive(tools: Set<string>, tool: string): void {
  const target = tool.toLowerCase();
  for (const existing of tools) {
    if (existing.toLowerCase() === target) tools.delete(existing);
  }
}
