import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { type Socket, createConnection } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { resolveInvocationToolPolicy, resolvedToolPolicyToCodexParams } from "./capabilities.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./defaults.ts";
import { ProviderConfigValidationError } from "./provider-config.ts";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
  ProviderConfigValue,
  TraceEvent,
} from "./types.ts";

export const CODEX_BIN_ENV = "KEEL_CODEX_BIN";
export const CODEX_RAW_LOG_ENV = "KEEL_CODEX_RAW_LOG";
export const CODEX_CONNECT_TIMEOUT_MS = 15_000;
export const CODEX_RPC_RESPONSE_TIMEOUT_MS = 60_000;
export const CODEX_TURN_COMPLETION_TIMEOUT_MS = DEFAULT_AGENT_TIMEOUT_MS;
export const CODEX_CLOSE_GRACE_MS = 1_000;
export const CODEX_INTERRUPT_CONFIRM_MS = 2_000;
export const CODEX_DEFAULT_TRANSPORT = Object.freeze({ type: "stdio" as const });

const CODEX_CLIENT_INFO = Object.freeze({ name: "keel", title: "Keel", version: "0.0.0" });
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const STDERR_TAIL_BYTES = 4_000;

export type CodexTransportConfig =
  | { type: "stdio" }
  | { type: "ws"; url: string }
  | { type: "uds"; path: string };

export interface CodexProviderOptions {
  bin?: string;
  /** Per-request protocol timeout for setup/handshake RPCs. */
  timeoutMs?: number;
  /** Long-running model turn timeout; defaults to Keel's normal agent timeout. */
  turnTimeoutMs?: number;
  connectTimeoutMs?: number;
  rawLogPath?: string;
  transportFactory?: CodexTransportFactory;
}

export interface CodexTransportContext {
  bin: string;
  cwd: string;
  env: Record<string, string | undefined>;
  connectTimeoutMs: number;
  rawLog: (stream: CodexRawLogStream, data: unknown) => void;
}

export type CodexRawLogStream = "transport" | "spawn" | "send" | "recv" | "stderr" | "close";

export interface CodexTransport {
  readonly descriptor: string;
  send(frame: string): void | Promise<void>;
  close(): void | Promise<void>;
  onMessage(callback: (frame: string) => void): void;
  onStderr(callback: (text: string) => void): void;
  onClose(callback: (error?: Error) => void): void;
}

export interface CodexTransportFactory {
  open(config: CodexTransportConfig, context: CodexTransportContext): Promise<CodexTransport>;
}

export class CodexProvider implements AgentProvider {
  readonly name = "codex";
  readonly supportsSessions = true;
  private readonly bin: string;
  private readonly rpcTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly rawLogPath?: string;
  private readonly transportFactory: CodexTransportFactory;

  constructor(opts: CodexProviderOptions = {}) {
    this.bin = opts.bin ?? process.env[CODEX_BIN_ENV] ?? "codex";
    this.rpcTimeoutMs = opts.timeoutMs ?? CODEX_RPC_RESPONSE_TIMEOUT_MS;
    // Keep opts.timeoutMs as a legacy/test single-knob override, but production
    // callers should use turnTimeoutMs when tuning long-running model turns.
    this.turnTimeoutMs = opts.turnTimeoutMs ?? opts.timeoutMs ?? CODEX_TURN_COMPLETION_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CODEX_CONNECT_TIMEOUT_MS;
    this.rawLogPath = opts.rawLogPath ?? process.env[CODEX_RAW_LOG_ENV];
    this.transportFactory = opts.transportFactory ?? new DefaultCodexTransportFactory();
  }

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    const config = normalizeCodexProviderConfig(invocation.providerConfig);
    const resolved = resolveInvocationToolPolicy({
      ...(invocation.capabilities ? { capabilities: invocation.capabilities } : {}),
      ...(invocation.toolPolicy ? { toolPolicy: invocation.toolPolicy } : {}),
      ...(invocation.allowTools ? { allowTools: invocation.allowTools } : {}),
      ...(invocation.denyTools ? { denyTools: invocation.denyTools } : {}),
    });
    const codexCaps = resolvedToolPolicyToCodexParams(resolved, invocation.cwd);
    const cwd = invocation.cwd as string;
    if (config.type !== "stdio" && Object.keys(invocation.env ?? {}).length > 0) {
      throw new Error(
        `codex ${transportDescriptor(config)} transport cannot receive secret env values; first-cut Codex env injection is supported only for stdio`,
      );
    }

    if (invocation.abortSignal?.aborted) {
      throw new Error(`codex agent "${invocation.key}" aborted`);
    }

    const rawLog = (stream: CodexRawLogStream, data: unknown): void => {
      this.rawLog(invocation.key, stream, data);
    };
    rawLog("transport", { descriptor: transportDescriptor(config), config });
    const transportContext = {
      bin: this.bin,
      cwd,
      env: { ...process.env, ...(invocation.env ?? {}) },
      connectTimeoutMs: this.connectTimeoutMs,
      rawLog,
    };
    let abortedDuringOpen = false;
    let removeOpenAbort = (): void => {};
    const openAbort = invocation.abortSignal
      ? new Promise<never>((_, reject) => {
          const onOpenAbort = (): void => {
            abortedDuringOpen = true;
            reject(new Error(`codex agent "${invocation.key}" aborted`));
          };
          invocation.abortSignal?.addEventListener("abort", onOpenAbort, { once: true });
          removeOpenAbort = () => invocation.abortSignal?.removeEventListener("abort", onOpenAbort);
        })
      : null;
    const openTransport = this.transportFactory.open(config, transportContext);
    void openTransport.then(
      (opened) => {
        if (abortedDuringOpen) void opened.close();
      },
      () => {},
    );
    let transport: CodexTransport;
    try {
      transport = await (openAbort ? Promise.race([openTransport, openAbort]) : openTransport);
    } finally {
      removeOpenAbort();
    }
    if (invocation.abortSignal?.aborted) {
      await transport.close();
      throw new Error(`codex agent "${invocation.key}" aborted`);
    }

