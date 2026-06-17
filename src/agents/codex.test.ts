import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import {
  CodexProvider,
  type CodexTransport,
  type CodexTransportConfig,
  type CodexTransportContext,
  type CodexTransportFactory,
  normalizeCodexProviderConfig,
} from "./codex.ts";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
  TraceEvent,
} from "./types.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function codexInvocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    key: "edit",
    provider: "codex",
    prompt: "hello",
    toolPolicy: "unrestricted",
    cwd: process.cwd(),
    ...overrides,
  };
}

class ScriptedTransport implements CodexTransport {
  readonly descriptor = "fake";
  readonly sent: Record<string, unknown>[] = [];
  private messageCallback: ((frame: string) => void) | null = null;
  private stderrCallback: ((text: string) => void) | null = null;
  private closeCallback: ((error?: Error) => void) | null = null;
  closed = false;

  constructor(
    private readonly onSend: (
      message: Record<string, unknown>,
      transport: ScriptedTransport,
    ) => void,
  ) {}

  send(frame: string): void {
    const message = JSON.parse(frame) as Record<string, unknown>;
    this.sent.push(message);
    this.onSend(message, this);
  }

  close(): void {
    this.closed = true;
  }

  onMessage(callback: (frame: string) => void): void {
    this.messageCallback = callback;
  }

  onStderr(callback: (text: string) => void): void {
    this.stderrCallback = callback;
  }

  onClose(callback: (error?: Error) => void): void {
    this.closeCallback = callback;
  }

  respond(id: unknown, result: unknown): void {
    queueMicrotask(() => this.messageCallback?.(JSON.stringify({ jsonrpc: "2.0", id, result })));
  }

  rejectRpc(id: unknown, code: number, message: string): void {
    queueMicrotask(() =>
      this.messageCallback?.(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })),
    );
  }

  notify(method: string, params?: unknown): void {
    queueMicrotask(() =>
      this.messageCallback?.(JSON.stringify({ jsonrpc: "2.0", method, params })),
    );
  }

  raw(frame: string): void {
    queueMicrotask(() => this.messageCallback?.(frame));
  }

  stderr(text: string): void {
    this.stderrCallback?.(text);
  }

  fail(error: Error): void {
    this.closeCallback?.(error);
  }
}

class ScriptedFactory implements CodexTransportFactory {
  config?: CodexTransportConfig;
  context?: CodexTransportContext;

  constructor(readonly transport: ScriptedTransport) {}

  async open(
    config: CodexTransportConfig,
    context: CodexTransportContext,
  ): Promise<CodexTransport> {
    this.config = config;
    this.context = context;
    return this.transport;
  }
}

async function runWithTransport(
  transport: ScriptedTransport,
  invocation: Partial<AgentInvocation> = {},
  hooks: AgentHooks = {},
): Promise<{
  result: AgentResult;
  factory: ScriptedFactory;
  events: TraceEvent[];
  tokens: string[];
}> {
  const factory = new ScriptedFactory(transport);
  const provider = new CodexProvider({
    transportFactory: factory,
    rpcTimeoutMs: 1_000,
    turnTimeoutMs: 1_000,
  });
  const events: TraceEvent[] = [];
  const tokens: string[] = [];
  const result = await provider.generate(codexInvocation(invocation), {
    onEvent: (event) => {
      events.push(event);
      hooks.onEvent?.(event);
    },
    onSessionToken: (token) => {
      tokens.push(token);
      hooks.onSessionToken?.(token);
    },
  });
  return { result, factory, events, tokens };
}

function basicScript(message: Record<string, unknown>, transport: ScriptedTransport): void {
  switch (message.method) {
    case "initialize":
      transport.respond(message.id, { capabilities: { experimentalApi: true } });
      break;
    case "initialized":
      break;
    case "thread/start":
      transport.respond(message.id, { thread: { id: "thread-1" } });
      break;
    case "turn/start":
      transport.respond(message.id, { turn: { id: "turn-1" } });
      transport.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
      transport.notify("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-1",
        delta: "hello",
      });
      transport.notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      break;
    default:
      throw new Error(`unexpected method ${String(message.method)}`);
  }
}

