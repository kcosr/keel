import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CommandCopyButton } from "./controls";

describe("CommandCopyButton", () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  test("shows copied feedback only after clipboard write succeeds", async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    render(<CommandCopyButton label="Copy command" command="keel watch run_1" />);

    fireEvent.click(screen.getByRole("button", { name: /copy command/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("keel watch run_1"));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  test("keeps copy label when clipboard write fails", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    stubClipboard(writeText);
    render(<CommandCopyButton label="Copy command" command="keel watch run_1" />);

    fireEvent.click(screen.getByRole("button", { name: /copy command/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("keel watch run_1"));
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    expect(screen.getByText("Copy command")).toBeInTheDocument();
  });
});

function stubClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}
