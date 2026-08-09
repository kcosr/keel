import { describe, expect, test } from "bun:test";
import {
  WorkflowInputValidationError,
  assertValidWorkflowInputSchema,
  validateWorkflowInput,
} from "./workflow-input.ts";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "count"],
  properties: {
    mode: { type: "string", enum: ["review", "apply"] },
    count: { type: "integer", minimum: 1 },
    note: { type: "string", minLength: 3 },
  },
} as const;

describe("workflow input contracts", () => {
  test("accepts valid Draft 7 schemas and inputs", async () => {
    await expect(assertValidWorkflowInputSchema(schema)).resolves.toBeUndefined();
    await expect(
      validateWorkflowInput(schema, { mode: "review", count: 2 }),
    ).resolves.toBeUndefined();
  });

  test("supports Draft 7 union types and standard formats", async () => {
    const draftSevenSchema = {
      type: "object",
      required: ["callback"],
      properties: {
        callback: { type: ["string", "null"], format: "uri" },
      },
    };
    await expect(assertValidWorkflowInputSchema(draftSevenSchema)).resolves.toBeUndefined();
    await expect(
      validateWorkflowInput(draftSevenSchema, { callback: "https://example.com" }),
    ).resolves.toBeUndefined();
    await expect(
      validateWorkflowInput(draftSevenSchema, { callback: "not a URI" }),
    ).rejects.toThrow(/\$\.callback must match format "uri"/);
  });

  test("allows immutable versions to reuse a schema id", async () => {
    await expect(
      assertValidWorkflowInputSchema({
        $id: "https://example.com/workflow-input",
        type: "string",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertValidWorkflowInputSchema({
        $id: "https://example.com/workflow-input",
        type: "integer",
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects malformed schemas", async () => {
    await expect(assertValidWorkflowInputSchema({ type: "not-a-type" })).rejects.toThrow(
      /Invalid input schema/,
    );
    await expect(assertValidWorkflowInputSchema("string")).rejects.toThrow(
      /schema must be a JSON object or boolean/,
    );
  });

  test("reports all input errors with field paths", async () => {
    try {
      await validateWorkflowInput(schema, { mode: "invalid", count: 0, extra: true });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowInputValidationError);
      expect((error as WorkflowInputValidationError).issues).toEqual([
        {
          path: "$.extra",
          keyword: "additionalProperties",
          message: "must NOT have additional properties",
        },
        { path: "$.mode", keyword: "enum", message: "must be equal to one of the allowed values" },
        { path: "$.count", keyword: "minimum", message: "must be >= 1" },
      ]);
    }
  });

  test("reports a missing property at the property path", async () => {
    await expect(validateWorkflowInput(schema, { mode: "review" })).rejects.toThrow(
      /\$\.count must have required property 'count'/,
    );
  });
});
