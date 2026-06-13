// Commit 10: named agent profiles — the profile resolves into the agent before
// versioning, so the RESOLVED fields drive provider selection and the version
// hash; changing the profile config re-runs the step, renaming it does not.

import { describe, expect, test } from "bun:test";
import { resolveProfile } from "../agents/profiles.ts";
import type { AgentInvocation, AgentProvider, AgentResult } from "../agents/types.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { JournalStore } from "../journal/store.ts";
import { RealmKernel } from "./realm/realm-host.ts";

const profiledUrl = new URL("./realm/fixtures/profiled.workflow.ts", import.meta.url).pathname;

describe("resolveProfile", () => {
  test("inherits profile fields, explicit spec wins, unknown profile throws", () => {
    const profiles = { reviewer: { provider: "pi", model: "opus", reasoning: "high" } };
    const resolved = resolveProfile(
      { key: "k", prompt: "p", profile: "reviewer" },
      profiles,
    ) as Record<string, unknown>;
    expect(resolved).toEqual({
      key: "k",
      prompt: "p",
      provider: "pi",
      model: "opus",
      reasoning: "high",
    });
    // explicit field wins over the profile
    expect(
      resolveProfile({ key: "k", prompt: "p", profile: "reviewer", model: "haiku" }, profiles)
        .model,
    ).toBe("haiku");
    // unknown profile fails loud
    expect(() => resolveProfile({ key: "k", prompt: "p", profile: "nope" }, profiles)).toThrow(
      /unknown agent profile/,
    );
  });
});

describe("profiles through the realm", () => {
  /** records which provider name it was invoked under. */
  function recordingProvider(name: string, seen: string[]): AgentProvider {
    return {
      name,
      async generate(_inv: AgentInvocation): Promise<AgentResult> {
        seen.push(name);
        return { text: "ok", transcript: [] };
      },
    };
  }

  test("an agent resolves its provider/model from the named profile", async () => {
    const store = JournalStore.memory();
    const seen: string[] = [];
    const kernel = new RealmKernel(store, {
      idgen: () => "r",
      agents: new AgentProviderRegistry().register(recordingProvider("reviewerProvider", seen)),
      agentProfiles: { reviewer: { provider: "reviewerProvider", model: "opus" } },
    });
    const handle = await kernel.run<string>(profiledUrl, null, { name: "p" });
    expect(handle.status).toBe("finished");
    expect(seen).toEqual(["reviewerProvider"]); // provider came from the profile
  });

  test("changing a profile's config changes the agent step version (re-runs)", async () => {
    // version hash with the profile resolving to model A vs model B
    const v = (model: string) => {
      const store = JournalStore.memory();
      const seen: string[] = [];
      return new RealmKernel(store, {
        idgen: () => "r",
        agents: new AgentProviderRegistry().register(recordingProvider("p", seen)),
        agentProfiles: { reviewer: { provider: "p", model } },
      })
        .run(profiledUrl, null, { name: "p" })
        .then(() => store.getJournalRow("r", "review", 1)?.version ?? "");
    };
    const [vA, vB] = await Promise.all([v("opus"), v("haiku")]);
    expect(vA).not.toBe(vB); // resolved model is part of the version
  });
});