describe("Codex provider config", () => {
  test("defaults to stdio when selected config is absent", () => {
    expect(normalizeCodexProviderConfig(undefined)).toEqual({ type: "stdio" });
  });

  test("accepts and normalizes explicit transports", () => {
    expect(normalizeCodexProviderConfig({ transport: { type: "stdio" } })).toEqual({
      type: "stdio",
    });
    expect(
      normalizeCodexProviderConfig({ transport: { type: "ws", url: "ws://127.0.0.1:9" } }),
    ).toEqual({
      type: "ws",
      url: "ws://127.0.0.1:9/",
    });
    expect(
      normalizeCodexProviderConfig({ transport: { type: "uds", path: "/tmp/codex.sock" } }),
    ).toEqual({
      type: "uds",
      path: "/tmp/codex.sock",
    });
  });

  test("rejects malformed transport config with paths", () => {
    expect(() => normalizeCodexProviderConfig({})).toThrow(/providerConfig\.codex\.transport/);
    expect(() =>
      normalizeCodexProviderConfig({ extra: true, transport: { type: "stdio" } }),
    ).toThrow(/providerConfig\.codex\.extra/);
    expect(() =>
      normalizeCodexProviderConfig({ transport: { type: "stdio", extra: true } }),
    ).toThrow(/providerConfig\.codex\.transport\.extra/);
    expect(() =>
      normalizeCodexProviderConfig({ transport: { type: "ws", url: "http://x" } }),
    ).toThrow(/providerConfig\.codex\.transport\.url/);
    expect(() =>
      normalizeCodexProviderConfig({ transport: { type: "ws", url: "ws://token@example.test" } }),
    ).toThrow(/providerConfig\.codex\.transport\.url/);
    expect(() =>
      normalizeCodexProviderConfig({ transport: { type: "uds", path: "rel.sock" } }),
    ).toThrow(/providerConfig\.codex\.transport\.path/);
  });
});

describe("Codex provider cwd", () => {
  test("passes the resolved invocation cwd to the transport unchanged", async () => {
    const managed = tempDir("keel-codex-managed-cwd-");
    const transport = new ScriptedTransport(basicScript);
    const { factory } = await runWithTransport(transport, { cwd: managed });
    expect(factory.context?.cwd).toBe(managed);
  });
});