    const transcript: TraceEvent[] = [];
    const state: CodexCallState = {
      streamedText: "",
      completedTexts: [],
      terminal: null,
      latestScopedError: null,
      turnInFlight: false,
      aborting: false,
      ignoredTurnIds: new Set(),
    };
    let turnStartedResolve: () => void = () => {};
    let turnStartedReject: (err: Error) => void = () => {};
    let turnTerminalResolve: (terminal: CodexTurnTerminal) => void = () => {};
    let turnTerminalReject: (err: Error) => void = () => {};
    let turnStarted!: Promise<void>;
    let turnTerminal!: Promise<CodexTurnTerminal>;
    const resetTurnWaiters = (): void => {
      turnStarted = new Promise<void>((resolve, reject) => {
        turnStartedResolve = resolve;
        turnStartedReject = reject;
      });
      turnTerminal = new Promise<CodexTurnTerminal>((resolve, reject) => {
        turnTerminalResolve = resolve;
        turnTerminalReject = reject;
      });
      turnStarted.catch(() => {});
      turnTerminal.catch(() => {});
    };
    resetTurnWaiters();

    const emit = (event: TraceEvent): void => {
      transcript.push(event);
      hooks.onEvent?.(event);
    };
    const noteSessionToken = (token: string): void => {
      state.threadId = token;
      hooks.onSessionToken?.(token);
      emit({ type: "session", data: token });
    };

    const client = new CodexRpcClient(transport, {
      timeoutMs: this.rpcTimeoutMs,
      rawLog,
      onNotification: (method, params) => {
        try {
          handleCodexNotification(method, params, state, emit, (terminal) => {
            turnTerminalResolve(terminal);
          });
          if (state.turnId) turnStartedResolve();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          turnStartedReject(error);
          turnTerminalReject(error);
          client.fail(error);
        }
      },
      onFailure: (error) => {
        turnStartedReject(error);
        turnTerminalReject(error);
      },
    });

    let abortReject: ((err: Error) => void) | null = null;
    let abortStarted = false;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    const rejectForAbort = (err: Error): void => abortReject?.(err);
    const onAbort = (): void => {
      if (abortStarted) return;
      abortStarted = true;
      void handleAbort({
        state,
        client,
        transport,
        emit,
        invocation,
        transportType: config.type,
      }).then(
        () => rejectForAbort(new Error(`codex agent "${invocation.key}" aborted`)),
        (err) => rejectForAbort(err instanceof Error ? err : new Error(String(err))),
      );
    };
    invocation.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (invocation.abortSignal?.aborted) onAbort();

    const raceAbort = async <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, abortPromise]);

    try {
      await raceAbort(
        client.request("initialize", {
          clientInfo: CODEX_CLIENT_INFO,
          capabilities: { experimentalApi: true },
        }),
      );
      await raceAbort(client.notify("initialized"));

      if (invocation.resumeToken) {
        await raceAbort(
          resumeThread(client, invocation, codexCaps.thread, state, resetTurnWaiters),
        );
        noteSessionToken(invocation.resumeToken);
      } else {
        const startResult = await raceAbort(
          client.request("thread/start", {
            cwd,
            ...(invocation.model ? { model: invocation.model } : {}),
            ...(invocation.reasoning ? { reasoning: invocation.reasoning } : {}),
            ...codexCaps.thread,
          }),
        );
        const threadId = requiredThreadIdFromResult(startResult);
        if (!threadId) throw new Error("codex: thread/start did not return thread.id");
        if (state.threadId && state.threadId !== threadId) {
          throw new Error(
            `codex thread/start notification id mismatch: expected ${threadId}, got ${state.threadId}`,
          );
        }
        noteSessionToken(threadId);
      }

      state.turnInFlight = true;
      const turnResult = await raceAbort(
        client.request("turn/start", {
          threadId: state.threadId,
          input: [{ type: "text", text: invocation.prompt }],
          ...codexCaps.turn,
        }),
      );
      const resultTurnId = requiredTurnIdFromResult(turnResult);
      if (resultTurnId && state.turnId && state.turnId !== resultTurnId) {
        throw new Error(
          `codex turn/start notification id mismatch: expected ${resultTurnId}, got ${state.turnId}`,
        );
      }
      if (resultTurnId) {
        state.turnId = resultTurnId;
      } else if (!state.turnId) {
        await raceAbort(
          timeoutPromise(
            turnStarted,
            this.rpcTimeoutMs,
            "codex: turn/start did not return turn.id",
          ),
        );
      }
      if (!state.turnId) throw new Error("codex: turn/start did not return turn.id");
      turnStartedResolve();

      const turnTimeoutMs = invocation.timeoutMs ?? this.turnTimeoutMs;
      const terminal = await raceAbort(
        timeoutPromise(turnTerminal, turnTimeoutMs, "codex: turn/completed was not received"),
      );
      state.turnInFlight = false;
      const finalText = finalizeCodexTurn(terminal, state, invocation.key);
      await transport.close();
      return { text: finalText, transcript, sessionToken: state.threadId };
    } catch (err) {
      if (!abortStarted && state.turnInFlight) {
        await interruptActiveTurnAfterFailure({
          state,
          client,
          transport,
          emit,
          transportType: config.type,
        });
      }
      throw err;
    } finally {
      invocation.abortSignal?.removeEventListener("abort", onAbort);
      await client.close();
      await transport.close();
    }
  }

  private rawLog(key: string, stream: CodexRawLogStream, data: unknown): void {
    if (!this.rawLogPath) return;
    try {
      mkdirSync(dirname(this.rawLogPath), { recursive: true });
      appendFileSync(
        this.rawLogPath,
        `${JSON.stringify({ at: new Date().toISOString(), key, stream, data })}\n`,
      );
    } catch {
      // Diagnostic logging must never change provider behavior.
    }
  }
}

