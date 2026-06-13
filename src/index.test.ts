import { expect, test } from "bun:test";
import { VERSION } from "./index.ts";

test("package smoke: version is exported", () => {
  expect(VERSION).toBe("0.0.0");
});
