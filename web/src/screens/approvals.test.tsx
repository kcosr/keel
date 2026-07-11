import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelWebClient } from "../api/client";
import { ApprovalsScreen } from "./approvals";

describe("ApprovalsScreen", () => {
  afterEach(cleanup);

  test("selects approval rows and decides current ctx.human gates", async () => {
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
        decisionAuthority: "admin",
        decisionAuthorized: true,
      }),
      decideApproval: vi.fn(async () => ({ runId: "run_a", status: "running" })),
    } as unknown as KeelWebClient;

    render(<ApprovalsScreen client={client} refreshKey={0} />);

    await screen.findByText("first prompt");
    expect(screen.queryByText("keel approve run_a gate_a")).not.toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText("Decision note"), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(client.decideApproval).toHaveBeenCalledWith("run_a", "gate_a", {
        status: "approved",
        note: "ship it",
      });
    });

    fireEvent.click(screen.getByText("second prompt"));

    await waitFor(() => expect(screen.getAllByText("second prompt").length).toBeGreaterThan(1));
  });

  test("does not call approval RPC when decision authority is absent", async () => {
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
        ],
        decisionAuthority: "admin",
        decisionAuthorized: false,
      }),
      decideApproval: vi.fn(),
    } as unknown as KeelWebClient;

    render(<ApprovalsScreen client={client} refreshKey={0} />);

    await screen.findByText("first prompt");
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);

    expect(client.decideApproval).not.toHaveBeenCalled();
    expect(screen.getByText(/requires admin authority/i)).toBeInTheDocument();
    expect(screen.queryByText(/keel approve/)).not.toBeInTheDocument();
  });
});
