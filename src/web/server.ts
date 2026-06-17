import { existsSync, readFileSync, statSync } from "node:fs";
import { type Socket, createConnection } from "node:net";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { redactCapabilityTokensInValue } from "../auth/redaction.ts";
import type {
  GatewayErrorEnvelope,
  GatewayEventFrame,
  GatewayRequest,
  GatewayResponse,
} from "../daemon/gateway.ts";
import type {
  EventCursor,
  EventCursorInput,
  EventStreamFrame,
  StreamControlFrame,
} from "../rpc/contract.ts";
import { normalizeEventCursorInput } from "../rpc/event-cursor.ts";

export const DEFAULT_WEB_HOST = "127.0.0.1";
export const DEFAULT_WEB_PORT = 7879;
export const DEFAULT_WEB_HEARTBEAT_MS = 15_000;
export const DEFAULT_WEB_ASSETS_DIR = resolve(import.meta.dir, "..", "..", "web", "dist");

export interface KeelWebServerOptions {
  socketPath: string;
  host?: string;
  port?: number;
  assetsDir?: string;
  apiOnly?: boolean;
  heartbeatMs?: number;
}

export interface KeelWebServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  stop(force?: boolean): void;
}

interface GatewayMessage {
  id?: unknown;
  result?: unknown;
  error?: GatewayErrorEnvelope;
  event?: GatewayEventFrame;
}

interface PendingRequest {
  resolve: (response: GatewayResponse) => void;
  reject: (err: unknown) => void;
}

class GatewaySocket {
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  onEvent: ((event: GatewayEventFrame) => void) | null = null;

  private constructor(private readonly socket: Socket) {}

  static connect(socketPath: string): Promise<GatewaySocket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const client = new GatewaySocket(socket);
      const failOpen = (err: unknown) => {
        socket.destroy();
        reject(err);
      };
      socket.once("connect", () => {
        socket.off("error", failOpen);
        socket.on("error", (err) => client.failAll(err));
        socket.on("data", (chunk) => client.onData(chunk));
        socket.on("close", () => client.failAll(new Error("daemon connection closed")));
        resolve(client);
      });
      socket.once("error", failOpen);
    });
  }

  request(
    method: string,
    params: unknown,
    credential: string | null,
    requestId?: unknown,
  ): Promise<GatewayResponse> {
    return new Promise((resolve, reject) => {
      const id = requestId ?? this.nextId++;
      const request: GatewayRequest = {
        id,
        method,
        params,
        credential,
        surface: "web",
      };
      this.pending.set(requestKey(id), { resolve, reject });
      this.socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
    this.failAll(new Error("daemon connection closed"));
  }

  private onData(chunk: Buffer | string): void {
    this.buf += chunk.toString();
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onMessage(JSON.parse(line) as GatewayMessage);
      nl = this.buf.indexOf("\n");
    }
  }

  private onMessage(message: GatewayMessage): void {
    if (message.event) {
      this.onEvent?.(message.event);
      return;
    }
    if (message.id === undefined) return;
    const key = requestKey(message.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    pending.resolve({
      id: message.id,
      ...(message.error ? { error: message.error } : { result: message.result }),
    });
  }

  private failAll(err: unknown): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}

export function startWebServer(opts: KeelWebServerOptions): KeelWebServer {
  const hostname = opts.host ?? DEFAULT_WEB_HOST;
  const port = opts.port ?? DEFAULT_WEB_PORT;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_WEB_HEARTBEAT_MS;
  const assetsDir = opts.assetsDir
    ? resolve(opts.assetsDir)
    : opts.apiOnly === true
      ? undefined
      : DEFAULT_WEB_ASSETS_DIR;
  const apiOnly = opts.apiOnly === true || !assetsDir || !existsSync(join(assetsDir, "index.html"));
  const server = Bun.serve({
    hostname,
    port,
    async fetch(request) {
      return handleWebRequest(request, {
        socketPath: opts.socketPath,
        assetsDir,
        apiOnly,
        heartbeatMs,
      });
    },
  });
  const boundPort = server.port ?? port;
  return {
    hostname,
    port: boundPort,
    url: `http://${hostname}:${boundPort}`,
    stop(force?: boolean) {
      server.stop(force);
    },
  };
}

async function handleWebRequest(
  request: Request,
  opts: {
    socketPath: string;
    assetsDir?: string;
    apiOnly: boolean;
    heartbeatMs: number;
  },
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json(await healthProjection(opts.socketPath, opts.assetsDir, opts.apiOnly));
    }
    if (request.method === "POST" && url.pathname === "/rpc") {
      return await rpcRoute(request, opts.socketPath);
    }
    const eventMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventMatch?.[1]) {
      return await eventsRoute(
        request,
        opts.socketPath,
        decodeURIComponent(eventMatch[1]),
        opts.heartbeatMs,
      );
    }
    if (request.method === "GET" && url.pathname === "/api/runs") {
      return await projectionRoute(opts.socketPath, request, "runs");
    }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch?.[1]) {
      return await projectionRoute(
        opts.socketPath,
        request,
        "run",
        decodeURIComponent(runMatch[1]),
      );
    }
    if (request.method === "GET" && url.pathname === "/api/approvals") {
      return await projectionRoute(opts.socketPath, request, "approvals");
    }
    if (request.method === "GET" && url.pathname === "/api/workspaces") {
      return await projectionRoute(opts.socketPath, request, "workspaces");
    }
    if (request.method === "GET" && url.pathname === "/api/system") {
      return await projectionRoute(opts.socketPath, request, "system");
    }
    if (request.method === "GET" && !opts.apiOnly && opts.assetsDir) {
      const asset = serveAsset(url.pathname, opts.assetsDir);
      if (asset) return asset;
    }
    return json({ error: { message: "not found" } }, 404);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.error }, err.status);
    return json({ error: { message: err instanceof Error ? err.message : String(err) } }, 500);
  }
}

