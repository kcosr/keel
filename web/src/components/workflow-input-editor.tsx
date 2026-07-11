import { Code2, ListTree, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { IconButton, Select, TextInput } from "./controls";

type InputMode = "form" | "json";
type Path = string[];

interface InputSchema {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  required?: string[];
  items?: unknown;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

export function WorkflowInputEditor({
  schema,
  value,
  onChange,
  onValidityChange,
}: {
  schema: unknown;
  value: unknown;
  onChange(value: unknown): void;
  onValidityChange(valid: boolean): void;
}) {
  const jsonId = useId();
  const formSchema = renderableObjectSchema(schema);
  const [mode, setMode] = useState<InputMode>(formSchema ? "form" : "json");
  const [jsonText, setJsonText] = useState(() => JSON.stringify(value, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "form") setJsonText(JSON.stringify(value, null, 2));
  }, [mode, value]);

  const selectMode = (nextMode: InputMode) => {
    if (nextMode === "form") {
      try {
        const parsed = JSON.parse(jsonText);
        if (!isRecord(parsed)) throw new Error("Input must be a JSON object");
        onChange(parsed);
        setJsonError(null);
        onValidityChange(true);
      } catch (error) {
        setJsonError(error instanceof Error ? error.message : String(error));
        onValidityChange(false);
        return;
      }
    }
    setMode(nextMode);
  };

  const updateJson = (text: string) => {
    setJsonText(text);
    try {
      onChange(JSON.parse(text));
      setJsonError(null);
      onValidityChange(true);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error));
      onValidityChange(false);
    }
  };

  const updatePath = (path: Path, nextValue: unknown, remove = false) => {
    onChange(writePath(value, path, nextValue, remove));
    onValidityChange(true);
  };

  return (
    <div className="workflow-input-editor">
      {formSchema ? (
        <fieldset className="workflow-input-mode">
          <legend>Input editor mode</legend>
          <button type="button" aria-pressed={mode === "form"} onClick={() => selectMode("form")}>
            <ListTree size={14} />
            Form
          </button>
          <button type="button" aria-pressed={mode === "json"} onClick={() => selectMode("json")}>
            <Code2 size={14} />
            JSON
          </button>
        </fieldset>
      ) : null}
      {mode === "form" && formSchema ? (
        <div className="workflow-input-fields">
          {orderedProperties(formSchema).map(([name, propertySchema]) => (
            <SchemaField
              key={name}
              name={name}
              schema={propertySchema as InputSchema}
              path={[name]}
              required={formSchema.required?.includes(name) ?? false}
              value={readPath(value, [name])}
              onChange={updatePath}
            />
          ))}
        </div>
      ) : (
        <label className="form-field form-field-wide" htmlFor={jsonId}>
          <span>Input JSON</span>
          <textarea
            id={jsonId}
            className="field-textarea workflow-input-json"
            value={jsonText}
            onChange={(event) => updateJson(event.target.value)}
            aria-invalid={jsonError !== null}
          />
        </label>
      )}
      {jsonError ? <div className="form-error">{jsonError}</div> : null}
    </div>
  );
}

function SchemaField({
  name,
  schema,
  path,
  required,
  value,
  onChange,
}: {
  name: string;
  schema: InputSchema;
  path: Path;
  required: boolean;
  value: unknown;
  onChange(path: Path, value: unknown, remove?: boolean): void;
}) {
  const id = useId();
  const label = schema.title?.trim() || humanize(name);

  if (schema.type === "object") {
    if (!schema.properties) {
      return (
        <JsonObjectField
          id={id}
          label={label}
          required={required}
          value={value}
          onChange={(nextValue, remove) => onChange(path, nextValue, remove)}
        />
      );
    }
    return (
      <fieldset className="workflow-input-group">
        <legend>{label}</legend>
        {schema.description ? <p>{schema.description}</p> : null}
        <div className="workflow-input-fields">
          {orderedProperties(schema).map(([childName, childSchema]) => (
            <SchemaField
              key={childName}
              name={childName}
              schema={childSchema as InputSchema}
              path={[...path, childName]}
              required={schema.required?.includes(childName) ?? false}
              value={readPath(value, [childName])}
              onChange={onChange}
            />
          ))}
        </div>
      </fieldset>
    );
  }

  if (schema.type === "array") {
    return (
      <div className="workflow-schema-field">
        <span
          className={`workflow-schema-label ${required ? "" : "is-optional"}`}
          id={`${id}-label`}
        >
          <strong>{label}</strong>
        </span>
        {schema.description ? (
          <small className="workflow-schema-description">{schema.description}</small>
        ) : null}
        <ArrayField
          labelledBy={`${id}-label`}
          schema={schema}
          value={Array.isArray(value) ? value : []}
          onChange={(nextValue) => onChange(path, nextValue, !required && nextValue.length === 0)}
        />
      </div>
    );
  }

  const control = fieldControl(schema, value, id, required, path, onChange);

  return (
    <label className="workflow-schema-field" htmlFor={id}>
      <span className={`workflow-schema-label ${required ? "" : "is-optional"}`}>
        <strong>{label}</strong>
      </span>
      {schema.description ? (
        <small className="workflow-schema-description">{schema.description}</small>
      ) : null}
      {control}
    </label>
  );
}

