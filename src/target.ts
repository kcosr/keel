// Shared run/agent target validation.
//
// CLI/client wrappers intentionally capture their own cwd as the default run
// target. Daemon/server/low-level paths must not invent a daemon cwd when the
// caller omits a target; they should call requireRunTarget instead.

export function requireRunTarget(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} requires target`);
  }
  if (value.trim().length === 0) {
    throw new Error(`${context} requires a non-empty target`);
  }
  return value;
}

export function optionalRunTarget(
  value: string | null | undefined,
  context: string,
): string | null {
  if (value == null) return null;
  return requireRunTarget(value, context);
}

export function clientRunTargetOrCwd(
  value: string | undefined,
  context: string,
  cwd = process.cwd(),
): string {
  if (value === undefined) return cwd;
  return requireRunTarget(value, context);
}

export function cliTargetPath(value: string, flag = "--target"): string {
  return requireRunTarget(value, flag);
}

export function resolveAgentTarget(
  specTarget: string | null | undefined,
  runTarget: string | null | undefined,
  description: string,
): string {
  if (specTarget != null) return requireRunTarget(specTarget, `${description} target`);
  if (runTarget != null) return requireRunTarget(runTarget, `${description} run target`);
  throw new Error(
    `${description} requires a target; launch with --target or set an agent/profile target`,
  );
}
