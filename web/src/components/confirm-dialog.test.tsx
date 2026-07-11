import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

describe("ConfirmDialog", () => {
  afterEach(cleanup);

  test("guards confirmation against repeated activation", () => {
    const confirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete item"
        detail="This cannot be undone."
        confirmLabel="Delete"
        onClose={() => undefined}
        onConfirm={confirm}
      />,
    );

    const button = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test("restores focus to an explicit trigger", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Open confirmation
          </button>
          <ConfirmDialog
            open={open}
            title="Disable item"
            detail="Confirm this change."
            confirmLabel="Disable"
            returnFocusRef={triggerRef}
            onClose={() => setOpen(false)}
            onConfirm={() => undefined}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open confirmation" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(trigger).toHaveFocus();
  });
});