export function normalizeCodexProviderConfig(
  value: ProviderConfigValue | undefined,
): CodexTransportConfig {
  if (value === undefined) return { ...CODEX_DEFAULT_TRANSPORT };
  if (!isPlainObject(value)) {
    throw invalidConfig("providerConfig.codex must be a plain JSON object");
  }
  rejectUnknownKeys(value, ["transport"], "providerConfig.codex");
  if (!hasOwn(value, "transport")) {
    throw invalidConfig("providerConfig.codex.transport is required");
  }
  const transport = value.transport;
  if (!isPlainObject(transport)) {
    throw invalidConfig("providerConfig.codex.transport must be a plain JSON object");
  }
  const type = transport.type;
  if (type !== "stdio" && type !== "ws" && type !== "uds") {
    throw invalidConfig(
      'providerConfig.codex.transport.type must be exactly "stdio", "ws", or "uds"',
    );
  }
  if (type === "stdio") {
    rejectUnknownKeys(transport, ["type"], "providerConfig.codex.transport");
    return { type: "stdio" };
  }
  if (type === "ws") {
    rejectUnknownKeys(transport, ["type", "url"], "providerConfig.codex.transport");
    if (typeof transport.url !== "string" || transport.url.trim().length === 0) {
      throw invalidConfig(
        "providerConfig.codex.transport.url must be a non-empty ws:// or wss:// URL",
      );
    }
    let url: URL;
    try {
      url = new URL(transport.url);
    } catch (err) {
      throw invalidConfig(
        `providerConfig.codex.transport.url must be an absolute ws:// or wss:// URL: ${String(err)}`,
      );
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw invalidConfig("providerConfig.codex.transport.url must use ws:// or wss://");
    }
    if (url.username || url.password) {
      throw invalidConfig("providerConfig.codex.transport.url must not include credentials");
    }
    return { type: "ws", url: url.toString() };
  }

  rejectUnknownKeys(transport, ["type", "path"], "providerConfig.codex.transport");
  if (typeof transport.path !== "string" || transport.path.trim().length === 0) {
    throw invalidConfig("providerConfig.codex.transport.path must be a non-empty absolute path");
  }
  if (!isAbsolute(transport.path)) {
    throw invalidConfig("providerConfig.codex.transport.path must be an absolute filesystem path");
  }
  return { type: "uds", path: transport.path };
}

class DefaultCodexTransportFactory implements CodexTransportFactory {
  async open(
    config: CodexTransportConfig,
    context: CodexTransportContext,
  ): Promise<CodexTransport> {
    switch (config.type) {
      case "stdio":
        return openStdioTransport(context);
      case "ws":
        return openWebSocketTransport(config, context);
      case "uds":
        return openWebSocketTransport(config, context);
    }
  }
}

async function openStdioTransport(context: CodexTransportContext): Promise<CodexTransport> {
  return new Promise((resolve, reject) => {
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      context.rawLog("spawn", { bin: context.bin, args: ["app-server"], cwd: context.cwd });
      proc = Bun.spawn([context.bin, "app-server"], {
        cwd: context.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: context.env,
      });
    } catch (err) {
      reject(
        new Error(
          `codex failed to spawn ${context.bin} app-server in ${context.cwd}: ${errorMessage(err)}`,
        ),
      );
      return;
    }
    resolve(new StdioCodexTransport(proc, context));
  });
}

class StdioCodexTransport implements CodexTransport {
  readonly descriptor: string;
  private messageCallback: ((frame: string) => void) | null = null;
  private stderrCallback: ((text: string) => void) | null = null;
  private closeCallback: ((error?: Error) => void) | null = null;
  private closed = false;
  private stderrTail = "";

  constructor(
    private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly context: CodexTransportContext,
  ) {
    this.descriptor = `stdio:${context.bin}`;
    this.startReaders();
  }

  send(frame: string): void {
    this.context.rawLog("send", { descriptor: this.descriptor, frame });
    this.proc.stdin.write(`${frame}\n`);
    this.proc.stdin.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.context.rawLog("close", { descriptor: this.descriptor, action: "stdin.end" });
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    const exited = await Promise.race([
      this.proc.exited.then((code) => ({ code })),
      Bun.sleep(CODEX_CLOSE_GRACE_MS).then(() => null),
    ]);
    if (exited !== null) return;
    try {
      this.context.rawLog("close", { descriptor: this.descriptor, action: "SIGINT" });
      this.proc.kill("SIGINT");
    } catch {
      // already exited
    }
    const interrupted = await Promise.race([
      this.proc.exited.then((code) => ({ code })),
      Bun.sleep(CODEX_CLOSE_GRACE_MS).then(() => null),
    ]);
    if (interrupted !== null) return;
    try {
      this.context.rawLog("close", { descriptor: this.descriptor, action: "SIGKILL" });
      this.proc.kill("SIGKILL");
    } catch {
      // already exited
    }
    await Promise.race([this.proc.exited, Bun.sleep(100)]);
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

  private startReaders(): void {
    void (async () => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of this.proc.stdout) {
          buf += dec.decode(chunk as Uint8Array, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) this.messageCallback?.(line);
            nl = buf.indexOf("\n");
          }
        }
        const tailLine = buf.trim();
        if (tailLine) this.messageCallback?.(tailLine);
      } catch (err) {
        this.closeCallback?.(new Error(`codex stdio stdout failed: ${errorMessage(err)}`));
      }
    })();

    void (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of this.proc.stderr) {
          const text = dec.decode(chunk as Uint8Array, { stream: true });
          this.stderrTail = tail(`${this.stderrTail}${text}`, STDERR_TAIL_BYTES);
          this.context.rawLog("stderr", { descriptor: this.descriptor, text });
          this.stderrCallback?.(text);
        }
      } catch {
        // stderr diagnostics are best-effort.
      }
    })();

    void this.proc.exited.then((code) => {
      if (this.closed) return;
      const suffix = this.stderrTail.trim() ? `; stderr: ${this.stderrTail.trim()}` : "";
      this.closeCallback?.(
        new Error(`codex stdio transport closed before terminal response (exit ${code})${suffix}`),
      );
    });
  }
}