describe("Codex JSON-RPC flow", () => {
  test("handshakes, captures thread id before turn/start, and returns transcript", async () => {
    const tokens: string[] = [];
    const transport = new ScriptedTransport((message, t) => {
      if (message.method === "turn/start") expect(tokens).toEqual(["thread-1"]);
      basicScript(message, t);
    });

    const { result, events, factory } = await runWithTransport(
      transport,
      {},
      {
        onSessionToken: (token) => tokens.push(token),
      },
    );

    expect(factory.config).toEqual({ type: "stdio" });
    expect(transport.sent.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(transport.sent[0]?.params).toMatchObject({
      capabilities: { experimentalApi: true },
    });
    expect(transport.sent[2]?.params).toMatchObject({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(transport.sent[3]?.params).toMatchObject({
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(result.text).toBe("hello");
    expect(result.sessionToken).toBe("thread-1");
    expect(events).toEqual(result.transcript);
    expect(events).toContainEqual({ type: "session", data: "thread-1" });
    expect(events).toContainEqual({ type: "text", data: "hello" });
  });

  test("read-only policy sends Codex read-only thread and turn sandbox params", async () => {
    const transport = new ScriptedTransport(basicScript);

    await runWithTransport(transport, { toolPolicy: "read-only" });

    expect(transport.sent[2]?.params).toMatchObject({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(transport.sent[3]?.params).toMatchObject({
      threadId: "thread-1",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  test("workspace-write policy sends writable root in Codex turn sandbox params", async () => {
    const cwd = tempDir("keel-codex-workspace-write-");
    const transport = new ScriptedTransport(basicScript);

    await runWithTransport(transport, { toolPolicy: "workspace-write", cwd });

    expect(transport.sent[2]?.params).toMatchObject({
      cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    expect(transport.sent[3]?.params).toMatchObject({
      threadId: "thread-1",
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false },
    });
  });

  test("item/completed is authoritative and multiple items get paragraph boundaries", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          t.notify("item/agentMessage/delta", {
            threadId: "other",
            turnId: "turn-1",
            delta: "bad",
          });
          t.notify("item/completed", {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: "a", type: "agentMessage", text: "first" },
          });
          t.notify("item/completed", {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: "b", type: "agentMessage", text: "second" },
          });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed" },
          });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const { result } = await runWithTransport(transport);
    expect(result.text).toBe("first\n\nsecond");
  });

  test("accepts app-server frames that omit the jsonrpc member", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.raw(JSON.stringify({ id: message.id, result: {} }));
          break;
        case "initialized":
          t.raw(
            JSON.stringify({
              method: "remoteControl/status/changed",
              params: { status: "enabled" },
            }),
          );
          break;
        case "thread/start":
          t.raw(JSON.stringify({ id: message.id, result: { thread: { id: "thread-1" } } }));
          break;
        case "turn/start":
          t.raw(JSON.stringify({ id: message.id, result: { turn: { id: "turn-1" } } }));
          t.raw(
            JSON.stringify({
              method: "turn/started",
              params: { threadId: "thread-1", turn: { id: "turn-1" } },
            }),
          );
          t.raw(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                item: { id: "a", type: "agentMessage", text: "desktop ok" },
              },
            }),
          );
          t.raw(
            JSON.stringify({
              method: "turn/completed",
              params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
            }),
          );
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const { result } = await runWithTransport(transport);
    expect(result.text).toBe("desktop ok");
    expect(result.sessionToken).toBe("thread-1");
  });

  test("accepts protocol v2-shaped Codex notifications", async () => {
    // Mirrors openai/codex d5b4b9837017 app-server protocol v2 structs:
    // ThreadStartedNotification, TurnStartedNotification, TurnCompletedNotification,
    // ItemCompletedNotification, AgentMessageDeltaNotification, and Turn.
    const turn = {
      id: "turn-1",
      items: [],
      itemsView: "notLoaded",
      status: "inProgress",
      error: null,
      startedAt: 1_780_000_000,
      completedAt: null,
      durationMs: null,
    };
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.raw(JSON.stringify({ id: message.id, result: {} }));
          break;
        case "initialized":
          break;
        case "thread/start":
          t.raw(JSON.stringify({ id: message.id, result: { thread: { id: "thread-1" } } }));
          break;
        case "turn/start":
          t.raw(JSON.stringify({ id: message.id, result: { turn } }));
          t.raw(
            JSON.stringify({
              method: "turn/started",
              params: { threadId: "thread-1", turn },
            }),
          );
          t.raw(
            JSON.stringify({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-1",
                delta: "fixture delta",
              },
            }),
          );
          t.raw(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                completedAtMs: 1_780_000_000_500,
                item: {
                  id: "msg-1",
                  type: "agentMessage",
                  text: "fixture complete",
                  phase: null,
                  memoryCitation: null,
                },
              },
            }),
          );
          t.raw(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  ...turn,
                  status: "completed",
                  completedAt: 1_780_000_001,
                  durationMs: 1_000,
                },
              },
            }),
          );
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const { result, events } = await runWithTransport(transport);
    expect(result.text).toBe("fixture complete");
    expect(events.filter((event) => event.type === "text").map((event) => event.data)).toEqual([
      "fixture delta",
    ]);
  });

  test("resume reads, validates, resumes, and starts the next turn", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/read":
          t.respond(message.id, {
            thread: { id: "thread-1", cwd: process.cwd(), status: { type: "idle" } },
          });
          break;
        case "thread/resume":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-2" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-2" } });
          t.notify("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "turn-2",
            delta: "again",
          });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-2", status: "completed" },
          });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const { result } = await runWithTransport(transport, {
      resumeToken: "thread-1",
      toolPolicy: "read-only",
    });
    expect(transport.sent.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
      "thread/resume",
      "turn/start",
    ]);
    expect(transport.sent[3]?.params).toMatchObject({
      threadId: "thread-1",
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    expect(result.sessionToken).toBe("thread-1");
    expect(result.text).toBe("again");
  });

  test("active resumed threads are interrupted before starting the next turn", async () => {
    let turnListCalls = 0;
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/read":
          t.respond(message.id, {
            thread: { id: "thread-1", cwd: process.cwd(), status: { type: "active" } },
          });
          break;
        case "thread/turns/list":
          turnListCalls++;
          t.respond(message.id, {
            data: [
              {
                id: "stale-turn",
                status: turnListCalls === 1 ? "inProgress" : "interrupted",
              },
            ],
          });
          break;
        case "turn/interrupt":
          expect(message.params).toEqual({ threadId: "thread-1", turnId: "stale-turn" });
          t.respond(message.id, {});
          break;
        case "thread/resume":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-2" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-2" } });
          t.notify("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "turn-2",
            delta: "after interrupt",
          });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-2", status: "completed" },
          });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const { result } = await runWithTransport(transport, { resumeToken: "thread-1" });
    expect(result.text).toBe("after interrupt");
    expect(transport.sent.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
      "thread/turns/list",
      "turn/interrupt",
      "thread/turns/list",
      "thread/resume",
      "turn/start",
    ]);
  });

  test("stale active-turn completion during resume does not poison the next turn", async () => {
    let turnListCalls = 0;
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/read":
          t.respond(message.id, {
            thread: { id: "thread-1", cwd: process.cwd(), status: { type: "active" } },
          });
          break;
        case "thread/turns/list":
          turnListCalls++;
          t.respond(message.id, {
            data: [
              {
                id: "stale-turn",
                status: turnListCalls === 1 ? "inProgress" : "interrupted",
              },
            ],
          });
          break;
        case "turn/interrupt":
          expect(message.params).toEqual({ threadId: "thread-1", turnId: "stale-turn" });
          t.respond(message.id, {});
          t.notify("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "stale-turn",
            delta: "stale text",
          });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "stale-turn", status: "interrupted" },
          });
          break;
        case "thread/resume":
          t.respond(message.id, { thread: { id: "thread-1" } });
          setTimeout(() => {
            t.notify("turn/completed", {
              threadId: "thread-1",
              turn: { id: "stale-turn", status: "interrupted" },
            });
          }, 0);
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-2" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-2" } });
          t.notify("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "turn-2",
            delta: "real text",
          });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-2", status: "completed" },
          });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const { result, events } = await runWithTransport(transport, { resumeToken: "thread-1" });
    expect(result.text).toBe("real text");
    expect(events.filter((event) => event.type === "text").map((event) => event.data)).toEqual([
      "real text",
    ]);
  });

  test("active resumed threads fail closed when no active turn id is discoverable", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/read":
          t.respond(message.id, {
            thread: { id: "thread-1", cwd: process.cwd(), status: { type: "active" } },
          });
          break;
        case "thread/turns/list":
          t.respond(message.id, { data: [{ id: "done-turn", status: "completed" }] });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    await expect(runWithTransport(transport, { resumeToken: "thread-1" })).rejects.toThrow(
      /no active remote turn id/,
    );
    expect(transport.sent.map((m) => m.method)).not.toContain("turn/start");
  });

  test("active resumed threads fail closed if the remote turn completes before interruption", async () => {
    let turnListCalls = 0;
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/read":
          t.respond(message.id, {
            thread: { id: "thread-1", cwd: process.cwd(), status: { type: "active" } },
          });
          break;
        case "thread/turns/list":
          turnListCalls++;
          t.respond(message.id, {
            data: [
              {
                id: "stale-turn",
                status: turnListCalls === 1 ? "inProgress" : "completed",
              },
            ],
          });
          break;
        case "turn/interrupt":
          t.respond(message.id, {});
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    await expect(runWithTransport(transport, { resumeToken: "thread-1" })).rejects.toThrow(
      /manual reconciliation/,
    );
    expect(transport.sent.map((m) => m.method)).not.toContain("turn/start");
  });

  test("failed turns use scoped error notifications as fallback diagnostics", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          t.notify("error", { threadId: "other", turnId: "turn-1", message: "ignore me" });
          t.notify("error", { threadId: "thread-1", turnId: "turn-1", message: "tool exploded" });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "failed" },
          });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    await expect(runWithTransport(transport)).rejects.toThrow(/codex turn failed: tool exploded/);
  });

  test("JSON-RPC errors and malformed messages fail clearly", async () => {
    const rpcError = new ScriptedTransport((message, t) => {
      if (message.method === "initialize") t.rejectRpc(message.id, -32601, "no experimentalApi");
    });
    await expect(runWithTransport(rpcError)).rejects.toThrow(
      /codex initialize JSON-RPC error -32601: no experimentalApi/,
    );

    const malformed = new ScriptedTransport((_message, t) => t.raw("not json"));
    await expect(runWithTransport(malformed)).rejects.toThrow(/malformed JSON-RPC message/);

    const wrongVersion = new ScriptedTransport((_message, t) =>
      t.raw(JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} })),
    );
    await expect(runWithTransport(wrongVersion)).rejects.toThrow(/malformed JSON-RPC message/);

    const empty = new ScriptedTransport((_message, t) => t.raw(JSON.stringify({})));
    await expect(runWithTransport(empty)).rejects.toThrow(/malformed JSON-RPC message/);
  });

  test("thread/start must return thread.id even if notifications mention ids", async () => {
    const missingThreadId = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.notify("thread/started", { thread: { id: "thread-from-notification" } });
          t.respond(message.id, { thread: {} });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });
    await expect(runWithTransport(missingThreadId)).rejects.toThrow(
      /thread\/start did not return thread\.id/,
    );

    const topLevelThreadId = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { threadId: "thread-1" });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });
    await expect(runWithTransport(topLevelThreadId)).rejects.toThrow(
      /thread\/start did not return thread\.id/,
    );
  });

  test("turn/start can use turn/started notification id when the RPC result is only an ack", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.notify("turn/started", {
            threadId: "thread-1",
            turn: { id: "turn-from-notification" },
          });
          t.respond(message.id, { turn: {} });
          t.notify("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "turn-from-notification",
            delta: "notification id ok",
          });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-from-notification", status: "completed" },
          });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const { result } = await runWithTransport(transport);
    expect(result.text).toBe("notification id ok");
  });

  test("turn/start rejects when neither result nor notification provides turn.id", async () => {
    const topLevelTurnId = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turnId: "turn-1" });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });
    await expect(runWithTransport(topLevelTurnId)).rejects.toThrow(
      /turn\/start did not return turn\.id/,
    );
  });

  test("turn/started ignores alternate id shapes when the RPC result is only an ack", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.notify("turn/started", { threadId: "thread-1", turnId: "turn-1" });
          t.notify("turn/started", { threadId: "thread-1", id: "turn-1" });
          t.respond(message.id, { turn: {} });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const provider = new CodexProvider({
      transportFactory: new ScriptedFactory(transport),
      rpcTimeoutMs: 20,
      turnTimeoutMs: 20,
    });
    await expect(provider.generate(codexInvocation(), {})).rejects.toThrow(
      /turn\/start did not return turn\.id/,
    );
  });

  test("current turn ignores unscoped and alternate notification shapes", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          t.notify("error", { message: "unscoped error" });
          t.notify("error", {
            threadId: "thread-1",
            turn: { id: "turn-1" },
            message: "alternate error",
          });
          t.notify("item/agentMessage/delta", { delta: "unscoped" });
          t.notify("item/agentMessage/delta", {
            threadId: "thread-1",
            turn: { id: "turn-1" },
            delta: "alternate",
          });
          t.notify("item/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1" },
            item: { id: "bad", type: "agentMessage", text: "bad" },
          });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "other-turn", status: "completed" },
          });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "completed",
          });
          t.notify("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "turn-1",
            delta: "good",
          });
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed" },
          });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const { result, events } = await runWithTransport(transport);
    expect(result.text).toBe("good");
    expect(events.filter((event) => event.type === "text").map((event) => event.data)).toEqual([
      "good",
    ]);
    expect(
      events
        .filter((event) => event.type === "error")
        .map((event) => event.data as Record<string, unknown>)
        .map((data) => ({
          message: data.message,
          method: data.method,
          reason: data.reason,
          expectedTurnId: data.expectedTurnId,
          observedTurnId: data.observedTurnId,
        })),
    ).toEqual([
      {
        message: "codex ignored error notification: missing-turn-id",
        method: "error",
        reason: "missing-turn-id",
        expectedTurnId: "turn-1",
        observedTurnId: undefined,
      },
      {
        message: "codex ignored turn/completed notification: turn-id-mismatch",
        method: "turn/completed",
        reason: "turn-id-mismatch",
        expectedTurnId: "turn-1",
        observedTurnId: "other-turn",
      },
      {
        message: "codex ignored turn/completed notification: missing-turn-id",
        method: "turn/completed",
        reason: "missing-turn-id",
        expectedTurnId: "turn-1",
        observedTurnId: undefined,
      },
    ]);
  });

  test("transport close before terminal response rejects with the close diagnostic", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          queueMicrotask(() =>
            t.fail(
              new Error(
                "codex stdio transport closed before terminal response (exit 7); stderr: boom",
              ),
            ),
          );
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    await expect(runWithTransport(transport)).rejects.toThrow(/stderr: boom/);
  });

  test("malformed protocol after turn/start rejects instead of hanging", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          t.raw("not json");
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    await expect(runWithTransport(transport)).rejects.toThrow(/malformed JSON-RPC message/);
  });

  test("abort sends turn/interrupt and closes the transport", async () => {
    let resolveTurnStart!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      resolveTurnStart = resolve;
    });
    const controller = new AbortController();
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          queueMicrotask(resolveTurnStart);
          break;
        case "turn/interrupt":
          t.respond(message.id, {});
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "interrupted" },
          });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const promise = runWithTransport(transport, { abortSignal: controller.signal });
    await turnStarted;
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/);
    expect(transport.sent.map((m) => m.method)).toContain("turn/interrupt");
    expect(transport.closed).toBe(true);
  });

  test("unconfirmed stdio abort reports that the owned child was terminated", async () => {
    let resolveTurnStart!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      resolveTurnStart = resolve;
    });
    const controller = new AbortController();
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          queueMicrotask(resolveTurnStart);
          break;
        case "turn/interrupt":
          t.respond(message.id, {});
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });
    const provider = new CodexProvider({
      transportFactory: new ScriptedFactory(transport),
      rpcTimeoutMs: 5_000,
      turnTimeoutMs: 5_000,
    });

    const promise = provider.generate(codexInvocation({ abortSignal: controller.signal }), {});
    await turnStarted;
    controller.abort();
    await expect(promise).rejects.toThrow(/owned stdio app-server child was terminated/);
    expect(transport.closed).toBe(true);
  });

  test("raw log is opt-in JSONL", async () => {
    const dir = tempDir("keel-codex-log-");
    const rawLogPath = join(dir, "codex.jsonl");
    const transport = new ScriptedTransport(basicScript);
    await new CodexProvider({
      transportFactory: new ScriptedFactory(transport),
      rawLogPath,
      rpcTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
    }).generate(codexInvocation(), {});

    const lines = readFileSync(rawLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.some((line) => line.stream === "send")).toBe(true);
    expect(lines.some((line) => line.stream === "recv")).toBe(true);
    expect(lines.some((line) => line.data?.descriptor === "fake")).toBe(true);
  });

  test("connect timeout override is independent from RPC response timeout", async () => {
    const transport = new ScriptedTransport(basicScript);
    const factory = new ScriptedFactory(transport);
    await new CodexProvider({
      transportFactory: factory,
      rpcTimeoutMs: 1_234,
      turnTimeoutMs: 1_234,
      connectTimeoutMs: 55,
    }).generate(codexInvocation(), {});

    expect(factory.context?.connectTimeoutMs).toBe(55);
  });

  test("turn completion wait is independent from short RPC response timeout", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          t.notify("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "turn-1",
            delta: "slow ok",
          });
          setTimeout(() => {
            t.notify("turn/completed", {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed" },
            });
          }, 50);
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const result = await new CodexProvider({
      transportFactory: new ScriptedFactory(transport),
      rpcTimeoutMs: 10,
      turnTimeoutMs: 1_000,
    }).generate(codexInvocation(), {});

    expect(result.text).toBe("slow ok");
  });

  test("dedicated RPC timeout does not shorten the default turn completion wait", async () => {
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          t.notify("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "turn-1",
            delta: "slow default ok",
          });
          setTimeout(() => {
            t.notify("turn/completed", {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed" },
            });
          }, 50);
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    const result = await new CodexProvider({
      transportFactory: new ScriptedFactory(transport),
      rpcTimeoutMs: 10,
    }).generate(codexInvocation(), {});

    expect(result.text).toBe("slow default ok");
  });

  test("turn completion timeout interrupts the active remote turn before failing", async () => {
    let interrupted = false;
    const transport = new ScriptedTransport((message, t) => {
      switch (message.method) {
        case "initialize":
          t.respond(message.id, {});
          break;
        case "initialized":
          break;
        case "thread/start":
          t.respond(message.id, { thread: { id: "thread-1" } });
          break;
        case "turn/start":
          t.respond(message.id, { turn: { id: "turn-1" } });
          t.notify("turn/started", { threadId: "thread-1", turn: { id: "turn-1" } });
          break;
        case "turn/interrupt":
          interrupted = true;
          expect(message.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
          t.respond(message.id, {});
          t.notify("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "interrupted" },
          });
          break;
        default:
          throw new Error(`unexpected ${String(message.method)}`);
      }
    });

    await expect(
      new CodexProvider({
        transportFactory: new ScriptedFactory(transport),
        rpcTimeoutMs: 1_000,
        turnTimeoutMs: 20,
      }).generate(
        codexInvocation({ providerConfig: { transport: { type: "uds", path: "/x" } } }),
        {},
      ),
    ).rejects.toThrow(/turn\/completed was not received after 20ms/);

    expect(interrupted).toBe(true);
    expect(transport.closed).toBe(true);
  });
});

