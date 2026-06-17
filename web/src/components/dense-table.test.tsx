import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { DenseTable } from "./dense-table";

describe("DenseTable", () => {
  test("supports keyboard row activation and adjacent-row navigation", () => {
    const onRowClick = vi.fn();
    render(
      <DenseTable
        rows={[
          { id: "first", label: "First" },
          { id: "second", label: "Second" },
          { id: "third", label: "Third" },
        ]}
        rowKey={(row) => row.id}
        selectedKey="first"
        onRowClick={onRowClick}
        columns={[{ key: "label", header: "Label", render: (row) => row.label }]}
      />,
    );

    const first = screen.getByText("First").closest("tr");
    expect(first).not.toBeNull();
    expect(first).toHaveClass("is-selected");
    expect(first).not.toHaveAttribute("aria-selected");

    fireEvent.keyDown(first as HTMLTableRowElement, { key: "ArrowDown" });
    expect(onRowClick).toHaveBeenLastCalledWith({ id: "second", label: "Second" });

    fireEvent.keyDown(first as HTMLTableRowElement, { key: "End" });
    expect(onRowClick).toHaveBeenLastCalledWith({ id: "third", label: "Third" });

    fireEvent.keyDown(first as HTMLTableRowElement, { key: "Enter" });
    expect(onRowClick).toHaveBeenLastCalledWith({ id: "first", label: "First" });
  });

  test("does not handle row shortcuts from nested controls", () => {
    const onRowClick = vi.fn();
    const onButtonClick = vi.fn();
    render(
      <DenseTable
        rows={[{ id: "first", label: "First" }]}
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
        columns={[
          { key: "label", header: "Label", render: (row) => row.label },
          {
            key: "action",
            header: "Action",
            render: () => (
              <button type="button" onClick={onButtonClick}>
                Copy
              </button>
            ),
          },
        ]}
      />,
    );

    const copy = screen.getByRole("button", { name: "Copy" });
    fireEvent.keyDown(copy, { key: " " });

    expect(onRowClick).not.toHaveBeenCalled();
  });
});
