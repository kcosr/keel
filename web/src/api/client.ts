import { type SseMessage, parseSseStream } from "./sse";
import type {
  AgentProfileCheckResult,
  AgentProfileView,
  ApprovalsResponse,
  EventCursorInput,
  HealthResponse,
  RunDetailResponse,
  RunLaunchResult,
  RunWorkspaceDiff,
  RunWorkspaceView,
  RunsResponse,
  SavedWorkflowSourceView,
  SavedWorkflowSummary,
  SavedWorkflowView,
  ScheduleSummary,
  ScheduleView,
  SettingCheckResult,
  SettingView,
  SystemProjection,
  WorkspaceGcResult,
  WorkspacesResponse,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface KeelWebClientOptions {
  baseUrl?: string;
  getCredential?: () => string | null;
  fetchImpl?: typeof fetch;
}

export interface WatchRunEventsOptions {
  cursor?: EventCursorInput;
  reconnectDelayMs?: number;
  onFrame(frame: SseMessage): void;
  onError?(err: unknown): void;
  onStatus?(status: WatchRunEventsStatus): void;
}

export type WatchRunEventsStatus =
  | { state: "connecting"; cursor: EventCursorInput }
  | { state: "open"; cursor: EventCursorInput }
  | { state: "caught-up"; cursor: EventCursorInput }
  | { state: "reconnecting"; cursor: EventCursorInput; error?: unknown }
  | { state: "closed"; cursor: EventCursorInput; reason?: string };

export class KeelWebClient {
  private readonly baseUrl: string;
  private readonly getCredential: () => string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: KeelWebClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? window.location.origin;
    this.getCredential = opts.getCredential ?? (() => null);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  health(): Promise<HealthResponse> {
    return this.getJson("/health", { includeAuth: false });
  }

  listRuns(): Promise<RunsResponse> {
    return this.getJson("/api/runs");
  }

  getRun(runId: string): Promise<RunDetailResponse> {
    return this.getJson(`/api/runs/${encodeURIComponent(runId)}`);
  }

  listApprovals(): Promise<ApprovalsResponse> {
    return this.getJson("/api/approvals");
  }

  decideApproval(
    runId: string,
    key: string,
    decision: { status: "approved" | "denied"; note?: string },
  ): Promise<unknown> {
    return this.rpc("decideApproval", { runId, key, decision });
  }

  listWorkspaces(): Promise<WorkspacesResponse> {
    return this.getJson("/api/workspaces");
  }

  getRunWorkspace(runId: string, workspaceId: string): Promise<RunWorkspaceView | null> {
    return this.rpc("getRunWorkspace", { runId, workspaceId });
  }

  getRunWorkspaceDiff(runId: string, workspaceId: string): Promise<RunWorkspaceDiff> {
    return this.rpc("getRunWorkspaceDiff", { runId, workspaceId });
  }

  mergeRunWorkspace(runId: string, workspaceId: string): Promise<RunWorkspaceView> {
    return this.rpc("mergeRunWorkspace", { runId, workspaceId });
  }

  discardRunWorkspace(runId: string, workspaceId: string): Promise<RunWorkspaceView> {
    return this.rpc("discardRunWorkspace", { runId, workspaceId });
  }

  gcWorkspaces(
    opts: {
      olderThanMs?: number;
      includePending?: boolean;
      includeRemoved?: boolean;
    } = {},
  ): Promise<WorkspaceGcResult> {
    return this.rpc("gcWorkspaces", opts);
  }

  system(): Promise<SystemProjection> {
    return this.getJson("/api/system");
  }

  listSchedules(): Promise<ScheduleSummary[]> {
    return this.rpc("listSchedules", { includeDisabled: true });
  }

  getSchedule(name: string): Promise<ScheduleView | null> {
    return this.rpc("getSchedule", { name, includeSource: true });
  }

  listSavedWorkflows(): Promise<SavedWorkflowSummary[]> {
    return this.rpc("listSavedWorkflows", {
      includeDisabled: true,
      includeDeprecated: true,
    });
  }

  getSavedWorkflow(name: string): Promise<SavedWorkflowView | null> {
    return this.rpc("getSavedWorkflow", { name });
  }

  getSavedWorkflowSource(req: {
    name: string;
    version?: number | "latest";
  }): Promise<SavedWorkflowSourceView> {
    return this.rpc("getSavedWorkflowSource", { ...req, all: true, allowDeprecated: true });
  }

  launchSavedWorkflow(req: {
    name: string;
    version?: number | "latest";
    allowDeprecated?: boolean;
    input?: unknown;
    target?: string;
    runName?: string | null;
  }): Promise<RunLaunchResult> {
    return this.rpc("launchSavedWorkflow", {
      ref: {
        name: req.name,
        version: req.version ?? "latest",
        ...(req.allowDeprecated ? { allowDeprecated: true } : {}),
      },
      ...(req.input !== undefined ? { input: req.input } : {}),
      ...(req.target ? { target: req.target } : {}),
      name: req.runName ?? null,
    });
  }

  listAgentProfiles(
    source: "all" | "catalog" | "programmatic" = "all",
  ): Promise<AgentProfileView[]> {
    return this.rpc("listAgentProfiles", { source });
  }

  getAgentProfile(name: string): Promise<AgentProfileView | null> {
    return this.rpc("getAgentProfile", { name });
  }

  checkAgentProfile(name: string): Promise<AgentProfileCheckResult> {
    return this.rpc("checkAgentProfile", { name });
  }

  listSettings(): Promise<SettingView[]> {
    return this.rpc("listSettings", {});
  }

  getSetting(key: string): Promise<SettingView | null> {
    return this.rpc("getSetting", { key });
  }

  checkSetting(key: string, value: unknown): Promise<SettingCheckResult> {
    return this.rpc("checkSetting", { key, value });
  }

  async rpc<T>(method: string, params: unknown = {}): Promise<T> {
    const response = await this.requestJson<{ result: T }>("/rpc", {
      method: "POST",
      body: JSON.stringify({ method, params }),
    });
    return response.result;
  }

  watchRunEvents(runId: string, opts: WatchRunEventsOptions): () => void {
    const controller = new AbortController();
    const reconnectDelayMs = opts.reconnectDelayMs ?? 750;
    let nextCursor = opts.cursor ?? ({ kind: "tail", count: 100 } satisfies EventCursorInput);

    const waitForReconnect = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, reconnectDelayMs);
      });

    const watch = async () => {
      while (!controller.signal.aborted) {
        let terminal = false;
        try {
          opts.onStatus?.({ state: "connecting", cursor: nextCursor });
          const url = new URL(`/runs/${encodeURIComponent(runId)}/events`, this.baseUrl);
          applyCursor(url, nextCursor);
          const headers = this.headers({ includeAuth: true });
          headers.set("accept", "text/event-stream");
          const response = await this.fetchImpl(url, {
            headers,
            signal: controller.signal,
          });
          if (!response.ok) throw await toApiError(response);
          if (!response.body) throw new ApiError("event stream did not include a body", 500, null);
          opts.onStatus?.({ state: "open", cursor: nextCursor });
          await parseSseStream(response.body, {
            onMessage: (frame) => {
              if (frame.event === "heartbeat") return;
              opts.onFrame(frame);
              const advanced = cursorFromFrame(frame);
              if (advanced) nextCursor = advanced;
              if (frame.event === "caught-up") {
                opts.onStatus?.({ state: "caught-up", cursor: nextCursor });
              }
              if (frame.event === "closed" || frame.event === "authorization.failed") {
                terminal = true;
                opts.onStatus?.({
                  state: "closed",
                  cursor: nextCursor,
                  reason: terminalReason(frame),
                });
              }
            },
          });
          if (terminal || controller.signal.aborted) return;
          opts.onStatus?.({ state: "reconnecting", cursor: nextCursor });
          await waitForReconnect();
        } catch (err) {
          if (controller.signal.aborted) return;
          opts.onError?.(err);
          if (err instanceof ApiError && err.status < 500) {
            opts.onStatus?.({ state: "closed", cursor: nextCursor, reason: err.message });
            return;
          }
          opts.onStatus?.({ state: "reconnecting", cursor: nextCursor, error: err });
          await waitForReconnect();
        }
      }
    };

    void watch();
    return () => controller.abort();
  }

  private getJson<T>(path: string, opts: { includeAuth?: boolean } = {}): Promise<T> {
    return this.requestJson(path, { method: "GET" }, opts);
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    opts: { includeAuth?: boolean } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...init,
      headers: this.headers({
        ...opts,
        extra: init.headers,
        body: init.body,
      }),
    });
    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as T;
  }

  private headers(opts: {
    includeAuth?: boolean;
    extra?: HeadersInit;
    body?: BodyInit | null;
  }): Headers {
    const headers = new Headers(opts.extra);
    headers.set("accept", "application/json");
    if (opts.body !== undefined && opts.body !== null) {
      headers.set("content-type", "application/json");
    }
    if (opts.includeAuth !== false) {
      const credential = this.getCredential();
      if (credential) headers.set("authorization", `Bearer ${credential}`);
    }
    return headers;
  }
}

