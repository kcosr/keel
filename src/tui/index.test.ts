import { describe, expect, test } from "bun:test";
import type { EventEnvelope, RunOutcome, RunStart } from "../rpc/contract.ts";
import type { Blockage, RunProjection, RunReport, RunSummary } from "../rpc/projection.ts";
import { type TuiClient, runTui } from "./index.ts";
import type { TuiProcessEvent, TuiReadable, TuiWritable } from "./terminal.ts";

class FakeInput implements TuiReadable {
  isTTY = true;
  rawModes: boolean[] = [];
  resumed = 0;
  paused = 0;
  private readonly listeners = new Set<(data: Buffer) => void>();

  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }

  resume(): void {
    this.resumed += 1;
  }

  pause(): void {
    this.paused += 1;
  }

  on(event: "data", listener: (data: Buffer) => void): void {
    this.listeners.add(listener);
  }

  off(event: "data", listener: (data: Buffer) => void): void {
    this.listeners.delete(listener);
  }

  emit(text: string): void {
    for (const listener of [...this.listeners]) listener(Buffer.from(text));
  }
}

class FakeOutput implements TuiWritable {
  isTTY = true;
  columns = 100;
  rows = 14;
  readonly writes: string[] = [];

  write(chunk: string): void {
    this.writes.push(chunk);
  }

  text(): string {
    return this.writes.join("");
  }
}

class FakeProcess {
  exitCode?: string | number | null;
  private readonly listeners = new Map<TuiProcessEvent, Set<(...args: any[]) => void>>();