async function healthProjection(
  socketPath: string,
  assetsDir: string | undefined,
  apiOnly: boolean,
): Promise<Record<string, unknown>> {
  const daemon = await unary(socketPath, "ping", {}, null).then(
    (response) =>
      response.error
        ? { reachable: true, error: response.error }
        : { reachable: true, ...(response.result as Record<string, unknown>) },
    (err) => ({
      reachable: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    }),
  );
  return {
    ok: true,
    web: { ok: true, apiOnly },
    daemon,
    bundle: bundleStatus(assetsDir, apiOnly),
  };
}

async function rpcRoute(request: Request, socketPath: string): Promise<Response> {
  const credential = bearerCredential(request);
  const body = await request.json().catch(() => {
    throw new HttpError(400, { message: "request body must be JSON" });
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, { message: "request body must be a JSON object" });
  }
  const rpc = body as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof rpc.method !== "string" || rpc.method.length === 0) {
    throw new HttpError(400, { message: "rpc method must be a non-empty string" });
  }
  const response = await unary(socketPath, rpc.method, rpc.params ?? {}, credential, rpc.id);
  return json(response, response.error ? statusForGatewayError(response.error) : 200);
}

async function projectionRoute(
  socketPath: string,
  request: Request,
  kind: "runs" | "run" | "approvals" | "workspaces" | "system",
  runId?: string,
): Promise<Response> {
  const credential = bearerCredential(request);
  const call = <T>(method: string, params: unknown = {}) =>
    gatewayResult<T>(socketPath, method, params, credential);
  if (kind === "runs") {
    const summaries = await call<Array<{ runId: string }>>("listRuns");
    const runs = await Promise.all(
      summaries.map(async (summary) => {
        const [run, blockage, workspaces] = await Promise.all([
          call("getRun", { runId: summary.runId }),
          call("getBlockage", { runId: summary.runId }),
          call<unknown[]>("listRunWorkspaces", { runId: summary.runId, includeRemoved: true }),
        ]);
        return {
          ...summary,
          run,
          blockage,
          workspaceSummary: { count: workspaces.length },
        };
      }),
    );
    return json({ runs });
  }
  if (kind === "run") {
    if (!runId) throw new HttpError(400, { message: "run id is required" });
    const [run, report, blockage, workspaces, source, eventTail, hasAdmin] = await Promise.all([
      call("getRun", { runId }),
      call("getRunReport", { runId }),
      call("getBlockage", { runId }),
      call("listRunWorkspaces", { runId, includeRemoved: true }),
      call("getWorkflowDefinitionSource", { lookup: { kind: "run", runId }, all: true }),
      collectEvents(socketPath, runId, { kind: "tail", count: 100 }, credential),
      hasAdminAuthority(socketPath, credential),
    ]);
    return json({
      run,
      report,
      blockage,
      workspaces,
      source,
      events: eventTail.events,
      eventCursor: eventTail.cursor,
      rawEvents: { href: `/runs/${encodeURIComponent(runId)}/events` },
      availableCommands: availableRunCommands(run, blockage, hasAdmin),
    });
  }
  if (kind === "approvals") {
    const summaries =
      await call<Array<{ runId: string; workflowName: string | null; status: string }>>("listRuns");
    const approvals = [];
    for (const summary of summaries) {
      if (summary.status !== "waiting-human") continue;
      const blockage = await call<{
        reason: string;
        blockedOn: { stableKey: string; since: number } | null;
        context: string;
      }>("getBlockage", { runId: summary.runId });
      if (blockage.reason === "waiting_human") {
        approvals.push({
          runId: summary.runId,
          runName: summary.workflowName,
          status: summary.status,
          gateId: blockage.blockedOn?.stableKey ?? null,
          prompt: blockage.context.replace(/^awaiting decision: /, ""),
          createdAtMs: blockage.blockedOn?.since ?? null,
          requiredAuthority: "admin",
          cli: blockage.blockedOn?.stableKey
            ? `keel approve ${summary.runId} ${blockage.blockedOn.stableKey}`
            : null,
        });
      }
    }
    return json({ approvals });
  }
  if (kind === "workspaces") {
    const summaries = await call<Array<{ runId: string }>>("listRuns");
    const nested = await Promise.all(
      summaries.map((summary) =>
        call<unknown[]>("listRunWorkspaces", { runId: summary.runId, includeRemoved: true }),
      ),
    );
    return json({ workspaces: nested.flat() });
  }
  const [ping, profiles, settings] = await Promise.all([
    call("ping"),
    call("listAgentProfiles", { source: "all" }),
    call("listSettings"),
  ]);
  return json({
    daemon: ping,
    profiles,
    settings,
    warnings: [
      "daemon version and journal schema are unavailable until a daemon status RPC exists",
    ],
  });
}

