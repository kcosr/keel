import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import {
  authorize,
  ensureAdminCapability,
  hashCapabilityToken,
  issueRunCapability,
} from "./capabilities.ts";

describe("capability authorization", () => {
  test("run tokens authorize only their scoped run actions", () => {
    const store = JournalStore.memory();
    try {
      const { token } = issueRunCapability(store, "run_1", 1000);
      expect(store.getCapabilityByHash(hashCapabilityToken(token))?.secretHash).toBe(
        hashCapabilityToken(token),
      );

      expect(() =>
        authorize(
          store,
          token,
          { action: "run:read", resource: { kind: "run", runId: "run_1" } },
          1000,
        ),
      ).not.toThrow();
      expect(() =>
        authorize(
          store,
          token,
          { action: "run:read", resource: { kind: "run", runId: "run_2" } },
          1000,
        ),
      ).toThrow(/different resource/);
      expect(() =>
        authorize(store, token, { action: "admin", resource: { kind: "daemon" } }, 1000),
      ).toThrow(/admin/);
    } finally {
      store.close();
    }
  });

  test("admin capabilities authorize through the same capability table", () => {
    const store = JournalStore.memory();
    try {
      ensureAdminCapability(store, "kc_admin_test", 1000);
      expect(() =>
        authorize(
          store,
          "kc_admin_test",
          { action: "run:rewind", resource: { kind: "run", runId: "run_any" } },
          1000,
        ),
      ).not.toThrow();
    } finally {
      store.close();
    }
  });
});
