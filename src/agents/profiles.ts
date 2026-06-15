import type { ToolPolicy } from "./capabilities.ts";

// Named agent profiles — daemon/kernel-configured presets
// (e.g. reviewer / verifier / synthesizer) so workflows don't repeat
// provider/model/toolPolicy/reasoning on every ctx.agent call.
//
// CRITICAL identity rule: a profile is resolved to its concrete fields BEFORE the
// version is computed, and those RESOLVED fields (not the profile name) enter the
// version + input hash. So editing a profile's config re-runs the steps that use
// it, while renaming the binding without changing the config does not.

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
}

export type AgentProfiles = Record<string, AgentProfile>;

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