async function eventsRoute(
  request: Request,
  socketPath: string,
  runId: string,
  heartbeatMs: number,
): Promise<Response> {
  const credential = bearerCredential(request);
  const cursor = parseEventCursor(new URL(request.url));
  const preflight = await unary(socketPath, "getRun", { runId }, credential);
  if (preflight.error) return json(preflight, statusForGatewayError(preflight.error));
  const encoder = new TextEncoder();
  let gateway: GatewaySocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let snapshotSent = false;
      let closeAfterSnapshot = false;
      const buffered: string[] = [];
      const writeNow = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const write = (text: string) => {
        if (snapshotSent) writeNow(text);
        else buffered.push(text);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        gateway?.close();
        try {
          controller.close();
        } catch {
          // The browser may have already canceled the stream.
        }
      };
      const scheduleClose = () => {
        if (snapshotSent) close();
        else closeAfterSnapshot = true;
      };
      const sendSnapshot = (snapshot: unknown) => {
        writeNow(sseFrame("snapshot", redactCapabilityTokensInValue(snapshot)));
        snapshotSent = true;
        for (const frame of buffered.splice(0)) writeNow(frame);
        if (closeAfterSnapshot) close();
      };
      cleanup = close;
      request.signal.addEventListener("abort", close, { once: true });
      heartbeat = setInterval(() => write(`: heartbeat ${Date.now()}\n\n`), heartbeatMs);
      void GatewaySocket.connect(socketPath).then(
        async (conn) => {
          if (closed) {
            conn.close();
            return;
          }
          gateway = conn;
          let closedControlSent = false;
          let caughtUpSeen = false;
          conn.onEvent = (frame) => {
            write(sseForGatewayFrame(frame));
            if (frame.kind === "control" && frame.type === "caught-up") caughtUpSeen = true;
            const closedStatus = closedStatusForFrame(frame);
            if (closedStatus && !closedControlSent && (frame.kind === "control" || caughtUpSeen)) {
              closedControlSent = true;
              if (frame.kind !== "control") {
                write(
                  sseFrame("closed", {
                    kind: "control",
                    type: "closed",
                    cursor: cursorForFrame(runId, frame),
                    status: closedStatus,
                  }),
                );
              }
              scheduleClose();
            }
            if (
              frame.kind === "control" &&
              (frame.type === "authorization.failed" || frame.type === "closed")
            ) {
              scheduleClose();
            }
          };
          const subscribed = conn
            .request("subscribeEvents", { runId, cursor, includeControlFrames: true }, credential)
            .catch((err) => {
              if (closed) return null;
              throw err;
            });
          const snapshot = await conn.request("getRun", { runId }, credential).catch((err) => {
            if (closed) return null;
            throw err;
          });
          if (!snapshot) return;
          if (snapshot.error) {
            sendSnapshot(null);
            write(sseFrame("error", snapshot.error));
            scheduleClose();
            return;
          }
          sendSnapshot(snapshot.result);
          const response = await subscribed;
          if (!response) return;
          if (response.error) {
            write(sseFrame("error", response.error));
            scheduleClose();
          }
        },
        (err) => {
          if (!snapshotSent) sendSnapshot(null);
          write(sseFrame("error", { message: err instanceof Error ? err.message : String(err) }));
          scheduleClose();
        },
      );
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

async function collectEvents(
  socketPath: string,
  runId: string,
  cursor: EventCursorInput,
  credential: string | null,
): Promise<{ events: EventStreamFrame[]; cursor: EventCursor | null }> {
  const conn = await GatewaySocket.connect(socketPath);
  const events: EventStreamFrame[] = [];
  let caughtUp: EventCursor | null = null;
  try {
    conn.onEvent = (frame) => {
      if (frame.kind === "control" && frame.type === "caught-up") caughtUp = frame.cursor;
      else {
        const { subId: _subId, ...event } = frame;
        events.push(event as EventStreamFrame);
      }
    };
    const response = await conn.request(
      "subscribeEvents",
      { runId, cursor, includeControlFrames: true },
      credential,
    );
    if (response.error) throw new HttpError(statusForGatewayError(response.error), response.error);
    return {
      events,
      cursor:
        caughtUp ??
        ((response.result as { cursor?: EventCursor } | undefined)?.cursor as
          | EventCursor
          | undefined) ??
        null,
    };
  } finally {
    conn.close();
  }
}

async function gatewayResult<T>(
  socketPath: string,
  method: string,
  params: unknown,
  credential: string | null,
): Promise<T> {
  const response = await unary(socketPath, method, params, credential);
  if (response.error) throw new HttpError(statusForGatewayError(response.error), response.error);
  return response.result as T;
}

async function unary(
  socketPath: string,
  method: string,
  params: unknown,
  credential: string | null,
  requestId?: unknown,
): Promise<GatewayResponse> {
  const conn = await GatewaySocket.connect(socketPath);
  try {
    return await conn.request(method, params, credential, requestId);
  } finally {
    conn.close();
  }
}

async function hasAdminAuthority(socketPath: string, credential: string | null): Promise<boolean> {
  const response = await unary(socketPath, "listRuns", {}, credential);
  return !response.error;
}

function bearerCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || header.trim() === "") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) throw new HttpError(400, { message: "Authorization must use Bearer" });
  return match[1];
}

