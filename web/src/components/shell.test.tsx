import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { HealthResponse } from "../api/types";
import { AppShell } from "./shell";

const HEALTH: HealthResponse = {
  ok: true,
  web: { ok: true, apiOnly: false },
  daemon: { reachable: true, ok: true, ownerId: "owner_1" },
  bundle: { available: true },
};

describe("AppShell", () => {
  test("renders persistent navigation and credential controls", () => {
    const onCredentialChange = vi.fn();
    const onSearchChange = vi.fn();
    render(
      <AppShell
        route="runs"
        title="Runs"
        subtitle="Test subtitle"
        health={HEALTH}
        credential=""
        search=""
        onCredentialChange={onCredentialChange}
        onSearchChange={onSearchChange}
        onRefresh={vi.fn()}
      >
        <div>content</div>
      </AppShell>,
    );

    expect(screen.getByRole("link", { name: /runs/i })).toHaveClass("is-active");
    expect(screen.getByRole("link", { name: /approvals/i })).toBeInTheDocument();
    expect(screen.getByText("daemon")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Bearer token"), {
      target: { value: "kc_test" },
    });
    expect(onCredentialChange).toHaveBeenCalledWith("kc_test");

    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "run_1" },
    });
    expect(onSearchChange).toHaveBeenCalledWith("run_1");
  });
});
