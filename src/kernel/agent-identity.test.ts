// Agent step identity includes capabilities, secrets, and resolved workspace id.

import { describe, expect, test } from "bun:test";
import { type ToolPolicy, resolveToolPolicy } from "../agents/capabilities.ts";
import type { ProviderConfigValue } from "../agents/types.ts";
import { DEFAULT_WORKSPACE_ID } from "../workspace/identity.ts";
import { computeVersion } from "./version.ts";

function agentVersion(spec: {
  prompt: string;
  provider: string;
  providerConfig?: ProviderConfigValue;
  model?: string | null;
  reasoning?: string | null;
  capabilities?: Record<string, unknown>;
  toolPolicy?: ToolPolicy;
  allowTools?: string[];
  denyTools?: string[];
  workspaceId?: string;
  secrets?: string[];
}): string {
  const tools = resolveToolPolicy({
    ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
    ...(spec.toolPolicy ? { toolPolicy: spec.toolPolicy } : {}),
    ...(spec.allowTools ? { allowTools: spec.allowTools } : {}),
    ...(spec.denyTools ? { denyTools: spec.denyTools } : {}),
  });
  const caps = tools.capabilities;
  return computeVersion({
    spec: {
      prompt: spec.prompt,
      provider: spec.provider,
      ...(spec.providerConfig !== undefined ? { providerConfig: spec.providerConfig } : {}),
      model: spec.model ?? null,
      reasoning: spec.reasoning ?? null,
      toolPolicy: tools.toolPolicy,
      allowTools: tools.allowTools,
      denyTools: tools.denyTools,
      workspaceId: spec.workspaceId ?? DEFAULT_WORKSPACE_ID,
      capabilities: caps,
      secrets: spec.secrets ?? [],
    },
  });
}

describe("agent identity includes capabilities, secrets, and workspace", () => {
  test("omitted tool policy is identical to read-only", () => {
    const base = { prompt: "p", provider: "pi" };
    expect(agentVersion(base)).toBe(agentVersion({ ...base, toolPolicy: "read-only" }));
  });

  test("changing capabilities changes the version", () => {
    const base = { prompt: "p", provider: "pi" };
    const ro = agentVersion({ ...base, toolPolicy: "read-only" });
    const rw = agentVersion({ ...base, capabilities: { fs: "workspace-write" } });
    expect(ro).not.toBe(rw);
  });

  test("changing explicit tool edits changes the version", () => {
    const base = { prompt: "p", provider: "pi", toolPolicy: "read-only" as const };
    expect(agentVersion(base)).not.toBe(agentVersion({ ...base, allowTools: ["bash"] }));
    expect(agentVersion(base)).not.toBe(agentVersion({ ...base, denyTools: ["ls"] }));
  });

  test("changing workspace id changes the version", () => {
    const base = { prompt: "p", provider: "pi", toolPolicy: "read-only" as const };
    expect(agentVersion(base)).not.toBe(agentVersion({ ...base, workspaceId: "implementation" }));
  });

  test("changing the secrets set changes the version", () => {
    const base = { prompt: "p", provider: "pi" };
    const a = agentVersion({ ...base, secrets: ["A"] });
    const b = agentVersion({ ...base, secrets: ["A", "B"] });
    expect(a).not.toBe(b);
  });

  test("identical specs produce identical versions (in-process/realm parity)", () => {
    const spec = { prompt: "p", provider: "pi", model: "m", capabilities: { fs: "read" as const } };
    expect(agentVersion(spec)).toBe(agentVersion(spec));
  });

  test("selected provider config changes version and key order is canonical", () => {
    const base = { prompt: "p", provider: "codex" };
    const a = agentVersion({ ...base, providerConfig: { transport: { type: "stdio" } } });
    const b = agentVersion({ ...base, providerConfig: { transport: { type: "uds" } } });
    const reorderedA = agentVersion({
      ...base,
      providerConfig: { b: 2, a: { y: true, x: "same" } },
    });
    const reorderedB = agentVersion({
      ...base,
      providerConfig: { a: { x: "same", y: true }, b: 2 },
    });
    expect(a).not.toBe(b);
    expect(reorderedA).toBe(reorderedB);
  });

  test("absence of selected provider config omits the identity key", () => {
    const base = { prompt: "p", provider: "codex" };
    expect(agentVersion(base)).toBe(agentVersion({ ...base }));
    expect(agentVersion(base)).not.toBe(agentVersion({ ...base, providerConfig: {} }));
  });

  test("codex serviceTier omitted, normal, and fast are distinct identities", () => {
    const base = { prompt: "p", provider: "codex" };
    const omitted = agentVersion(base);
    const explicitTransportOnly = agentVersion({
      ...base,
      providerConfig: { transport: { type: "stdio" } },
    });
    const normal = agentVersion({
      ...base,
      providerConfig: { transport: { type: "stdio" }, serviceTier: "normal" },
    });
    const fast = agentVersion({
      ...base,
      providerConfig: { transport: { type: "stdio" }, serviceTier: "fast" },
    });
    expect(new Set([omitted, explicitTransportOnly, normal, fast]).size).toBe(4);
  });
});