function parseEventCursor(url: URL): EventCursorInput {
  try {
    const encoded = url.searchParams.get("cursor");
    if (encoded) return normalizeEventCursorInput(JSON.parse(encoded));
    const afterSeq = url.searchParams.get("afterSeq");
    if (afterSeq !== null) {
      return normalizeEventCursorInput({ kind: "after-seq", seq: Number(afterSeq) });
    }
    const tail = url.searchParams.get("tail");
    if (tail !== null) return normalizeEventCursorInput({ kind: "tail", count: Number(tail) });
    const from = url.searchParams.get("from");
    if (from === "now") return { kind: "now" };
    if (from === null || from === "beginning") return { kind: "beginning" };
    throw new Error(`unknown event cursor ${from}`);
  } catch (err) {
    throw new HttpError(400, {
      message: `invalid event cursor: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function sseForGatewayFrame(frame: GatewayEventFrame): string {
  const { subId: _subId, ...payload } = frame;
  if (payload.kind === "control") {
    const control = payload as StreamControlFrame;
    return sseFrame(control.type, control);
  }
  return sseFrame("event", payload);
}

function closedStatusForFrame(frame: GatewayEventFrame): string | null {
  if (frame.kind === "control" && frame.type === "closed") return frame.status;
  if (frame.kind !== "durable") return null;
  switch (frame.type) {
    case "run.finished":
      return "finished";
    case "run.failed":
    case "run.aborted":
      return "failed";
    case "run.interrupted":
      return "interrupted";
    case "run.continued":
      return "continued";
    case "run.parked": {
      const kind =
        frame.payload && typeof frame.payload === "object"
          ? (frame.payload as { kind?: unknown }).kind
          : null;
      return typeof kind === "string" ? `waiting-${kind}` : "parked";
    }
    default:
      return null;
  }
}

function cursorForFrame(runId: string, frame: GatewayEventFrame): EventCursor {
  if (frame.kind === "durable") return { kind: "after-seq", runId, seq: frame.seq };
  if (frame.kind === "control") return frame.cursor;
  return { kind: "after-seq", runId, seq: 0 };
}

function sseFrame(event: string, data: unknown): string {
  const lines = JSON.stringify(data).split(/\r?\n/);
  return `${[`event: ${event}`, ...lines.map((line) => `data: ${line}`), ""].join("\n")}\n`;
}

function serveAsset(pathname: string, assetsDir: string): Response | null {
  const rel = pathname.startsWith("/assets/")
    ? pathname.slice(1)
    : pathname === "/" || !pathname.startsWith("/api/")
      ? "index.html"
      : "";
  if (!rel) return null;
  const path = safeJoin(assetsDir, rel);
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    if (rel === "index.html") return null;
    return new Response("not found\n", { status: 404 });
  }
  return new Response(readFileSync(path), {
    headers: { "content-type": contentType(path) },
  });
}

function safeJoin(root: string, rel: string): string | null {
  const normalized = normalize(rel).replace(/^(\.\.(?:\/|\\|$))+/, "");
  const full = resolve(root, normalized);
  const back = relative(root, full);
  if (back.startsWith("..") || back.includes(`..${sep}`) || resolve(root) === full) {
    return full === resolve(root) ? null : null;
  }
  return full;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function bundleStatus(assetsDir: string | undefined, apiOnly: boolean): Record<string, unknown> {
  if (!assetsDir || apiOnly) return { available: false };
  const index = join(assetsDir, "index.html");
  const stat = statSync(index);
  return {
    available: true,
    indexMtimeMs: stat.mtimeMs,
    indexSizeBytes: stat.size,
  };
}

function availableRunCommands(
  run: unknown,
  blockage: unknown,
  hasAdmin: boolean,
): Array<{ name: string; requiredAuthority: string }> {
  const commands = [
    { name: "watchEvents", requiredAuthority: "run:events" },
    { name: "viewSource", requiredAuthority: "run:source" },
  ];
  const status = run && typeof run === "object" ? (run as { status?: unknown }).status : undefined;
  const reason =
    blockage && typeof blockage === "object"
      ? (blockage as { reason?: unknown }).reason
      : undefined;
  if (hasAdmin && status === "waiting-human" && reason === "waiting_human") {
    commands.push({ name: "decideApproval", requiredAuthority: "admin" });
  }
  return commands;
}

function statusForGatewayError(error: GatewayErrorEnvelope): number {
  if ("code" in error && error.code === "permission_denied") {
    if (
      error.message.startsWith("no capability presented") ||
      error.message.startsWith("capability is invalid") ||
      error.message.startsWith("capability has been revoked") ||
      error.message.startsWith("capability has expired")
    ) {
      return 401;
    }
    return 403;
  }
  if ("message" in error && /^unknown method /.test(error.message)) return 400;
  if ("message" in error && /(must|requires|invalid|malformed)/i.test(error.message)) return 400;
  if ("message" in error && /not found/i.test(error.message)) return 404;
  return 500;
}

function requestKey(id: unknown): string {
  return JSON.stringify(id) ?? "undefined";
}

function json(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly error: GatewayErrorEnvelope,
  ) {
    super("message" in error ? error.message : "HTTP error");
  }
}