async function openWebSocketTransport(
  config: Extract<CodexTransportConfig, { type: "ws" | "uds" }>,
  context: CodexTransportContext,
): Promise<CodexTransport> {
  const descriptor = transportDescriptor(config);
  const client = new RawWebSocketCodexTransport(config, descriptor, context);
  await client.connect();
  return client;
}

class RawWebSocketCodexTransport implements CodexTransport {
  readonly descriptor: string;
  private socket: Socket | TLSSocket | null = null;
  private messageCallback: ((frame: string) => void) | null = null;
  private closeCallback: ((error?: Error) => void) | null = null;
  private connected = false;
  private closed = false;
  private buffer = Buffer.alloc(0);
  private fragmented: { opcode: number; chunks: Buffer[] } | null = null;

  constructor(
    private readonly config: Extract<CodexTransportConfig, { type: "ws" | "uds" }>,
    descriptor: string,
    private readonly context: CodexTransportContext,
  ) {
    this.descriptor = descriptor;
  }

  async connect(): Promise<void> {
    this.context.rawLog("transport", { descriptor: this.descriptor, action: "connect" });
    const key = randomBytes(16).toString("base64");
    const { socket, requestHost, requestPath, secure } = await this.openSocket();
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let header = Buffer.alloc(0);
      const timer = setTimeout(() => {
        fail(new Error(`codex ${this.descriptor} connection timed out during WebSocket handshake`));
      }, this.context.connectTimeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", fail);
        socket.off("close", onClose);
      };
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.destroy();
        } catch {
          // already closed
        }
        reject(err);
      };
      const onClose = (): void =>
        fail(new Error(`codex ${this.descriptor} closed during handshake`));
      const onData = (chunk: Buffer): void => {
        header = Buffer.concat([header, chunk]);
        const split = header.indexOf("\r\n\r\n");
        if (split < 0) return;
        const head = header.slice(0, split).toString("utf8");
        const rest = header.slice(split + 4);
        try {
          validateWebSocketHandshake(head, key, this.descriptor);
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        settled = true;
        cleanup();
        this.connected = true;
        this.attachSocket(socket);
        if (rest.length > 0) this.handleData(rest);
        resolve();
      };
      socket.on("data", onData);
      socket.on("error", fail);
      socket.on("close", onClose);
      const request = [
        `GET ${requestPath} HTTP/1.1`,
        `Host: ${requestHost}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n");
      this.context.rawLog("send", { descriptor: this.descriptor, handshake: request, secure });
      socket.write(request);
    });
  }

  send(frame: string): void {
    if (!this.socket || !this.connected || this.closed) {
      throw new Error(`codex ${this.descriptor} transport is not connected`);
    }
    this.context.rawLog("send", { descriptor: this.descriptor, frame });
    this.socket.write(encodeWebSocketFrame(Buffer.from(frame, "utf8"), 0x1));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    if (!socket) return;
    try {
      if (!socket.destroyed) socket.write(encodeWebSocketFrame(Buffer.alloc(0), 0x8));
    } catch {
      // ignore close frame write failures
    }
    socket.end();
    await Promise.race([
      new Promise<void>((resolve) => socket.once("close", () => resolve())),
      Bun.sleep(CODEX_CLOSE_GRACE_MS).then(() => undefined),
    ]);
    if (!socket.destroyed) socket.destroy();
  }

  onMessage(callback: (frame: string) => void): void {
    this.messageCallback = callback;
  }

  onStderr(_callback: (text: string) => void): void {
    // WebSocket transports have no stderr stream.
  }

  onClose(callback: (error?: Error) => void): void {
    this.closeCallback = callback;
  }

  private async openSocket(): Promise<{
    socket: Socket | TLSSocket;
    requestHost: string;
    requestPath: string;
    secure: boolean;
  }> {
    if (this.config.type === "uds") {
      const socketPath = this.config.path;
      const socket = await connectSocket(
        () => createConnection({ path: socketPath }),
        this.descriptor,
        this.context.connectTimeoutMs,
        false,
      );
      return { socket, requestHost: "localhost", requestPath: "/rpc", secure: false };
    }

    const url = new URL(this.config.url);
    const secure = url.protocol === "wss:";
    const host = url.hostname;
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    const path = `${url.pathname || "/"}${url.search}`;
    const socket = await connectSocket(
      () =>
        secure ? tlsConnect({ host, port, servername: host }) : createConnection({ host, port }),
      this.descriptor,
      this.context.connectTimeoutMs,
      secure,
    );
    return {
      socket,
      requestHost: url.port ? `${url.hostname}:${url.port}` : url.hostname,
      requestPath: path,
      secure,
    };
  }

  private attachSocket(socket: Socket | TLSSocket): void {
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (err) => {
      if (!this.closed)
        this.closeCallback?.(new Error(`codex ${this.descriptor} error: ${err.message}`));
    });
    socket.on("close", () => {
      if (!this.closed)
        this.closeCallback?.(new Error(`codex ${this.descriptor} connection closed`));
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (true) {
        const decoded = decodeWebSocketFrame(this.buffer);
        if (!decoded) return;
        this.buffer = this.buffer.slice(decoded.bytesRead);
        this.handleFrame(decoded);
      }
    } catch (err) {
      this.closeCallback?.(
        new Error(
          `codex ${this.descriptor} received malformed WebSocket frame: ${errorMessage(err)}`,
        ),
      );
      void this.close();
    }
  }

  private handleFrame(frame: DecodedWebSocketFrame): void {
    switch (frame.opcode) {
      case 0x0: {
        if (!this.fragmented) return;
        this.fragmented.chunks.push(frame.payload);
        if (frame.fin) {
          const full = Buffer.concat(this.fragmented.chunks);
          const opcode = this.fragmented.opcode;
          this.fragmented = null;
          if (opcode === 0x1) this.messageCallback?.(full.toString("utf8"));
        }
        break;
      }
      case 0x1:
        if (frame.fin) this.messageCallback?.(frame.payload.toString("utf8"));
        else this.fragmented = { opcode: frame.opcode, chunks: [frame.payload] };
        break;
      case 0x8:
        this.closeCallback?.(new Error(`codex ${this.descriptor} received close frame`));
        void this.close();
        break;
      case 0x9:
        this.socket?.write(encodeWebSocketFrame(frame.payload, 0xa));
        break;
      case 0xa:
        break;
      default:
        break;
    }
  }
}

class CodexRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;

  constructor(
    private readonly transport: CodexTransport,
    private readonly opts: {
      timeoutMs: number;
      rawLog: (stream: CodexRawLogStream, data: unknown) => void;
      onNotification: (method: string, params: unknown) => void;
      onFailure?: (error: Error) => void;
    },
  ) {
    transport.onMessage((frame) => this.handleFrame(frame));
    transport.onClose((err) => this.fail(err ?? new Error(`codex ${transport.descriptor} closed`)));
    transport.onStderr((text) => opts.rawLog("stderr", { descriptor: transport.descriptor, text }));
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs = this.opts.timeoutMs,
  ): Promise<unknown> {
    if (this.closed) throw new Error(`codex ${this.transport.descriptor} transport is closed`);
    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `codex ${this.transport.descriptor} request ${method} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    const frame = JSON.stringify(message);
    this.opts.rawLog("send", { descriptor: this.transport.descriptor, frame: message });
    try {
      await this.transport.send(frame);
    } catch (err) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
      }
      throw err;
    }
    return promise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new Error(`codex ${this.transport.descriptor} transport is closed`);
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.opts.rawLog("send", { descriptor: this.transport.descriptor, frame: message });
    await this.transport.send(JSON.stringify(message));
  }

  fail(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    this.opts.onFailure?.(error);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  async close(): Promise<void> {
    this.fail(new Error(`codex ${this.transport.descriptor} transport closed`));
  }

  private handleFrame(frame: string): void {
    this.opts.rawLog("recv", { descriptor: this.transport.descriptor, frame });
    let msg: unknown;
    try {
      msg = JSON.parse(frame);
    } catch (err) {
      const error = new Error(
        `codex ${this.transport.descriptor} emitted malformed JSON-RPC message: ${errorMessage(err)}`,
      );
      this.fail(error);
      void this.transport.close();
      return;
    }
    if (!isPlainObject(msg) || (hasOwn(msg, "jsonrpc") && msg.jsonrpc !== "2.0")) {
      const error = new Error(
        `codex ${this.transport.descriptor} emitted malformed JSON-RPC message`,
      );
      this.fail(error);
      void this.transport.close();
      return;
    }
    if (hasOwn(msg, "id")) {
      if (typeof msg.id !== "number") {
        const error = new Error(
          `codex ${this.transport.descriptor} emitted malformed JSON-RPC message`,
        );
        this.fail(error);
        void this.transport.close();
        return;
      }
      const id = msg.id;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (hasOwn(msg, "error")) {
        pending.reject(formatRpcError(pending.method, msg.error));
      } else if (hasOwn(msg, "result")) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(`codex ${pending.method} response missing result or error`));
      }
      return;
    }
    if (typeof msg.method === "string") {
      this.opts.onNotification(msg.method, hasOwn(msg, "params") ? msg.params : undefined);
      return;
    }
    const error = new Error(
      `codex ${this.transport.descriptor} emitted malformed JSON-RPC message`,
    );
    this.fail(error);
    void this.transport.close();
  }
}

