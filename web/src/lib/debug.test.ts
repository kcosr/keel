import { afterEach, describe, expect, test, vi } from "vitest";
import { isWebDebugEnabled, resetWebDebugCacheForTest, webDebug } from "./debug";

describe("web debug flags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    resetWebDebugCacheForTest();
  });

  test("enables named scopes from local storage", () => {
    localStorage.setItem("keelDebug", "events,transcript");
    resetWebDebugCacheForTest();

    expect(isWebDebugEnabled("events")).toBe(true);
    expect(isWebDebugEnabled("transcript")).toBe(true);
  });

  test("enables named scopes from URL search and hash query", () => {
    window.history.replaceState(null, "", "/?keelDebug=events#/runs");
    resetWebDebugCacheForTest();

    expect(isWebDebugEnabled("events")).toBe(true);
    expect(isWebDebugEnabled("transcript")).toBe(false);

    window.history.replaceState(null, "", "/#/runs?keelDebug=transcript");
    resetWebDebugCacheForTest();

    expect(isWebDebugEnabled("events")).toBe(false);
    expect(isWebDebugEnabled("transcript")).toBe(true);
  });

  test("evaluates debug payload callbacks only when the scope is enabled", () => {
    const payload = vi.fn(() => ({ dataLength: 12 }));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    webDebug("events", "disabled", payload);

    expect(payload).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();

    localStorage.setItem("keelDebug", "events");
    resetWebDebugCacheForTest();
    webDebug("events", "enabled", payload);

    expect(payload).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith("[keel web:events] enabled", { dataLength: 12 });
  });

  test("caches parsed debug scopes after the first lookup", () => {
    localStorage.setItem("keelDebug", "events");
    resetWebDebugCacheForTest();
    const getItem = vi.spyOn(Storage.prototype, "getItem");

    expect(isWebDebugEnabled("events")).toBe(true);
    expect(isWebDebugEnabled("transcript")).toBe(false);
    expect(isWebDebugEnabled("events")).toBe(true);

    expect(getItem).toHaveBeenCalledTimes(1);
  });
});