function cursorFromFrame(frame: SseMessage): EventCursorInput | null {
  const data = frame.data;
  if (data === null || typeof data !== "object") return null;
  if ("kind" in data && data.kind === "durable" && "seq" in data && typeof data.seq === "number") {
    return { kind: "after-seq", seq: data.seq };
  }
  if ("cursor" in data) {
    const cursor = data.cursor;
    if (cursor && typeof cursor === "object" && "seq" in cursor && typeof cursor.seq === "number") {
      return { kind: "after-seq", seq: cursor.seq };
    }
  }
  return null;
}

function terminalReason(frame: SseMessage): string | undefined {
  const data = frame.data;
  if (data === null || typeof data !== "object") return undefined;
  if ("status" in data && typeof data.status === "string") return data.status;
  if ("payload" in data) {
    const payload = data.payload;
    if (
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof payload.message === "string"
    ) {
      return payload.message;
    }
  }
  return undefined;
}

async function toApiError(response: Response): Promise<ApiError> {
  const details = await response.json().catch(() => null);
  const message =
    details &&
    typeof details === "object" &&
    "error" in details &&
    details.error &&
    typeof details.error === "object" &&
    "message" in details.error &&
    typeof details.error.message === "string"
      ? details.error.message
      : `HTTP ${response.status}`;
  return new ApiError(message, response.status, details);
}

function applyCursor(url: URL, cursor: EventCursorInput): void {
  if (cursor.kind === "beginning") url.searchParams.set("from", "beginning");
  if (cursor.kind === "now") url.searchParams.set("from", "now");
  if (cursor.kind === "after-seq") url.searchParams.set("afterSeq", String(cursor.seq));
  if (cursor.kind === "tail") url.searchParams.set("tail", String(cursor.count));
}