interface CodexCallState {
  threadId?: string;
  turnId?: string;
  streamedText: string;
  completedTexts: string[];
  latestStreamItemId?: string;
  latestCompletedItemId?: string;
  terminal: CodexTurnTerminal | null;
  latestScopedError: string | null;
  turnInFlight: boolean;
  aborting: boolean;
  ignoredTurnIds: Set<string>;
}

interface CodexTurnTerminal {
  status: string;
  message?: string;
}

function handleCodexNotification(
  method: string,
  params: unknown,
  state: CodexCallState,
  emit: (event: TraceEvent) => void,
  onTerminal: (terminal: CodexTurnTerminal) => void,
): void {
  switch (method) {
    case "thread/started": {
      const threadId = extractThreadId(params);
      if (threadId && !state.threadId) state.threadId = threadId;
      break;
    }
    case "turn/started": {
      if (!matchesCurrentThread(params, state)) break;
      const turnId = extractTurnId(params);
      if (!turnId) break;
      if (state.ignoredTurnIds.has(turnId)) break;
      if (state.turnId && state.turnId !== turnId) {
        throw new Error(
          `codex turn/started notification id mismatch: expected ${state.turnId}, got ${turnId}`,
        );
      }
      state.turnId = turnId;
      break;
    }
    case "item/agentMessage/delta": {
      if (!matchesCurrentTurn(params, state)) break;
      const delta = stringAt(params, ["delta"]) ?? stringAt(params, ["item", "delta"]);
      if (!delta) break;
      const itemId = extractItemId(params);
      if (itemId && state.latestStreamItemId && state.latestStreamItemId !== itemId) {
        state.streamedText += "\n\n";
      }
      if (itemId) state.latestStreamItemId = itemId;
      state.streamedText += delta;
      emit({ type: "text", data: delta });
      break;
    }
    case "item/completed": {
      if (!matchesCurrentTurn(params, state)) break;
      const item = recordAt(params, ["item"]);
      if (!item) break;
      const type = stringAt(item, ["type"]);
      if (type !== "agentMessage" && type !== "agent_message") break;
      const text = completedItemText(item);
      if (!text) break;
      const itemId = extractItemId(params) ?? stringAt(item, ["id"]);
      if (itemId && state.latestCompletedItemId === itemId) {
        state.completedTexts[state.completedTexts.length - 1] = text;
      } else {
        state.completedTexts.push(text);
      }
      if (itemId) state.latestCompletedItemId = itemId;
      break;
    }
    case "error": {
      if (!errorAppliesToCurrentTurn(params, state)) break;
      emit({ type: "error", data: params });
      const message = bestErrorMessage(params);
      if (message) state.latestScopedError = message;
      break;
    }
    case "turn/completed": {
      if (!matchesCurrentTurn(params, state)) break;
      const turnId = extractTurnId(params);
      if (turnId && !state.turnId) state.turnId = turnId;
      const terminal = {
        status: terminalStatus(params) ?? "unknown",
        ...((terminalMessage(params) ?? state.latestScopedError)
          ? { message: terminalMessage(params) ?? state.latestScopedError ?? undefined }
          : {}),
      };
      state.terminal = terminal;
      onTerminal(terminal);
      break;
    }
    default:
      break;
  }
}

