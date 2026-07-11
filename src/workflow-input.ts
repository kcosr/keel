import type { ErrorObject, ValidateFunction } from "ajv";
import { canonicalJson } from "./hash.ts";

const MAX_CACHED_WORKFLOW_INPUT_SCHEMAS = 256;

export interface WorkflowInputValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export class WorkflowInputValidationError extends Error {
  readonly issues: WorkflowInputValidationIssue[];

  constructor(label: string, issues: WorkflowInputValidationIssue[]) {
    super(`${label}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "WorkflowInputValidationError";
    this.issues = issues;
  }
}

let ajvPromise: Promise<import("ajv").default> | null = null;
const validatorCache = new Map<string, ValidateFunction>();

export async function assertValidWorkflowInputSchema(
  schema: unknown,
  label = "Invalid input schema",
): Promise<void> {
  try {
    await validatorFor(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
}

export async function validateWorkflowInput(
  schema: unknown,
  input: unknown,
  label = "Workflow input validation failed",
): Promise<void> {
  let validate: ValidateFunction;
  try {
    validate = await validatorFor(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid workflow input schema: ${message}`);
  }
  if (!validate(input)) {
    throw new WorkflowInputValidationError(label, (validate.errors ?? []).map(validationIssue));
  }
}

async function validatorFor(schema: unknown): Promise<ValidateFunction> {
  if ((typeof schema !== "object" || schema === null) && typeof schema !== "boolean") {
    throw new Error("schema must be a JSON object or boolean");
  }
  const key = canonicalJson(schema);
  const cached = validatorCache.get(key);
  if (cached) return cached;
  const validate = (await workflowInputAjv()).compile(schema);
  if (validatorCache.size >= MAX_CACHED_WORKFLOW_INPUT_SCHEMAS) {
    const oldest = validatorCache.keys().next().value;
    if (oldest !== undefined) validatorCache.delete(oldest);
  }
  validatorCache.set(key, validate);
  return validate;
}

function workflowInputAjv(): Promise<import("ajv").default> {
  ajvPromise ??= Promise.all([import("ajv"), import("ajv-formats")]).then(
    ([{ default: Ajv }, { default: addFormats }]) => {
      const instance = new Ajv({
        addUsedSchema: false,
        allErrors: true,
        allowUnionTypes: true,
        strict: true,
      });
      addFormats(instance);
      return instance;
    },
  );
  return ajvPromise;
}

function validationIssue(error: ErrorObject): WorkflowInputValidationIssue {
  const path = validationPath(error);
  return {
    path,
    keyword: error.keyword,
    message: error.message ?? `must satisfy ${error.keyword}`,
  };
}

function validationPath(error: ErrorObject): string {
  const suffix = error.instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((part) =>
      /^\d+$/.test(part)
        ? `[${part}]`
        : /^[A-Za-z_$][\w$]*$/.test(part)
          ? `.${part}`
          : `[${JSON.stringify(part)}]`,
    )
    .join("");
  if (error.keyword === "required") {
    const property = (error.params as { missingProperty?: unknown }).missingProperty;
    if (typeof property === "string") {
      return `$${suffix}${/^[A-Za-z_$][\w$]*$/.test(property) ? `.${property}` : `[${JSON.stringify(property)}]`}`;
    }
  }
  if (error.keyword === "additionalProperties") {
    const property = (error.params as { additionalProperty?: unknown }).additionalProperty;
    if (typeof property === "string") {
      return `$${suffix}${/^[A-Za-z_$][\w$]*$/.test(property) ? `.${property}` : `[${JSON.stringify(property)}]`}`;
    }
  }
  return `$${suffix}`;
}
