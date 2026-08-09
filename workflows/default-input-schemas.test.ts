import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertValidWorkflowInputSchema, validateWorkflowInput } from "../src/workflow-input.ts";

const cases = [
  ["oracle", { question: "Compare the available designs" }],
  ["iterative-review", { task: "Review the change" }],
  ["implement-review-loop", { spec: ".specs/change.md" }],
  ["branch-worktree-implement-review", { spec: ".specs/change.md", retention: "retain" }],
  ["spec-review-loop", { specPath: ".specs/change.md", task: "Review the spec" }],
  ["spec-author-review-loop", { specPath: ".specs/change.md", request: "Draft the spec" }],
] as const;

describe("default workflow input schemas", () => {
  for (const [name, validInput] of cases) {
    test(`${name} declares a valid contract`, async () => {
      const schema = JSON.parse(
        readFileSync(join(import.meta.dir, name, "input-schema.json"), "utf8"),
      );
      await expect(assertValidWorkflowInputSchema(schema)).resolves.toBeUndefined();
      await expect(validateWorkflowInput(schema, validInput)).resolves.toBeUndefined();
      await expect(validateWorkflowInput(schema, { unexpected: true })).rejects.toThrow();
    });
  }

  test("completion check contracts enforce type-specific fields", async () => {
    const directSchema = JSON.parse(
      readFileSync(join(import.meta.dir, "implement-review-loop", "input-schema.json"), "utf8"),
    );
    const worktreeSchema = JSON.parse(
      readFileSync(
        join(import.meta.dir, "branch-worktree-implement-review", "input-schema.json"),
        "utf8",
      ),
    );

    await expect(
      validateWorkflowInput(directSchema, {
        spec: ".specs/change.md",
        completionChecks: [{ key: "tests", type: "command" }],
      }),
    ).rejects.toThrow();
    await expect(
      validateWorkflowInput(worktreeSchema, {
        spec: ".specs/change.md",
        retention: "retain",
        completionChecks: [{ key: "commits", type: "has-commits", baseRef: "main" }],
      }),
    ).rejects.toThrow();
  });
});
