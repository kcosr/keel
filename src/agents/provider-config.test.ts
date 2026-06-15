import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { WorkflowCtx } from "../kernel/ctx.ts";
import {
  normalizeProviderConfigMap,
  normalizeProviderConfigValue,
  resolveSelectedProviderConfig,
} from "./provider-config.ts";
import type { AgentInvocation, AgentProvider, AgentResult } from "./types.ts";
import { AgentProviderRegistry } from "./types.ts";

describe("provider config validation", () => {
  test("resolves only the selected provider and freezes cloned config", () => {
    const explicit = { codex: { transport: { type: "stdio" } }, pi: { mode: "unused" } };
    const selected = resolveSelectedProviderConfig({
      context: 'ctx.agent("review")',
      selectedProvider: "codex",
      explicitProviderConfig: explicit,
      profileProviderConfig: { codex: { transport: { type: "uds", path: "/tmp/c.sock" } } },
    });
    expect(selected).toEqual({ transport: { type: "stdio" } });
    expect(selected).not.toBe(explicit.codex);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected?.transport)).toBe(true);
    expect(() => {
      (selected as { transport: { type: string } }).transport.type = "uds";
    }).toThrow();
    expect(explicit.codex.transport.type).toBe("stdio");
  });

  test("profile selected config is inherited, replaced, or cleared as a unit", () => {
    const profileProviderConfig = { codex: { a: 1, nested: { keep: true } }, pi: { mode: "x" } };
    expect(
      resolveSelectedProviderConfig({
        context: 'ctx.agent("a")',
        selectedProvider: "codex",
        profileName: "reviewer",
        profileProviderConfig,
      }),
    ).toEqual({ a: 1, nested: { keep: true } });
    expect(
      resolveSelectedProviderConfig({
        context: 'ctx.agent("a")',
        selectedProvider: "codex",
        explicitProviderConfig: { codex: { b: 2 } },
        profileName: "reviewer",
        profileProviderConfig,
      }),
    ).toEqual({ b: 2 });
    expect(
      resolveSelectedProviderConfig({
        context: 'ctx.agent("a")',
        selectedProvider: "codex",
        explicitProviderConfig: { codex: {} },
        profileName: "reviewer",
        profileProviderConfig,
      }),
    ).toEqual({});
  });

  test("explicit unselected config does not block selected profile inheritance", () => {
    const selected = resolveSelectedProviderConfig({
      context: 'ctx.agent("a")',
      selectedProvider: "codex",
      explicitProviderConfig: { pi: { mode: "unused" } },
      profileName: "reviewer",
      profileProviderConfig: { codex: { transport: { type: "stdio" } } },
    });
    expect(selected).toEqual({ transport: { type: "stdio" } });
  });

  test("valid unselected config validates but is not returned", () => {
    const selected = resolveSelectedProviderConfig({
      context: 'ctx.agent("a")',
      selectedProvider: "codex",
      explicitProviderConfig: { pi: { mode: "unused" } },
    });
    expect(selected).toBeUndefined();
  });

  test("invalid maps, provider names, and direct values fail with paths", () => {
    expect(() => normalizeProviderConfigMap("ctx.agent", [] as never)).toThrow(
      /ctx\.agent providerConfig must be a plain object map/,
    );
    expect(() => normalizeProviderConfigMap("ctx.agent", { "": {} })).toThrow(
      /provider name must be a non-empty string/,
    );
    expect(() => normalizeProviderConfigMap("ctx.agent", { codex: [] as never })).toThrow(
      /providerConfig\.codex must be a plain JSON object/,
    );
    expect(() => normalizeProviderConfigMap("ctx.agent", { codex: new Date() as never })).toThrow(
      /providerConfig\.codex must be a plain JSON object/,
    );
  });

  test("malformed unselected entries fail generic validation", () => {
    expect(() =>
      resolveSelectedProviderConfig({
        context: 'ctx.agent("a")',
        selectedProvider: "codex",
        explicitProviderConfig: { pi: { createdAt: new Date() as never } },
      }),
    ).toThrow(/ctx\.agent\("a"\) providerConfig\.pi\.createdAt must be a plain JSON object/);
  });

  test("rejects nested non-JSON values and sparse arrays with clear paths", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["undefined", { codex: { value: undefined } }, /providerConfig\.codex\.value/],
      ["function", { codex: { value: () => null } }, /providerConfig\.codex\.value/],
      ["symbol", { codex: { value: Symbol("x") } }, /providerConfig\.codex\.value/],
      ["bigint", { codex: { value: 1n } }, /providerConfig\.codex\.value/],
      ["non-finite", { codex: { value: Number.NaN } }, /providerConfig\.codex\.value/],
      ["map", { codex: { value: new Map() } }, /providerConfig\.codex\.value/],
    ];
    for (const [name, value, pattern] of cases) {
      expect(() => normalizeProviderConfigMap(`case ${name}`, value as never)).toThrow(pattern);
    }
    const sparse = new Array(1);
    expect(() => normalizeProviderConfigMap("ctx.agent", { codex: { sparse } })).toThrow(
      /providerConfig\.codex\.sparse\[0\]/,
    );
  });

  test("cycles produce path-bearing errors without overflowing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeProviderConfigMap("ctx.agent", { codex: cyclic as never })).toThrow(
      /ctx\.agent providerConfig\.codex\.self must be JSON-serializable \(cycle detected\)/,
    );
  });

  test("host-side selected config normalization re-freezes protocol payloads", () => {
    const selected = normalizeProviderConfigValue("realm agent", {
      transport: { type: "uds", path: "/tmp/c.sock" },
    });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.transport)).toBe(true);
  });
});

describe("in-process provider config invocation", () => {
  test("passes only selected immutable provider config with resolved cwd", async () => {
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "codex",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        invocation = inv;
        expect(inv.providerConfig).toEqual({ transport: { type: "stdio" } });
        expect(() => {
          (inv.providerConfig as { transport: { type: string } }).transport.type = "mutated";
        }).toThrow();
        return { text: "ok", transcript: [] };
      },
    };
    const ctx = new WorkflowCtx(
      JournalStore.memory(),
      "run-1",
      { clock: () => 1, rng: () => 0.5 },
      new AgentProviderRegistry().register(provider),
      undefined,
      process.cwd(),
    );

    await expect(
      ctx.agent({
        key: "review",
        provider: "codex",
        prompt: "review",
        providerConfig: {
          codex: { transport: { type: "stdio" } },
          pi: { ignored: true },
        },
      }),
    ).resolves.toBe("ok");
    expect(invocation?.cwd).toBe(process.cwd());
    expect(invocation?.providerConfig).toEqual({ transport: { type: "stdio" } });
  });

  test("omits providerConfig when only unselected config is supplied", async () => {
    let invocation: AgentInvocation | undefined;
    const provider: AgentProvider = {
      name: "codex",
      async generate(inv: AgentInvocation): Promise<AgentResult> {
        invocation = inv;
        return { text: "ok", transcript: [] };
      },
    };
    const ctx = new WorkflowCtx(
      JournalStore.memory(),
      "run-1",
      { clock: () => 1, rng: () => 0.5 },
      new AgentProviderRegistry().register(provider),
      undefined,
      process.cwd(),
    );
    await ctx.agent({
      key: "review",
      provider: "codex",
      prompt: "review",
      providerConfig: { pi: { ignored: true } },
    });
    expect(invocation?.providerConfig).toBeUndefined();
  });
});