function fieldControl(
  schema: InputSchema,
  value: unknown,
  id: string,
  required: boolean,
  path: Path,
  onChange: (path: Path, value: unknown, remove?: boolean) => void,
): ReactNode {
  if (schema.enum) {
    const selected = schema.enum.findIndex((candidate) => Object.is(candidate, value));
    return (
      <Select
        id={id}
        required={required}
        value={selected < 0 ? "" : String(selected)}
        onChange={(event) => {
          if (event.target.value === "") onChange(path, undefined, true);
          else onChange(path, schema.enum?.[Number(event.target.value)]);
        }}
      >
        <option value="">{required ? "Choose…" : "Not set"}</option>
        {schema.enum.map((option, index) => (
          <option key={JSON.stringify(option)} value={index}>
            {String(option)}
          </option>
        ))}
      </Select>
    );
  }

  if (schema.type === "boolean") {
    return (
      <Select
        id={id}
        required={required}
        value={typeof value === "boolean" ? String(value) : ""}
        onChange={(event) => {
          if (event.target.value === "") onChange(path, undefined, true);
          else onChange(path, event.target.value === "true");
        }}
      >
        <option value="">{required ? "Choose…" : "Not set"}</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }

  if (schema.type === "number" || schema.type === "integer") {
    return (
      <TextInput
        id={id}
        type="number"
        required={required}
        value={typeof value === "number" ? value : ""}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === "integer" ? 1 : (schema.multipleOf ?? "any")}
        onChange={(event) => {
          if (event.target.value === "") onChange(path, undefined, true);
          else onChange(path, Number(event.target.value));
        }}
      />
    );
  }

  return (
    <TextInput
      id={id}
      required={required}
      value={typeof value === "string" ? value : ""}
      minLength={schema.minLength}
      maxLength={schema.maxLength}
      pattern={schema.pattern}
      onChange={(event) => {
        if (!required && event.target.value === "") onChange(path, undefined, true);
        else onChange(path, event.target.value);
      }}
    />
  );
}

function ArrayField({
  labelledBy,
  schema,
  value,
  onChange,
}: {
  labelledBy: string;
  schema: InputSchema;
  value: unknown[];
  onChange(value: unknown[]): void;
}) {
  const itemSchema = schema.items as InputSchema;
  const atMaximum = schema.maxItems !== undefined && value.length >= schema.maxItems;
  return (
    <div className="workflow-array-field" aria-labelledby={labelledBy}>
      {value.map((item, index) => (
        <div className="workflow-array-row" key={`${index}-${String(item)}`}>
          {arrayItemControl(itemSchema, item, index, (nextItem) => {
            const next = [...value];
            next[index] = nextItem;
            onChange(next);
          })}
          <IconButton
            icon={Trash2}
            label={`Remove item ${index + 1}`}
            disabled={schema.minItems !== undefined && value.length <= schema.minItems}
            onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
          />
        </div>
      ))}
      <button
        className="workflow-array-add"
        type="button"
        disabled={atMaximum}
        onClick={() => onChange([...value, initialArrayItem(itemSchema)])}
      >
        <Plus size={14} />
        Add item
      </button>
    </div>
  );
}

