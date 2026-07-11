import { summarizeSseFrameForDebug, webDebug } from "../lib/debug";
import { type SseMessage, parseSseStream } from "./sse";
import type {
  AgentProfileCheckResult,
  AgentProfileView,
  ApprovalsResponse,
  BrowseDirectoriesResult,
  EventCursorInput,
  HealthResponse,
  InterruptRunResult,
  RunDetailResponse,
  RunLaunchResult,
  RunStart,
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

export const WEB_RUNS_DEFAULT_LIMIT = 100;

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

  browseDirectories(path: string): Promise<BrowseDirectoriesResult> {
    return this.rpc("browseDirectories", { path });
  }

  listRuns(opts: { limit?: number } = {}): Promise<RunsResponse> {
    const limit = opts.limit ?? WEB_RUNS_DEFAULT_LIMIT;
    return this.getJson(`/api/runs?limit=${encodeURIComponent(String(limit))}`);
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

  resumeRun(runId: string): Promise<RunStart> {
    return this.rpc("resumeRun", { runId });
  }

  interruptRun(runId: string, reason?: string): Promise<InterruptRunResult> {
    return this.rpc("interruptRun", { runId, ...(reason ? { reason } : {}) });
  }

  retryRun(runId: string): Promise<RunStart> {
    return this.rpc("retryRun", { runId });
  }

  rerunRun(runId: string): Promise<RunStart> {
    return this.rpc("rerunRun", { runId, opts: {} });
  }

  rewindRun(runId: string, toStableKey: string): Promise<RunStart> {
    return this.rpc("rewindRun", { runId, toStableKey });
  }

  forkRun(runId: string, atStableKey?: string): Promise<RunLaunchResult> {
    return this.rpc("forkRun", {
      runId,
      opts: { ...(atStableKey ? { atStableKey } : {}) },
    });
  }

  sendSignal(runId: string, name: string, payload: unknown): Promise<RunStart> {
    return this.rpc("sendSignal", { runId, name, payload });
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

  putSchedule(req: {
    name: string;
    workflowName: string;
    workflowVersion?: number | "latest";
    intervalMs: number;
    input?: unknown;
    target?: string;
    firstFireMs?: number;
  }): Promise<{ ok: boolean }> {
    return this.rpc("putSchedule", {
      name: req.name,
      savedRef: {
        name: req.workflowName,
        version: req.workflowVersion ?? "latest",
      },
      intervalMs: req.intervalMs,
      ...(req.input !== undefined ? { input: req.input } : {}),
      ...(req.target ? { target: req.target } : {}),
      ...(req.firstFireMs !== undefined ? { firstFireMs: req.firstFireMs } : {}),
    });
  }

  setScheduleEnabled(name: string, enabled: boolean): Promise<{ name: string; enabled: boolean }> {
    return this.rpc("setScheduleEnabled", { name, enabled });
  }

  deleteSchedule(name: string): Promise<{ name: string; deleted: boolean }> {
    return this.rpc("deleteSchedule", { name });
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

  setSavedWorkflowDisabled(name: string, disabled: boolean): Promise<SavedWorkflowView> {
    return this.rpc("setSavedWorkflowDisabled", { name, disabled });
  }

  setSavedWorkflowVersionEnabled(
    name: string,
    version: number,
    enabled: boolean,
  ): Promise<SavedWorkflowView["versions"][number]> {
    return this.rpc("setSavedWorkflowVersionEnabled", { name, version, enabled });
  }

  deprecateSavedWorkflowVersion(
    name: string,
    version: number,
    message?: string,
  ): Promise<SavedWorkflowView["versions"][number]> {
    return this.rpc("deprecateSavedWorkflowVersion", {
      name,
      version,
      ...(message ? { message } : {}),
    });
  }

  deleteSavedWorkflow(name: string): Promise<SavedWorkflowView> {
    return this.rpc("deleteSavedWorkflow", { name });
  }

  deleteSavedWorkflowVersion(
    name: string,
    version: number,
  ): Promise<SavedWorkflowView["versions"][number]> {
    return this.rpc("deleteSavedWorkflowVersion", { name, version });
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

  checkAgentProfileConfig(config: Record<string, unknown>): Promise<AgentProfileCheckResult> {
    return this.rpc("checkAgentProfile", { config });
  }

  putAgentProfile(req: {
    name: string;
    config: Record<string, unknown>;
    ifGeneration?: number;
    createOnly?: boolean;
  }): Promise<AgentProfileView> {
    return this.rpc("putAgentProfile", req);
  }

  deleteAgentProfile(
    name: string,
    ifGeneration?: number,
  ): Promise<{ name: string; deleted: true }> {
    return this.rpc("deleteAgentProfile", {
      name,
      ...(ifGeneration !== undefined ? { ifGeneration } : {}),
    });
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

  putSetting(key: string, value: unknown, ifGeneration?: number): Promise<SettingView> {
    return this.rpc("putSetting", {
      key,
      value,
      ...(ifGeneration !== undefined ? { ifGeneration } : {}),
    });
  }

  deleteSetting(key: string, ifGeneration?: number): Promise<{ key: string; deleted: boolean }> {
    return this.rpc("deleteSetting", {
      key,
      ...(ifGeneration !== undefined ? { ifGeneration } : {}),
    });
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
          webDebug("events", "connect", {
            runId,
            cursor: nextCursor,
            url: `${url.pathname}${url.search}`,
          });
          const headers = this.headers({ includeAuth: true });
          headers.set("accept", "text/event-stream");
          const response = await this.fetchImpl(url, {
            headers,
            signal: controller.signal,
          });
          if (!response.ok) throw await toApiError(response);
          if (!response.body) throw new ApiError("event stream did not include a body", 500, null);
          webDebug("events", "open", { runId, cursor: nextCursor });
          opts.onStatus?.({ state: "open", cursor: nextCursor });
          await parseSseStream(response.body, {
            onMessage: (frame) => {
              if (frame.event === "heartbeat") return;
              webDebug("events", "frame", () => summarizeSseFrameForDebug(frame));
              opts.onFrame(frame);
              const advanced = cursorFromFrame(frame);
              if (advanced) {
                webDebug("events", "cursor advanced", { from: nextCursor, to: advanced });
                nextCursor = advanced;
              }
              if (frame.event === "caught-up") {
                webDebug("events", "caught up", { runId, cursor: nextCursor });
                opts.onStatus?.({ state: "caught-up", cursor: nextCursor });
              }
              if (frame.event === "closed" || frame.event === "authorization.failed") {
                terminal = true;
                webDebug("events", "closed", {
                  runId,
                  cursor: nextCursor,
                  reason: terminalReason(frame),
                });
                opts.onStatus?.({
                  state: "closed",
                  cursor: nextCursor,
                  reason: terminalReason(frame),
                });
              }
            },
          });
          if (terminal || controller.signal.aborted) return;
          webDebug("events", "reconnect scheduled", { runId, cursor: nextCursor });
          opts.onStatus?.({ state: "reconnecting", cursor: nextCursor });
          await waitForReconnect();
        } catch (err) {
          if (controller.signal.aborted) return;
          webDebug("events", "error", {
            runId,
            cursor: nextCursor,
            error: err instanceof Error ? err.message : String(err),
          });
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