async function resumeThread(
  client: CodexRpcClient,
  invocation: AgentInvocation,
  threadParams: Record<string, unknown>,
  state: CodexCallState,
  resetTurnWaiters: () => void,
): Promise<void> {
  const token = invocation.resumeToken;
  if (!token) throw new Error("codex resume requires a thread id");
  state.threadId = token;
  const readResult = await client.request("thread/read", { threadId: token });
  const readThreadId = extractThreadId(readResult);
  if (readThreadId && readThreadId !== token) {
    throw new Error(`codex resumed thread id mismatch: expected ${token}, got ${readThreadId}`);
  }
  const thread = recordAt(readResult, ["thread"]);
  const observedCwd = thread ? stringAt(thread, ["cwd"]) : stringAt(readResult, ["cwd"]);
  if (observedCwd && observedCwd !== invocation.cwd) {
    throw new Error(
      `codex resumed thread cwd mismatch: expected ${invocation.cwd}, got ${observedCwd}`,
    );
  }
  let statusType = threadStatusType(readResult);
  if (statusType === "active") {
    const activeTurnId = await discoverActiveTurnId(client, token);
    if (!activeTurnId) {
      throw new Error(
        "codex resumed thread is active but no active remote turn id could be discovered",
      );
    }
    state.turnId = activeTurnId;
    state.turnInFlight = true;
    state.ignoredTurnIds.add(activeTurnId);
    let terminalStatus: string;
    try {
      terminalStatus = await interruptRemoteTurn(client, token, activeTurnId);
    } finally {
      state.turnInFlight = false;
      resetPerTurnState(state, activeTurnId);
      resetTurnWaiters();
    }
    if (terminalStatus !== "interrupted") {
      throw new Error(
        `codex resumed thread active turn ${activeTurnId} reached ${terminalStatus} before Keel could confirm interruption; manual reconciliation is required`,
      );
    }
    statusType = "idle";
  }
  if (statusType === "systemError") {
    throw new Error(
      `codex resumed thread is in systemError state: ${bestErrorMessage(readResult) ?? "unknown Codex system error"}`,
    );
  }
  if (statusType === "notLoaded") {
    throw new Error("codex resumed thread is notLoaded and cannot be resumed");
  }
  if (statusType && statusType !== "idle") {
    throw new Error(`codex resumed thread has unsupported status ${statusType}`);
  }
  if (!statusType) {
    throw new Error("codex resumed thread has unknown status");
  }

  const resumeResult = await client.request("thread/resume", {
    threadId: token,
    cwd: invocation.cwd,
    ...(invocation.model ? { model: invocation.model } : {}),
    ...(invocation.reasoning ? { reasoning: invocation.reasoning } : {}),
    ...threadParams,
  });
  const resumedThreadId = requiredThreadIdFromResult(resumeResult);
  if (!resumedThreadId) throw new Error("codex: thread/resume did not return thread.id");
  if (resumedThreadId !== token) {
    throw new Error(
      `codex thread/resume returned different thread id: expected ${token}, got ${resumedThreadId}`,
    );
  }
}

function resetPerTurnState(state: CodexCallState, ignoredTurnId?: string): void {
  if (ignoredTurnId) state.ignoredTurnIds.add(ignoredTurnId);
  state.turnId = undefined;
  state.streamedText = "";
  state.completedTexts = [];
  state.latestStreamItemId = undefined;
  state.latestCompletedItemId = undefined;
  state.latestScopedError = null;
  state.terminal = null;
}

async function discoverActiveTurnId(
  client: CodexRpcClient,
  threadId: string,
): Promise<string | null> {
  const result = await client.request("thread/turns/list", {
    threadId,
    limit: 20,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });
  const data = isPlainObject(result) && Array.isArray(result.data) ? result.data : [];
  for (const turn of data) {
    if (!isPlainObject(turn)) continue;
    const status = turnListStatus(turn);
    if (status !== "completed" && status !== "failed" && status !== "interrupted") {
      const turnId = stringAt(turn, ["id"]) ?? stringAt(turn, ["turn", "id"]);
      if (turnId) return turnId;
    }
  }
  return null;
}

async function interruptRemoteTurn(
  client: CodexRpcClient,
  threadId: string,
  turnId: string,
): Promise<string> {
  try {
    await client.request("turn/interrupt", { threadId, turnId }, CODEX_INTERRUPT_CONFIRM_MS);
  } catch (err) {
    throw new Error(
      `codex resumed thread has active remote turn ${turnId}, and interrupt failed: ${errorMessage(err)}`,
    );
  }
  const deadline = Date.now() + CODEX_INTERRUPT_CONFIRM_MS;
  while (Date.now() <= deadline) {
    const status = await findTurnStatus(client, threadId, turnId);
    if (status === "completed" || status === "failed" || status === "interrupted") return status;
    await Bun.sleep(50);
  }
  throw new Error(
    `codex resumed thread has active remote turn ${turnId}, and interrupt did not reach a terminal status`,
  );
}