describe("Codex transports", () => {
  test("stdio spawns codex app-server in invocation cwd with env", async () => {
    const dir = tempDir("keel-codex-stdio-");
    const bin = join(dir, "fake-codex");
    const logPath = join(dir, "stdio-log.jsonl");
    writeFileSync(
      bin,
      `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs";\nconst log = process.env.FAKE_CODEX_LOG;\nfunction record(value) { appendFileSync(log, JSON.stringify(value) + "\\n"); }\nrecord({ argv: process.argv.slice(2), cwd: process.cwd(), secret: process.env.CODEX_TEST_SECRET });\nconst dec = new TextDecoder();\nlet buf = "";\nfunction send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }\nfunction handle(line) {\n  const msg = JSON.parse(line);\n  record({ method: msg.method, params: msg.params });\n  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: {} });\n  else if (msg.method === "thread/start") send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "stdio-thread" } } });\n  else if (msg.method === "turn/start") {\n    send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: "stdio-turn" } } });\n    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "stdio-thread", turn: { id: "stdio-turn" } } });\n    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "stdio-thread", turnId: "stdio-turn", delta: "stdio ok" } });\n    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "stdio-thread", turn: { id: "stdio-turn", status: "completed" } } });\n  }\n}\nfor await (const chunk of Bun.stdin.stream()) {\n  buf += dec.decode(chunk, { stream: true });\n  let nl = buf.indexOf("\\n");\n  while (nl >= 0) {\n    const line = buf.slice(0, nl).trim();\n    buf = buf.slice(nl + 1);\n    if (line) handle(line);\n    nl = buf.indexOf("\\n");\n  }\n}\n`,
    );
    chmodSync(bin, 0o755);

    const result = await new CodexProvider({
      bin,
      rpcTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
    }).generate(
      codexInvocation({ env: { FAKE_CODEX_LOG: logPath, CODEX_TEST_SECRET: "secret-value" } }),
      {},
    );

    expect(result.text).toBe("stdio ok");
    expect(result.sessionToken).toBe("stdio-thread");
    const records = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      argv: ["app-server"],
      cwd: process.cwd(),
      secret: "secret-value",
    });
    expect(records.map((r) => r.method).filter(Boolean)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
  });

  test("ws connects to a fake app-server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        message(ws, message) {
          const msg = JSON.parse(String(message)) as Record<string, unknown>;
          scriptedRpcReply((frame) => ws.send(frame), msg, "ws-thread", "ws ok");
        },
      },
    });
    try {
      const url = new URL(server.url);
      url.protocol = "ws:";
      const result = await new CodexProvider({
        rpcTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
        connectTimeoutMs: 1_000,
      }).generate(
        codexInvocation({ providerConfig: { transport: { type: "ws", url: url.toString() } } }),
        {},
      );
      expect(result.text).toBe("ws ok");
      expect(result.sessionToken).toBe("ws-thread");
    } finally {
      server.stop(true);
    }
  });

  test("uds connects with WebSocket-over-Unix-socket handshake", async () => {
    const dir = tempDir("keel-codex-uds-");
    const socketPath = join(dir, "codex.sock");
    const server = await startUdsWebSocketServer(socketPath);
    try {
      const result = await new CodexProvider({
        rpcTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
        connectTimeoutMs: 1_000,
      }).generate(
        codexInvocation({ providerConfig: { transport: { type: "uds", path: socketPath } } }),
        {},
      );
      expect(result.text).toBe("uds ok");
      expect(result.sessionToken).toBe("uds-thread");
      expect(server.handshake).toContain("GET /rpc HTTP/1.1");
      expect(server.handshake).toContain("Host: localhost");
    } finally {
      await server.close();
    }
  });

  test("remote transports reject secret env rather than dropping it", async () => {
    const transport = new ScriptedTransport(basicScript);
    await expect(
      new CodexProvider({
        transportFactory: new ScriptedFactory(transport),
        rpcTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
      }).generate(
        codexInvocation({
          providerConfig: { transport: { type: "ws", url: "ws://127.0.0.1:1" } },
          env: { TOKEN: "secret" },
        }),
        {},
      ),
    ).rejects.toThrow(/cannot receive secret env/);
  });
});

