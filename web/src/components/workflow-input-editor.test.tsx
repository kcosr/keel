import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WorkflowInputEditor } from "./workflow-input-editor";

afterEach(() => cleanup());

const schema = {
  type: "object",
  required: ["task", "mode"],
  properties: {
    task: { type: "string", title: "Task", minLength: 1 },
    mode: { type: "string", enum: ["review", "apply"] },
    maxFindings: { type: "integer", minimum: 1 },
    includeDrafts: { type: "boolean" },
    focus: { type: "array", items: { type: "string" } },
  },
};

describe("WorkflowInputEditor", () => {
  test("renders typed controls and omits cleared optional values", () => {
    let value: unknown = { task: "review", mode: "review", maxFindings: 5 };
    const onChange = vi.fn((nextValue: unknown) => {
      value = nextValue;
    });
    const { rerender } = render(
      <WorkflowInputEditor
        schema={schema}
        value={value}
        onChange={onChange}
        onValidityChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Task")).toHaveValue("review");
    expect(screen.getByLabelText("Mode")).toHaveValue("0");
    fireEvent.change(screen.getByLabelText(/max findings/i), { target: { value: "" } });
    rerender(
      <WorkflowInputEditor
        schema={schema}
        value={value}
        onChange={onChange}
        onValidityChange={vi.fn()}
      />,
    );
    expect(value).toEqual({ task: "review", mode: "review" });

    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    expect(onChange).toHaveBeenLastCalledWith({ task: "review", mode: "review", focus: [""] });
  });

  test("keeps JSON mode synchronized and reports invalid JSON", () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    render(
      <WorkflowInputEditor
        schema={schema}
        value={{ task: "review", mode: "review" }}
        onChange={onChange}
        onValidityChange={onValidityChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const input = screen.getByLabelText("Input JSON");
    expect(input).toHaveValue('{\n  "task": "review",\n  "mode": "review"\n}');
    fireEvent.change(input, { target: { value: "{" } });
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText(/expected property name/i)).toBeInTheDocument();
  });

  test("keeps typed form mode and isolates complex properties as JSON fields", () => {
    render(
      <WorkflowInputEditor
        schema={{
          type: "object",
          properties: {
            task: { type: "string" },
            completionChecks: { type: "array", items: { oneOf: [] } },
          },
        }}
        value={{}}
        onChange={vi.fn()}
        onValidityChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Task")).toBeInTheDocument();
    expect(screen.getByLabelText(/completion checks/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Input editor mode" })).toBeInTheDocument();
  });

  test("preserves scalar array input focus and does not coerce a cleared number to zero", () => {
    const arraySchema = {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" } },
        counts: { type: "array", items: { type: "integer" } },
      },
    };

    function Harness() {
      const [value, setValue] = useState<unknown>({ names: [""], counts: [1] });
      return (
        <>
          <WorkflowInputEditor
            schema={arraySchema}
            value={value}
            onChange={setValue}
            onValidityChange={vi.fn()}
          />
          <output>{JSON.stringify(value)}</output>
        </>
      );
    }

    render(<Harness />);
    const arrayInputs = screen.getAllByLabelText("Array item");
    expect(arrayInputs).toHaveLength(2);
    const nameInput = arrayInputs[0];
    const countInput = arrayInputs[1];
    if (!nameInput || !countInput) throw new Error("expected both array inputs");
    nameInput.focus();
    fireEvent.change(nameInput, { target: { value: "review" } });
    expect(document.activeElement).toBe(nameInput);
    expect(screen.getByLabelText("Array item", { selector: "input[type=number]" })).toBeRequired();
    fireEvent.change(countInput, { target: { value: "" } });
    expect(screen.getByText('{"names":["review"],"counts":[""]}')).toBeInTheDocument();
  });

  test("renders repeatable object rows and free-form object values", () => {
    const structuredSchema = {
      type: "object",
      properties: {
        checks: {
          type: "array",
          title: "Checks",
          items: {
            type: "object",
            required: ["key", "type"],
            properties: {
              key: { type: "string", title: "Key" },
              type: { type: "string", title: "Type", enum: ["command", "git-clean"] },
              env: {
                type: "object",
                title: "Environment",
                additionalProperties: { type: "string" },
              },
            },
          },
        },
      },
    };

    function Harness() {
      const [value, setValue] = useState<unknown>({});
      return (
        <>
          <WorkflowInputEditor
            schema={structuredSchema}
            value={value}
            onChange={setValue}
            onValidityChange={vi.fn()}
          />
          <output>{JSON.stringify(value)}</output>
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "lint" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Environment"), {
      target: { value: '{"CI":"true"}' },
    });
    expect(
      screen.getByText('{"checks":[{"key":"lint","type":"git-clean","env":{"CI":"true"}}]}'),
    ).toBeInTheDocument();
  });
});
