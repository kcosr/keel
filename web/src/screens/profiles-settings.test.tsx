import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelWebClient } from "../api/client";
import type { AgentProfileView, SettingView } from "../api/types";
import { ProfilesScreen } from "./profiles";
import { SettingsScreen } from "./settings";

afterEach(() => {
  cleanup();
});

describe("ProfilesScreen", () => {
  test("loads profile detail and validation check for the selected profile", async () => {
    const client = {
      listAgentProfiles: vi.fn(async () => [profile()]),
      getAgentProfile: vi.fn(async () => profile()),
      checkAgentProfile: vi.fn(async () => ({ ok: true, diagnostics: [] })),
    } as unknown as KeelWebClient;

    render(<ProfilesScreen client={client} refreshKey={0} />);

    await screen.findByText("codex-default");
    await waitFor(() => expect(client.getAgentProfile).toHaveBeenCalledWith("codex-default"));
    await waitFor(() => expect(client.checkAgentProfile).toHaveBeenCalledWith("codex-default"));
    expect(screen.getAllByText("gpt-5").length).toBeGreaterThan(0);
    expect(screen.getByText("No diagnostics")).toBeInTheDocument();
  });

  test("validates and saves catalog profile edits with a generation precondition", async () => {
    const catalog = profile({ source: "catalog", generation: 7 });
    const putAgentProfile = vi.fn(async () => catalog);
    const client = {
      listAgentProfiles: vi.fn(async () => [catalog]),
      getAgentProfile: vi.fn(async () => catalog),
      checkAgentProfile: vi.fn(async () => ({ ok: true, diagnostics: [] })),
      checkAgentProfileConfig: vi.fn(async () => ({ ok: true, diagnostics: [] })),
      putAgentProfile,
    } as unknown as KeelWebClient;

    render(<ProfilesScreen client={client} refreshKey={0} />);
    await waitFor(() => expect(client.getAgentProfile).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Loading profile")).not.toBeInTheDocument());
    const saveButton = screen.getByRole("button", { name: /save profile/i });
    const editor = screen.getByLabelText("Configuration JSON");
    fireEvent.change(editor, { target: { value: '{"provider":"codex","model":"gpt-5.1"}' } });
    fireEvent.submit(saveButton.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(putAgentProfile).toHaveBeenCalledWith({
        name: "codex-default",
        config: { provider: "codex", model: "gpt-5.1" },
        ifGeneration: 7,
      }),
    );
  });
});

describe("SettingsScreen", () => {
  test("loads setting detail and validates the selected current value", async () => {
    const client = {
      listSettings: vi.fn(async () => [setting()]),
      getSetting: vi.fn(async () => setting()),
      checkSetting: vi.fn(async () => ({ ok: true, diagnostics: [] })),
    } as unknown as KeelWebClient;

    render(<SettingsScreen client={client} refreshKey={0} />);

    await waitFor(() =>
      expect(screen.getAllByText("agent.defaultTimeoutMs").length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(client.getSetting).toHaveBeenCalledWith("agent.defaultTimeoutMs"));
    await waitFor(() =>
      expect(client.checkSetting).toHaveBeenCalledWith("agent.defaultTimeoutMs", 120000),
    );
    expect(screen.getAllByText("Default per-attempt stall timeout").length).toBeGreaterThan(0);
    expect(screen.getByText("No diagnostics")).toBeInTheDocument();
  });

  test("skips write validation for read-only settings", async () => {
    const readOnlySetting = setting({ key: "daemon.configPath", readOnly: true });
    const client = {
      listSettings: vi.fn(async () => [readOnlySetting]),
      getSetting: vi.fn(async () => readOnlySetting),
      checkSetting: vi.fn(async () => ({
        ok: false,
        diagnostics: [{ level: "error" as const, path: "daemon.configPath", message: "read-only" }],
      })),
    } as unknown as KeelWebClient;

    render(<SettingsScreen client={client} refreshKey={0} />);

    await waitFor(() => expect(client.getSetting).toHaveBeenCalledWith("daemon.configPath"));
    expect(client.checkSetting).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Runtime write validation is skipped because writes are not available/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("failed")).not.toBeInTheDocument();
  });

  test("validates and saves setting edits with a generation precondition", async () => {
    const current = setting({ generation: 3 });
    const putSetting = vi.fn(async () => ({ ...current, value: 180000, generation: 4 }));
    const client = {
      listSettings: vi.fn(async () => [current]),
      getSetting: vi.fn(async () => current),
      checkSetting: vi.fn(async () => ({ ok: true, diagnostics: [] })),
      putSetting,
    } as unknown as KeelWebClient;

    render(<SettingsScreen client={client} refreshKey={0} />);
    await waitFor(() => expect(client.getSetting).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Loading setting")).not.toBeInTheDocument());
    const saveButton = screen.getByRole("button", { name: /save value/i });
    const editor = screen.getByLabelText("JSON value");
    fireEvent.change(editor, { target: { value: "180000" } });
    fireEvent.submit(saveButton.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(putSetting).toHaveBeenCalledWith("agent.defaultTimeoutMs", 180000, 3),
    );
  });
});

function profile(overrides: Partial<AgentProfileView> = {}): AgentProfileView {
  return {
    name: "codex-default",
    source: "programmatic",
    config: { provider: "codex", model: "gpt-5", toolPolicy: "read-only" },
    configHash: "sha256-profile",
    generation: null,
    createdAtMs: null,
    updatedAtMs: null,
    ...overrides,
  };
}

function setting(overrides: Partial<SettingView> = {}): SettingView {
  return {
    key: "agent.defaultTimeoutMs",
    class: "workflow-visible",
    value: 120000,
    defaultValue: 120000,
    isDefault: true,
    readOnly: false,
    generation: null,
    updatedAtMs: null,
    description: "Default per-attempt stall timeout",
    ...overrides,
  };
}
