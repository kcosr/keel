export type WebDebugScope = "events" | "transcript";

const STORAGE_KEYS = ["keelDebug", "keel.debug"];
const ENABLED_VALUES = new Set(["1", "true", "yes", "all"]);
let cachedScopes: Set<string> | null | undefined;

export function webDebug(
  scope: WebDebugScope,
  message: string,
  data?: unknown | (() => unknown),
): void {
  if (!isWebDebugEnabled(scope)) return;
  const args = data === undefined ? [] : [typeof data === "function" ? data() : data];
  console.debug(`[keel web:${scope}] ${message}`, ...args);
}

export function isWebDebugEnabled(scope: WebDebugScope): boolean {
  const scopes = webDebugScopes();
  return scopes?.has("all") === true || scopes?.has(scope) === true;
}

export function resetWebDebugCacheForTest(): void {
  cachedScopes = undefined;
}

export function summarizeSseFrameForDebug(frame: {
  event: string;
  data: unknown;
}): Record<string, unknown> {
  const summary = summarizeEventDataForDebug(frame.data);
  if (!summary) {
    return {
      event: frame.event,
      dataType: frame.data === null ? "null" : typeof frame.data,
    };
  }
  return { event: frame.event, ...summary };
}

export function summarizeEventFrameForDebug(frame: unknown): Record<string, unknown> | null {
  return summarizeEventDataForDebug(frame);
}

export function summarizeTranscriptRowForDebug(row: {
  actor: string;
  event: string;
  seq: string;
  message: string;
}): Record<string, unknown> {
  return {
    actor: row.actor,
    event: row.event,
    seq: row.seq,
    messageLength: row.message.length,
  };
}

function webDebugScopes(): Set<string> | null {
  if (cachedScopes !== undefined) return cachedScopes;
  const flag = webDebugFlag();
  if (!flag) {
    cachedScopes = null;
    return cachedScopes;
  }
  const scopes = new Set<string>();
  for (const value of flag
    .split(/[,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)) {
    if (ENABLED_VALUES.has(value)) scopes.add("all");
    else scopes.add(value);
  }
  cachedScopes = scopes;
  return cachedScopes;
}

function summarizeEventDataForDebug(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const payload = "payload" in data ? data.payload : null;
  const inner = payload && typeof payload === "object" && "event" in payload ? payload.event : null;
  const innerType =
    inner && typeof inner === "object" && "type" in inner && typeof inner.type === "string"
      ? inner.type
      : undefined;
  const innerData =
    inner && typeof inner === "object" && "data" in inner && typeof inner.data === "string"
      ? inner.data
      : undefined;
  const cursor = "cursor" in data ? data.cursor : null;
  return {
    kind: "kind" in data && typeof data.kind === "string" ? data.kind : undefined,
    type: "type" in data && typeof data.type === "string" ? data.type : undefined,
    seq: "seq" in data && typeof data.seq === "number" ? data.seq : undefined,
    cursorSeq:
      cursor && typeof cursor === "object" && "seq" in cursor && typeof cursor.seq === "number"
        ? cursor.seq
        : undefined,
    key:
      payload && typeof payload === "object" && "key" in payload && typeof payload.key === "string"
        ? payload.key
        : undefined,
    innerType,
    dataLength: innerData?.length,
  };
}

function webDebugFlag(): string | null {
  const locationFlag = debugFlagFromLocation();
  if (locationFlag) return locationFlag;
  for (const key of STORAGE_KEYS) {
    try {
      const value = globalThis.localStorage?.getItem(key);
      if (value) return value;
    } catch {
      // Browser storage can be unavailable in private or test contexts.
    }
  }
  return null;
}

function debugFlagFromLocation(): string | null {
  const location = globalThis.location;
  if (!location) return null;
  const direct = debugFlagFromSearch(location.search);
  if (direct) return direct;
  const hashQuery = location.hash.includes("?")
    ? location.hash.slice(location.hash.indexOf("?"))
    : "";
  return debugFlagFromSearch(hashQuery);
}

function debugFlagFromSearch(search: string): string | null {
  if (!search) return null;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return params.get("keelDebug") ?? params.get("keel.debug");
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("storage", () => {
    cachedScopes = undefined;
  });
}
