import { describe, expect, test } from "bun:test";
import {
  type DaemonSettingCatalogRow,
  effectiveOperationalSettings,
  settingViews,
  validateSettingWrite,
} from "./catalog.ts";

describe("settings catalog", () => {
  test("agent concurrency operational settings default to unlimited", () => {
    const settings = effectiveOperationalSettings([]);
    expect(settings.agentMaxConcurrentTotal).toBe("unlimited");
    expect(settings.agentMaxConcurrentByProvider).toEqual({});

    const views = settingViews([]);
    expect(views.find((view) => view.key === "agent.maxConcurrentTotal")).toMatchObject({
      class: "daemon-operational",
      value: "unlimited",
      defaultValue: "unlimited",
      isDefault: true,
    });
    expect(views.find((view) => view.key === "agent.maxConcurrentByProvider")).toMatchObject({
      class: "daemon-operational",
      value: {},
      defaultValue: {},
      isDefault: true,
    });
  });

  test("agent concurrency settings accept positive integers and unlimited", () => {
    expect(validateSettingWrite("agent.maxConcurrentTotal", 1)).toEqual([]);
    expect(validateSettingWrite("agent.maxConcurrentTotal", "unlimited")).toEqual([]);
    expect(
      validateSettingWrite("agent.maxConcurrentByProvider", {
        claude: 1,
        codex: 2,
        pi: "unlimited",
      }),
    ).toEqual([]);

    const rows: DaemonSettingCatalogRow[] = [
      {
        key: "agent.maxConcurrentTotal",
        valueJson: "3",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
      {
        key: "agent.maxConcurrentByProvider",
        valueJson: '{"claude":1}',
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ];
    expect(effectiveOperationalSettings(rows)).toMatchObject({
      agentMaxConcurrentTotal: 3,
      agentMaxConcurrentByProvider: { claude: 1 },
    });
  });

  test("agent concurrency settings reject ambiguous disabled values", () => {
    for (const value of [0, -1, 1.5, null, false, "none"]) {
      expect(validateSettingWrite("agent.maxConcurrentTotal", value)).toContainEqual(
        expect.objectContaining({ level: "error" }),
      );
    }

    for (const value of [
      null,
      [],
      new Date(),
      { claude: 0 },
      { codex: -1 },
      { pi: "none" },
      { "": 1 },
    ]) {
      expect(validateSettingWrite("agent.maxConcurrentByProvider", value)).toContainEqual(
        expect.objectContaining({ level: "error" }),
      );
    }
  });
});
