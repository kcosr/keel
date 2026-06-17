export const DEFAULT_HEARTBEAT_MS = 10_000;
export const OWNER_STALE_HEARTBEATS = 3;

export function ownerStaleWindowMs(heartbeatMs: number = DEFAULT_HEARTBEAT_MS): number {
  return OWNER_STALE_HEARTBEATS * heartbeatMs;
}

export function ownerStaleBeforeMs(
  nowMs: number,
  heartbeatMs: number = DEFAULT_HEARTBEAT_MS,
): number {
  return nowMs - ownerStaleWindowMs(heartbeatMs);
}

export function isRunOwnerStale(
  run: { runtimeOwnerId: string | null; heartbeatAtMs: number | null },
  nowMs: number,
  staleWindowMs: number = ownerStaleWindowMs(),
): boolean {
  return (
    run.runtimeOwnerId !== null &&
    (run.heartbeatAtMs === null || run.heartbeatAtMs < nowMs - staleWindowMs)
  );
}
