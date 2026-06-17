import { type SseMessage, parseSseStream } from "./sse";
import type {
  AgentProfileView,
  ApprovalsResponse,
  EventCursorInput,
  HealthResponse,
  RunDetailResponse,
  RunsResponse,
  SavedWorkflowSummary,
  ScheduleSummary,
  SettingView,
  SystemProjection,
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
  onFrame(frame: SseMessage): void;
  onError?(err: unknown): void;
}

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

  listWorkspaces(): Promise<WorkspacesResponse> {
    return this.getJson("/api/workspaces");
  }

  system(): Promise<SystemProjection> {
    return this.getJson("/api/system");
  }

  listSchedules(): Promise<ScheduleSummary[]> {
    return this.rpc("listSchedules", { includeDisabled: true });
  }

  listSavedWorkflows(): Promise<SavedWorkflowSummary[]> {
    return this.rpc("listSavedWorkflows", {
      includeDisabled: true,
      includeDeprecated: true,
    });
  }

  listAgentProfiles(): Promise<AgentProfileView[]> {
    return this.rpc("listAgentProfiles", { source: "all" });
  }

  listSettings(): Promise<SettingView[]> {
    return this.rpc("listSettings", {});
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
    const url = new URL(`/runs/${encodeURIComponent(runId)}/events`, this.baseUrl);
    applyCursor(url, opts.cursor ?? { kind: "tail", count: 100 });
    void this.fetchImpl(url, {
      headers: this.headers({ includeAuth: true }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw await toApiError(response);
        if (!response.body) throw new ApiError("event stream did not include a body", 500, null);
        await parseSseStream(response.body, {
          onMessage: (frame) => {
            if (frame.event !== "heartbeat") opts.onFrame(frame);
          },
        });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        opts.onError?.(err);
      });
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