function arrayItemControl(
  schema: InputSchema,
  value: unknown,
  index: number,
  onChange: (value: unknown) => void,
) {
  if (schema.type === "object") {
    return (
      <fieldset className="workflow-array-object">
        <legend>Item {index + 1}</legend>
        <div className="workflow-input-fields">
          {orderedProperties(schema).map(([name, propertySchema]) => (
            <SchemaField
              key={name}
              name={name}
              schema={propertySchema as InputSchema}
              path={[name]}
              required={schema.required?.includes(name) ?? false}
              value={readPath(value, [name])}
              onChange={(path, nextValue, remove) =>
                onChange(writePath(value, path, nextValue, remove ?? false))
              }
            />
          ))}
        </div>
      </fieldset>
    );
  }
  if (schema.enum) {
    const selected = schema.enum.findIndex((candidate) => Object.is(candidate, value));
    return (
      <Select
        aria-label="Array item"
        value={selected < 0 ? "" : String(selected)}
        onChange={(event) => onChange(schema.enum?.[Number(event.target.value)])}
      >
        {schema.enum.map((option, index) => (
          <option key={JSON.stringify(option)} value={index}>
            {String(option)}
          </option>
        ))}
      </Select>
    );
  }
  if (schema.type === "boolean") {
    return (
      <Select
        aria-label="Array item"
        value={String(value)}
        onChange={(event) => onChange(event.target.value === "true")}
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    );
  }
  if (schema.type === "number" || schema.type === "integer") {
    return (
      <TextInput
        aria-label="Array item"
        type="number"
        value={typeof value === "number" ? value : ""}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === "integer" ? 1 : (schema.multipleOf ?? "any")}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    );
  }
  return (
    <TextInput
      aria-label="Array item"
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function renderableObjectSchema(value: unknown): InputSchema | null {
  if (!isRecord(value) || value.type !== "object" || !isRecord(value.properties)) return null;
  return Object.values(value.properties).every(renderableFieldSchema)
    ? (value as InputSchema)
    : null;
}

function orderedProperties(schema: InputSchema): Array<[string, unknown]> {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).sort(
    ([left], [right]) => Number(required.has(right)) - Number(required.has(left)),
  );
}

function renderableFieldSchema(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (
    ["oneOf", "anyOf", "allOf", "$ref", "if", "then", "else", "not"].some((key) => key in value)
  ) {
    return false;
  }
  if (value.enum !== undefined && !Array.isArray(value.enum)) return false;
  if (["string", "number", "integer", "boolean"].includes(value.type)) return true;
  if (value.type === "object") {
    if (isRecord(value.properties)) {
      return Object.values(value.properties).every(renderableFieldSchema);
    }
    return value.additionalProperties === true || isRecord(value.additionalProperties);
  }
  if (value.type === "array") return renderableFieldSchema(value.items);
  return false;
}

function initialArrayItem(schema: InputSchema): unknown {
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "object") return {};
  return "";
}

function JsonObjectField({
  id,
  label,
  required,
  value,
  onChange,
}: {
  id: string;
  label: string;
  required: boolean;
  value: unknown;
  onChange(value: unknown, remove?: boolean): void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() =>
    value === undefined && !required ? "" : JSON.stringify(isRecord(value) ? value : {}, null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  const update = (nextText: string) => {
    setText(nextText);
    if (!required && nextText.trim() === "") {
      setError(null);
      textareaRef.current?.setCustomValidity("");
      onChange(undefined, true);
      return;
    }
    try {
      const parsed = JSON.parse(nextText);
      if (!isRecord(parsed)) throw new Error("Value must be a JSON object");
      setError(null);
      textareaRef.current?.setCustomValidity("");
      onChange(parsed);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      textareaRef.current?.setCustomValidity(message);
    }
  };

  return (
    <label className="workflow-schema-field" htmlFor={id}>
      <span className={`workflow-schema-label ${required ? "" : "is-optional"}`}>
        <strong>{label}</strong>
      </span>
      <textarea
        ref={textareaRef}
        id={id}
        className="field-textarea workflow-object-json"
        required={required}
        placeholder="{}"
        value={text}
        onChange={(event) => update(event.target.value)}
        aria-invalid={error !== null}
      />
      {error ? <small className="form-error">{error}</small> : null}
    </label>
  );
}

function readPath(value: unknown, path: Path): unknown {
  let cursor = value;
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function writePath(value: unknown, path: Path, nextValue: unknown, remove: boolean): unknown {
  const root = isRecord(value) ? { ...value } : {};
  let cursor = root;
  for (const segment of path.slice(0, -1)) {
    const child = cursor[segment];
    cursor[segment] = isRecord(child) ? { ...child } : {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const last = path.at(-1);
  if (last === undefined) return root;
  if (remove) delete cursor[last];
  else cursor[last] = nextValue;
  return root;
}

function humanize(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
