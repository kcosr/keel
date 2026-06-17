import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { KeelWebClient } from "../api/client";
import { ApprovalsScreen } from "./approvals";

describe("ApprovalsScreen", () => {
  test("selects approval rows and labels disabled actions as unavailable", async () => {
    const client = {
      listApprovals: async () => ({
        approvals: [
          {
            runId: "run_a",
            runName: "first",
            status: "waiting-human",
            gateId: "gate_a",
            prompt: "first prompt",
            createdAtMs: 1,
            requiredAuthority: "admin",
            cli: "keel approve run_a gate_a",
          },
          {
            runId: "run_b",
            runName: "second",
            status: "waiting-human",
            gateId: "gate_b",
            prompt: "second prompt",
            createdAtMs: 2,
            requiredAuthority: "admin",
            cli: "keel approve run_b gate_b",
          },
        ],
      }),
    } as KeelWebClient;

    render(<ApprovalsScreen client={client} refreshKey={0} />);

    await screen.findByText("first prompt");
    expect(screen.getByText("keel approve run_a gate_a")).toBeInTheDocument();
    expect(screen.getByText("Approve unavailable")).toBeDisabled();
    expect(screen.getByText("Deny unavailable")).toBeDisabled();
    expect(screen.getByText(/not available in the web UI yet/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText("second prompt"));

    await waitFor(() => {
      expect(screen.getByText("keel approve run_b gate_b")).toBeInTheDocument();
    });
  });
});