async function findTurnStatus(
  client: CodexRpcClient,
  threadId: string,
  turnId: string,
): Promise<string | null> {
  const result = await client.request("thread/turns/list", {
    threadId,
    limit: 20,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });
  const data = isPlainObject(result) && Array.isArray(result.data) ? result.data : [];
  for (const turn of data) {
    if (!isPlainObject(turn)) continue;
    const id = stringAt(turn, ["id"]) ?? stringAt(turn, ["turn", "id"]);
    if (id === turnId) return turnListStatus(turn);
  }
  return null;
}

async function handleAbort(args: {
  state: CodexCallState;
  client: CodexRpcClient;
  transport: CodexTransport;
  emit: (event: TraceEvent) => void;
  invocation: AgentInvocation;
  transportType: CodexTransportConfig["type"];
}): Promise<void> {
  const { state, client, transport, emit, invocation, transportType } = args;
  state.aborting = true;
  if (!state.turnInFlight) {
    await transport.close();
    throw new Error(`codex agent "${invocation.key}" aborted`);
  }
  if (state.threadId && state.turnId) {
    try {
      await client.request(
        "turn/interrupt",
        { threadId: state.threadId, turnId: state.turnId },
        CODEX_INTERRUPT_CONFIRM_MS,
      );
    } catch {
      // Confirmation comes from turn/completed; request failure is only diagnostic here.
    }
    const confirmed = await Promise.race([
      waitForTerminal(state, CODEX_INTERRUPT_CONFIRM_MS).then(
        (terminal) => terminal.status === "interrupted",
      ),
      Bun.sleep(CODEX_INTERRUPT_CONFIRM_MS).then(() => false),
    ]);
    await transport.close();
    if (confirmed) throw new Error(`codex agent "${invocation.key}" aborted`);
  } else {
    await transport.close();
  }
  const message =
    transportType === "stdio"
      ? "codex abort could not confirm turn interruption; owned stdio app-server child was terminated"
      : "codex abort could not confirm remote turn interruption; remote turn may still be active";
  const event: TraceEvent = {
    type: "disconnect",
    data: {
      message,
      threadId: state.threadId,
      turnId: state.turnId,
    },
  };
  emit(event);
  throw new Error(message);
}

async function interruptActiveTurnAfterFailure(args: {
  state: CodexCallState;
  client: CodexRpcClient;
  transport: CodexTransport;
  emit: (event: TraceEvent) => void;
  transportType: CodexTransportConfig["type"];
}): Promise<void> {
  const { state, client, transport, emit, transportType } = args;
  if (!state.turnInFlight) return;
  state.aborting = true;
  if (state.threadId && state.turnId) {
    try {
      await client.request(
        "turn/interrupt",
        { threadId: state.threadId, turnId: state.turnId },
        CODEX_INTERRUPT_CONFIRM_MS,
      );
    } catch {
      // The original provider failure is authoritative; interruption is cleanup.
    }
    const confirmed = await Promise.race([
      waitForTerminal(state, CODEX_INTERRUPT_CONFIRM_MS).then(
        (terminal) => terminal.status === "interrupted",
      ),
      Bun.sleep(CODEX_INTERRUPT_CONFIRM_MS).then(() => false),
    ]);
    if (confirmed) return;
  }
  try {
    await transport.close();
  } catch {
    // Cleanup must not replace the original provider failure.
  }
  emit({
    type: "disconnect",
    data: {
      message:
        transportType === "stdio"
          ? "codex failure could not confirm turn interruption; owned stdio app-server child was terminated"
          : "codex failure could not confirm remote turn interruption; remote turn may still be active",
      threadId: state.threadId,
      turnId: state.turnId,
    },
  });
}

