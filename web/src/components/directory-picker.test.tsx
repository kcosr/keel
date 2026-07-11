import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelWebClient } from "../api/client";
import { DirectoryPickerField } from "./directory-picker";

afterEach(cleanup);

describe("DirectoryPickerField", () => {
  test("browses daemon directories and selects the current path", async () => {
    const browseDirectories = vi.fn(async (path: string) => {
      if (path === "~") {
        return {
          path: "/home/kevin",
          parentPath: "/home",
          entries: [
            { name: ".config", path: "/home/kevin/.config" },
            { name: "projects", path: "/home/kevin/projects" },
          ],
          truncated: false,
        };
      }
      return {
        path,
        parentPath: "/home/kevin",
        entries: [{ name: "keel", path: `${path}/keel` }],
        truncated: false,
      };
    });
    const client = { browseDirectories } as unknown as KeelWebClient;
    const onChange = vi.fn();

    render(
      <DirectoryPickerField
        client={client}
        id="target"
        label="Target"
        value=""
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse target" }));
    expect(await screen.findByRole("button", { name: "Open projects" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open .config" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Show hidden"));
    expect(screen.getByRole("button", { name: "Open .config" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open projects" }));
    await waitFor(() => expect(browseDirectories).toHaveBeenLastCalledWith("/home/kevin/projects"));
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));

    expect(onChange).toHaveBeenCalledWith("/home/kevin/projects");
    expect(screen.queryByRole("dialog", { name: "Select directory" })).not.toBeInTheDocument();
  });

  test("keeps manual path entry available", () => {
    const client = { browseDirectories: vi.fn() } as unknown as KeelWebClient;
    const onChange = vi.fn();
    render(
      <DirectoryPickerField
        client={client}
        id="target"
        label="Target"
        value="/tmp"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "/srv/work" } });
    expect(onChange).toHaveBeenCalledWith("/srv/work");
  });
});