  on(event: TuiProcessEvent, listener: (...args: any[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: TuiProcessEvent, listener: (...args: any[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  exit(code?: number): never {
    this.exitCode = code;
    throw new Error(`exit ${code}`);
  }
}

interface FakeSubscription {
  runId: string;
  afterSeq: number;
  onEvent: (event: EventEnvelope) => void;
  onError?: (err: unknown) => void;
  onCaughtUp?: () => void;
  unsubscribed: boolean;
  unsubscribeCalls: number;
}

class FakeTuiClient implements TuiClient {
  readonly runs: RunSummary[] = [summary("run_a", "alpha"), summary("run_b", "beta")];
  readonly subscriptions: FakeSubscription[] = [];
  readonly getRunCalls: string[] = [];
  readonly resumeCalls: string[] = [];
  readonly retryCalls: string[] = [];
  listCalls = 0;
  retryError: Error | null = null;

  async listRuns(): Promise<RunSummary[]> {
    this.listCalls += 1;
    return this.runs;
  }

  async getRun(runId: string): Promise<RunProjection | null> {
    this.getRunCalls.push(runId);
    return projection(runId);
  }

  async getRunReport(runId: string): Promise<RunReport | null> {
    return report(runId);
  }

  async getBlockage(_runId: string): Promise<Blockage> {
    return { reason: "running", blockedOn: null, context: "executing normally" };
  }

  async resumeRun(runId: string): Promise<RunStart> {
    this.resumeCalls.push(runId);
    return { runId, status: "running" };
  }

  async retryRun(runId: string): Promise<RunStart> {
    this.retryCalls.push(runId);
    if (this.retryError) throw this.retryError;
    return { runId, status: "running" };
  }

  async rewindRun(runId: string): Promise<RunStart> {
    return { runId, status: "running" };
  }

  async decideApproval(_runId: string): Promise<{ status: string }> {
    return { status: "running" };
  }

  async sendSignal(_runId: string): Promise<{ status: string }> {
    return { status: "running" };
  }

  async getRunOutput(runId: string): Promise<RunOutcome> {
    return { runId, status: "finished", output: "ok", error: null };
  }

  subscribeEvents(
    runId: string,
    afterSeq: number,
    onEvent: (event: EventEnvelope) => void,
    onError?: (err: unknown) => void,
    onCaughtUp?: () => void,
  ): () => void {
    const subscription: FakeSubscription = {
      runId,
      afterSeq,
      onEvent,
      onError,
      onCaughtUp,
      unsubscribed: false,
      unsubscribeCalls: 0,
    };
    this.subscriptions.push(subscription);
    return () => {
      subscription.unsubscribed = true;
      subscription.unsubscribeCalls += 1;
    };
  }
}

describe("runTui orchestration", () => {
  test("opens browser detail watch and detaches on authorization failure or subscribe error", async () => {
    const client = new FakeTuiClient();
    const io = fakeIo();
    const done = runTui({ ...io, clientFactory: async () => client, process: new FakeProcess() });
    try {
      await waitFor(() => client.listCalls === 1, "initial browser refresh");
      expect(io.stdout.text()).toContain("run_a");

      io.stdin.emit("w");
      await waitFor(() => client.subscriptions.length === 1, "first watch subscription");
      const first = client.subscriptions[0] as FakeSubscription;
      expect(first.runId).toBe("run_a");
      expect(first.afterSeq).toBe(0);

      first.onCaughtUp?.();
      await waitFor(() => io.stdout.text().includes("watch: attached run_a (live)"), "watch live");
      first.onEvent({
        kind: "durable",
        seq: 4,
        type: "phase",
        payload: { title: "backfilled" },
        atMs: 1_000,
      });
      await waitFor(() => io.stdout.text().includes("[4] phase: backfilled"), "durable event");

      first.onEvent({
        kind: "ephemeral",
        type: "authorization.failed",
        payload: { message: "expired" },
        atMs: 1_001,
      });
      await waitFor(
        () =>
          io.stdout.text().includes("watch authorization failed: expired") &&
          io.stdout.text().includes("watch: detached"),
        "authorization failure detach",
      );
      expect(first.unsubscribed).toBe(true);

      io.stdin.emit("w");
      await waitFor(() => client.subscriptions.length === 2, "reattach after auth failure");
      const second = client.subscriptions[1] as FakeSubscription;
      expect(second.afterSeq).toBe(4);
      second.onError?.(new Error("socket down"));
      await waitFor(
        () =>
          io.stdout.text().includes("watch error: socket down") &&
          io.stdout.text().includes("watch: detached"),
        "subscribe error detach",
      );
      expect(second.unsubscribed).toBe(true);
    } finally {
      io.stdin.emit("q");
      await done;
    }
  });

  test("action success refreshes and reattaches while rejection leaves detail intact", async () => {
    const client = new FakeTuiClient();
    const io = fakeIo();
    const done = runTui({
      ...io,
      runId: "run_a",
      clientFactory: async () => client,
      process: new FakeProcess(),
    });
    try {
      await waitFor(() => client.getRunCalls.length >= 1, "direct detail refresh");
      expect(io.stdout.text()).toContain("Keel run detail");

      io.stdin.emit("w");
      await waitFor(() => client.subscriptions.length === 1, "initial detail watch");
      const first = client.subscriptions[0] as FakeSubscription;
      first.onEvent({
        kind: "durable",
        seq: 5,
        type: "phase",
        payload: { title: "before resume" },
        atMs: 2_000,
      });
      await waitFor(() => io.stdout.text().includes("[5] phase: before resume"), "seq recorded");

      io.stdin.emit("R");
      await waitFor(() => client.resumeCalls.length === 1, "resume call");
      await waitFor(() => client.subscriptions.length === 2, "reattach after resume");
      const second = client.subscriptions[1] as FakeSubscription;
      expect(first.unsubscribed).toBe(true);
      expect(second.runId).toBe("run_a");
      expect(second.afterSeq).toBe(5);
      expect(client.getRunCalls.length).toBeGreaterThanOrEqual(2);

      client.retryError = new Error("owned elsewhere");
      io.stdin.emit("t");
      await waitFor(() => client.retryCalls.length === 1, "retry call");
      await waitFor(() => io.stdout.text().includes("owned elsewhere"), "retry rejection status");
      expect(client.subscriptions.length).toBe(2);
      expect(io.stdout.text()).toContain("Keel run detail");
      expect(io.stdout.text()).toContain("run run_a");
    } finally {
      io.stdin.emit("q");
      await done;
    }
  });
});

function fakeIo(): { stdin: FakeInput; stdout: FakeOutput } {
  return { stdin: new FakeInput(), stdout: new FakeOutput() };
}

function summary(runId: string, workflowName: string): RunSummary {
  return {
    runId,
    workflowName,
    status: "running",
    createdAtMs: Date.UTC(2026, 5, 14, 1, 0, 0, 0),
    finishedAtMs: null,
    parentRunId: null,
  };
}

function projection(runId: string): RunProjection {
  return {
    runId,
    workflowName: runId === "run_a" ? "alpha" : "beta",
    status: "running",
    definitionVersion: "def_1",
    parentRunId: null,
    createdAtMs: Date.UTC(2026, 5, 14, 1, 0, 0, 0),
    finishedAtMs: null,
    nodes: [],
    phase: null,
    error: null,
    stats: { steps: 0, agents: 0, artifacts: 0 },
  };
}

function report(runId: string): RunReport {
  return {
    runId,
    workflowName: runId === "run_a" ? "alpha" : "beta",
    status: "running",
    createdAtMs: Date.UTC(2026, 5, 14, 1, 0, 0, 0),
    finishedAtMs: null,
    error: null,
    nodes: [],
    stats: { steps: 0, agents: 0, artifacts: 0 },
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}
