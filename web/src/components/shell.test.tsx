import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HealthResponse } from "../api/types";
import { AppShell } from "./shell";

const HEALTH: HealthResponse = {
  ok: true,
  web: { ok: true, apiOnly: false },
  daemon: { reachable: true, ok: true, ownerId: "owner_1" },
  bundle: { available: true },
};

describe("AppShell", () => {
  afterEach(cleanup);

  test("renders navigation and applies credentials explicitly", () => {
    const onCredentialApply = vi.fn();
    render(
      <AppShell
        route="runs"
        title="Runs"
        subtitle="Test subtitle"
        health={HEALTH}
        credentialSet={false}
        onCredentialApply={onCredentialApply}
        onCredentialClear={vi.fn()}
        onRefresh={vi.fn()}
      >
        <div>content</div>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: /runs/i })).toHaveClass("is-active");
    expect(screen.getByRole("link", { name: /approvals/i })).toBeInTheDocument();
    expect(screen.getByText("Daemon online")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /runs/i })).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: /^access credential/i }));
    fireEvent.change(screen.getByLabelText("Bearer credential"), {
      target: { value: "kc_test" },
    });
    expect(onCredentialApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply credential" }));
    expect(onCredentialApply).toHaveBeenCalledWith("kc_test");
  });

  test("traps and restores focus for access credential management", () => {
    render(
      <AppShell
        route="runs"
        title="Runs"
        health={HEALTH}
        credentialSet={false}
        onCredentialApply={vi.fn()}
        onCredentialClear={vi.fn()}
        onRefresh={vi.fn()}
      >
        <button type="button">Background action</button>
      </AppShell>,
    );

    const trigger = screen.getByRole("button", { name: /^access credential/i });
    fireEvent.click(trigger);
    expect(screen.getByLabelText("Bearer credential")).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
