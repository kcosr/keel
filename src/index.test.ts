import { expect, test } from "bun:test";
import type { AgentEnvironmentSpec } from "@kcosr/keel";
import { SecretStore } from "@kcosr/keel/secrets";
import { VERSION } from "./index.ts";

test("package smoke: version is exported", () => {
  expect(VERSION).toBe("0.0.0");
});

test("package smoke: agent environment type and SecretStore are exported", () => {
  const environment: AgentEnvironmentSpec = {
    vars: { MODE: "test" },
    secrets: ["TOKEN"],
  };
  const secrets = new SecretStore();
  secrets.put("r", "TOKEN", "value");

  expect(environment.vars?.MODE).toBe("test");
  expect(secrets.resolveOrThrow("r", ["TOKEN"])).toEqual([{ name: "TOKEN", value: "value" }]);
});