function scriptedRpcReply(
  send: (frame: string) => void,
  msg: Record<string, unknown>,
  threadId: string,
  text: string,
): void {
  switch (msg.method) {
    case "initialize":
      send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      break;
    case "initialized":
      break;
    case "thread/start":
      send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId } } }));
      break;
    case "turn/start":
      send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { turn: { id: `${threadId}-turn` } },
        }),
      );
      send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "turn/started",
          params: { threadId, turn: { id: `${threadId}-turn` } },
        }),
      );
      send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: { threadId, turnId: `${threadId}-turn`, delta: text },
        }),
      );
      send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "turn/completed",
          params: { threadId, turn: { id: `${threadId}-turn`, status: "completed" } },
        }),
      );
      break;
    default:
      throw new Error(`unexpected method ${String(msg.method)}`);
  }
}

async function startUdsWebSocketServer(path: string): Promise<{
  handshake: string;
  close: () => Promise<void>;
}> {
  try {
    unlinkSync(path);
  } catch {
    // no stale socket
  }
  let handshake = "";
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      buffer = Buffer.concat([buffer, data]);
      if (!upgraded) {
        const split = buffer.indexOf("\r\n\r\n");
        if (split < 0) return;
        handshake = buffer.slice(0, split).toString("utf8");
        const key = /Sec-WebSocket-Key:\s*(.+)/i.exec(handshake)?.[1]?.trim() ?? "";
        const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
          ].join("\r\n"),
        );
        upgraded = true;
        buffer = buffer.slice(split + 4);
      }
      while (true) {
        const frame = decodeTestFrame(buffer);
        if (!frame) break;
        buffer = buffer.slice(frame.bytesRead);
        if (frame.opcode !== 0x1) continue;
        const msg = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
        scriptedRpcReply(
          (value) => socket.write(encodeTestFrame(value)),
          msg,
          "uds-thread",
          "uds ok",
        );
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    get handshake() {
      return handshake;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}

function decodeTestFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; bytesRead: number } | null {
  if (buffer.length < 2) return null;
  const first = buffer[0] as number;
  const second = buffer[1] as number;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = buffer.readUInt32BE(6);
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (masked) {
    const mask = buffer.slice(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i++)
      payload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
  }
  return { opcode, payload, bytesRead: offset + length };
}

function encodeTestFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(payload.length, 6);
  return Buffer.concat([header, payload]);
}

// ---- LIVE smoke (configured real Codex app-server). Gated: KEEL_LIVE=1 bun test ----

const LIVE = process.env.KEEL_LIVE === "1";
describe.if(LIVE)("LIVE codex smoke", () => {
  test("a real configured Codex agent produces structured output", async () => {
    const { executeAgent } = await import("./execute.ts");
    const dir = tempDir("keel-live-codex-agent-");
    const provider = new CodexProvider({ rpcTimeoutMs: 120_000, turnTimeoutMs: 120_000 });
    const tokens: string[] = [];
    const exec = await executeAgent(
      provider,
      {
        key: "live-codex-1",
        provider: "codex",
        prompt: 'Return ONLY this JSON and nothing else: {"value": 42}',
        toolPolicy: "unrestricted",
        cwd: dir,
      },
      { onSessionToken: (t) => tokens.push(t) },
      {
        maxRetries: 0,
        jsonSchema: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "number" } },
        },
      },
    );

    expect(exec.output).toEqual({ value: 42 });
    expect(tokens.length).toBe(1);
    expect(exec.sessionToken).toBeTruthy();
  }, 130_000);

  test("a small real Codex run through the daemon completes and replays on resume", async () => {
    const { KeelDaemon } = await import("../daemon/server.ts");
    const { DaemonClient } = await import("../daemon/client.ts");
    const { AgentProviderRegistry } = await import("./types.ts");
    const liveUrl = captureWorkflowFile(
      new URL("../kernel/realm/fixtures/agent-live-codex.workflow.ts", import.meta.url).pathname,
    );
    const dir = tempDir("keel-live-codex-daemon-");
    const socketPath = join(dir, "keel.sock");
    const dbPath = join(dir, "keel.db");
    const target = join(dir, "target");
    writeFileSync(join(dir, "target-marker"), "");
    mkdirSync(target, { recursive: true });
    const inner = new CodexProvider({ rpcTimeoutMs: 120_000, turnTimeoutMs: 120_000 });
    let calls = 0;
    const provider: AgentProvider = {
      name: "codex",
      supportsSessions: true,
      generate(invocation, hooks) {
        calls++;
        return inner.generate(invocation, hooks);
      },
    };
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(provider),
    });
    await daemon.start();
    let client: InstanceType<typeof DaemonClient> | null = null;
    try {
      client = await DaemonClient.connect(socketPath);
      const { runId, capability } = await client.launchRun({
        ...liveUrl,
        input: null,
        name: "live-codex",
        target,
      });
      await client.authenticate(capability as string);
      const outcome = await client.waitForRun(runId);
      expect(outcome.status).toBe("finished");
      expect(outcome.output).toBe(12);
      expect(calls).toBe(2);

      await client.resumeRun(runId);
      const replay = await client.waitForRun(runId);
      expect(replay.status).toBe("finished");
      expect(replay.output).toBe(12);
      expect(calls).toBe(2);
    } finally {
      client?.close();
      daemon.stop();
    }
  }, 260_000);
});