function waitForTerminal(state: CodexCallState, timeoutMs: number): Promise<CodexTurnTerminal> {
  if (state.terminal) return Promise.resolve(state.terminal);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = (): void => {
      if (state.terminal) {
        resolve(state.terminal);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve({ status: "unknown" });
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function finalizeCodexTurn(
  terminal: CodexTurnTerminal,
  state: CodexCallState,
  key: string,
): string {
  if (terminal.status === "completed") {
    const text = (
      state.completedTexts.length > 0 ? state.completedTexts.join("\n\n") : state.streamedText
    ).trim();
    if (!text) throw new Error(`codex agent "${key}" completed without assistant text`);
    return text;
  }
  if (terminal.status === "failed") {
    throw new Error(`codex turn failed: ${terminal.message ?? "unknown Codex failure"}`);
  }
  if (terminal.status === "interrupted") {
    if (state.aborting) throw new Error(`codex agent "${key}" aborted`);
    throw new Error("codex turn interrupted");
  }
  throw new Error(`codex turn ended with unsupported status ${terminal.status}`);
}

function requiredThreadIdFromResult(value: unknown): string | undefined {
  return stringAt(value, ["thread", "id"]);
}

function requiredTurnIdFromResult(value: unknown): string | undefined {
  return stringAt(value, ["turn", "id"]);
}

function extractThreadId(value: unknown): string | undefined {
  return (
    stringAt(value, ["thread", "id"]) ??
    stringAt(value, ["threadId"]) ??
    stringAt(value, ["thread", "threadId"]) ??
    stringAt(value, ["id"])
  );
}

function extractTurnId(value: unknown): string | undefined {
  return (
    stringAt(value, ["turn", "id"]) ??
    stringAt(value, ["turnId"]) ??
    stringAt(value, ["turn", "turnId"]) ??
    stringAt(value, ["id"])
  );
}

function extractItemId(value: unknown): string | undefined {
  return stringAt(value, ["itemId"]) ?? stringAt(value, ["item", "id"]);
}

function matchesCurrentThread(params: unknown, state: CodexCallState): boolean {
  const scopedThread = extractThreadId(params);
  return !scopedThread || !state.threadId || scopedThread === state.threadId;
}

function matchesCurrentTurn(params: unknown, state: CodexCallState): boolean {
  if (!matchesCurrentThread(params, state)) return false;
  const scopedTurn = extractTurnId(params);
  if (scopedTurn && state.ignoredTurnIds.has(scopedTurn)) return false;
  return !scopedTurn || !state.turnId || scopedTurn === state.turnId;
}

function errorAppliesToCurrentTurn(params: unknown, state: CodexCallState): boolean {
  const scopedThread = extractThreadId(params);
  if (scopedThread && state.threadId && scopedThread !== state.threadId) return false;
  const scopedTurn = extractTurnId(params);
  if (scopedTurn && state.ignoredTurnIds.has(scopedTurn)) return false;
  if (scopedTurn && state.turnId && scopedTurn !== state.turnId) return false;
  return true;
}

function completedItemText(item: Record<string, unknown>): string | null {
  const direct = stringAt(item, ["text"]);
  if (direct) return direct;
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const part of content) {
      if (typeof part === "string") text += part;
      else if (isPlainObject(part)) {
        const partText = stringAt(part, ["text"]) ?? stringAt(part, ["content"]);
        if (partText) text += partText;
      }
    }
    return text || null;
  }
  const messageContent = recordAt(item, ["message"]);
  return messageContent ? completedItemText(messageContent) : null;
}

function terminalStatus(params: unknown): string | undefined {
  return (
    stringAt(params, ["turn", "status", "type"]) ??
    stringAt(params, ["turn", "status"]) ??
    stringAt(params, ["status", "type"]) ??
    stringAt(params, ["status"])
  );
}

function turnListStatus(turn: Record<string, unknown>): string {
  return stringAt(turn, ["status"]) ?? stringAt(turn, ["status", "type"]) ?? "inProgress";
}

function terminalMessage(params: unknown): string | undefined {
  return (
    stringAt(params, ["turn", "error", "message"]) ??
    stringAt(params, ["turn", "error"]) ??
    stringAt(params, ["turn", "message"]) ??
    stringAt(params, ["error", "message"]) ??
    stringAt(params, ["message"])
  );
}

function threadStatusType(value: unknown): string | undefined {
  return (
    stringAt(value, ["thread", "status", "type"]) ??
    stringAt(value, ["status", "type"]) ??
    stringAt(value, ["thread", "status"]) ??
    stringAt(value, ["status"])
  );
}

function bestErrorMessage(value: unknown): string | undefined {
  return stringAt(value, ["message"]) ?? stringAt(value, ["error", "message"]);
}

function recordAt(value: unknown, path: string[]): Record<string, unknown> | null {
  let cur = value;
  for (const segment of path) {
    if (!isPlainObject(cur)) return null;
    cur = cur[segment];
  }
  return isPlainObject(cur) ? cur : null;
}

function stringAt(value: unknown, path: string[]): string | undefined {
  let cur = value;
  for (const segment of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[segment];
  }
  return typeof cur === "string" && cur.length > 0 ? cur : undefined;
}

function invalidConfig(message: string): ProviderConfigValidationError {
  return new ProviderConfigValidationError(message);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw invalidConfig(`${path}.${key} is not supported`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn<T extends object>(value: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function transportDescriptor(config: CodexTransportConfig): string {
  switch (config.type) {
    case "stdio":
      return "stdio";
    case "ws":
      return `ws:${config.url}`;
    case "uds":
      return `uds:${config.path}`;
  }
}

function formatRpcError(method: string, error: unknown): Error {
  if (isPlainObject(error)) {
    const code =
      typeof error.code === "number" || typeof error.code === "string" ? error.code : "unknown";
    const message = typeof error.message === "string" ? error.message : "unknown JSON-RPC error";
    return new Error(`codex ${method} JSON-RPC error ${code}: ${message}`);
  }
  return new Error(`codex ${method} JSON-RPC error: ${String(error)}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

async function timeoutPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message} after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function connectSocket(
  create: () => Socket | TLSSocket,
  descriptor: string,
  timeoutMs: number,
  secure: boolean,
): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = create();
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`codex ${descriptor} connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("secureConnect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(new Error(`codex ${descriptor} connection failed: ${err.message}`));
    };
    socket.once(secure ? "secureConnect" : "connect", onConnect);
    socket.once("error", onError);
  });
}

function validateWebSocketHandshake(head: string, key: string, descriptor: string): void {
  const lines = head.split("\r\n");
  const statusLine = lines[0] ?? "";
  if (!/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
    throw new Error(
      `codex ${descriptor} WebSocket handshake failed: ${statusLine || "missing status"}`,
    );
  }
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const split = line.indexOf(":");
    if (split < 0) continue;
    headers.set(line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim());
  }
  const accept = headers.get("sec-websocket-accept");
  const expected = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  if (accept !== expected) {
    throw new Error(`codex ${descriptor} WebSocket handshake failed: invalid Sec-WebSocket-Accept`);
  }
}

interface DecodedWebSocketFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  bytesRead: number;
}

function decodeWebSocketFrame(buffer: Buffer): DecodedWebSocketFrame | null {
  if (buffer.length < 2) return null;
  const first = buffer[0] as number;
  const second = buffer[1] as number;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) throw new Error("payload too large");
    length = low;
    offset += 8;
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
  return { fin, opcode, payload, bytesRead: offset + length };
}

function encodeWebSocketFrame(payload: Buffer, opcode: number): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++)
    masked[i] = (masked[i] as number) ^ (mask[i % 4] as number);
  return Buffer.concat([header, mask, masked]);
}
