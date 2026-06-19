import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { CommandResult, NormalizedWorkflowCommandSpec } from "./command.ts";
import {
  WORKFLOW_COMMAND_KILL_GRACE_MS,
  WORKFLOW_COMMAND_SHELL_EXECUTABLE,
  withCommandFailure,
} from "./command.ts";

export interface BoundedProcessRunOptions {
  command: NormalizedWorkflowCommandSpec;
  attempt: number;
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

export class CommandAbortError extends Error {
  constructor() {
    super("command aborted");
    this.name = "CommandAbortError";
  }
}

class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  byteLength = 0;

  constructor(private readonly capBytes: number) {}

  append(chunk: Buffer): void {
    this.byteLength += chunk.byteLength;
    const remaining = this.capBytes - this.retainedBytes;
    if (remaining <= 0) return;
    const retained = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    this.chunks.push(Buffer.from(retained));
    this.retainedBytes += retained.byteLength;
  }

  text(): CommandResult["stdout"] {
    const retained = Buffer.concat(this.chunks, this.retainedBytes);
    const omittedBytes = Math.max(0, this.byteLength - this.retainedBytes);
    return {
      text: retained.toString("utf8"),
      byteLength: this.byteLength,
      truncated: omittedBytes > 0,
      omittedBytes,
    };
  }
}

export async function runBoundedProcess(opts: BoundedProcessRunOptions): Promise<CommandResult> {
  const { command } = opts;
  const stdout = new BoundedCapture(command.maxStdoutBytes);
  const stderr = new BoundedCapture(command.maxStderrBytes);
  const startedAtMs = Date.now();
  let child: ChildProcessByStdio<null, Readable, Readable>;
  let outputCaptureError: Error | null = null;
  let timedOut = false;
  let stalled = false;
  let abortRequested = false;
  let gracefulTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const invocation =
    command.invocation.mode === "argv"
      ? { file: command.invocation.argv[0] as string, args: command.invocation.argv.slice(1) }
      : { file: WORKFLOW_COMMAND_SHELL_EXECUTABLE, args: ["-c", command.invocation.shell] };

  try {
    child = spawn(invocation.file, invocation.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (err) {
    return withCommandFailure(
      baseResult(command, opts.attempt, startedAtMs, Date.now(), stdout, stderr, {
        status: "spawn-error",
        error: { kind: "spawn-error", message: errorMessage(err) },
      }),
      command.successExitCodes,
    );
  }

  const cleanup = (): void => {
    if (gracefulTimer) clearTimeout(gracefulTimer);
    if (hardTimer) clearTimeout(hardTimer);
    if (stallTimer) clearTimeout(stallTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  };

  const terminate = (hard: boolean): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const signal = hard ? "SIGKILL" : "SIGTERM";
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  };

  const startTermination = (): void => {
    terminate(false);
    hardTimer = setTimeout(() => terminate(true), WORKFLOW_COMMAND_KILL_GRACE_MS);
  };

  const resetStallTimer = (): void => {
    if (command.stallTimeoutMs === null) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (timedOut || stalled || abortRequested) return;
      stalled = true;
      startTermination();
    }, command.stallTimeoutMs);
  };

  const onAbort = (): void => {
    abortRequested = true;
    startTermination();
  };

  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  resetStallTimer();
  gracefulTimer = setTimeout(() => {
    if (timedOut || stalled || abortRequested) return;
    timedOut = true;
    startTermination();
  }, command.timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      stdout.append(chunk);
      resetStallTimer();
    } catch (err) {
      outputCaptureError = err instanceof Error ? err : new Error(String(err));
      startTermination();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    try {
      stderr.append(chunk);
      resetStallTimer();
    } catch (err) {
      outputCaptureError = err instanceof Error ? err : new Error(String(err));
      startTermination();
    }
  });
  child.stdout.on("error", (err) => {
    outputCaptureError = err;
    startTermination();
  });
  child.stderr.on("error", (err) => {
    outputCaptureError = err;
    startTermination();
  });

  return await new Promise<CommandResult>((resolve, reject) => {
    let spawnError: Error | null = null;
    child.once("error", (err) => {
      spawnError = err;
    });
    child.once("close", (exitCode, signal) => {
      cleanup();
      const finishedAtMs = Date.now();
      if (abortRequested) {
        reject(new CommandAbortError());
        return;
      }
      if (outputCaptureError) {
        resolve(
          withCommandFailure(
            baseResult(command, opts.attempt, startedAtMs, finishedAtMs, stdout, stderr, {
              status: "output-capture-error",
              exitCode,
              signal,
              error: { kind: "output-capture-error", message: outputCaptureError.message },
            }),
            command.successExitCodes,
          ),
        );
        return;
      }
      if (spawnError) {
        resolve(
          withCommandFailure(
            baseResult(command, opts.attempt, startedAtMs, finishedAtMs, stdout, stderr, {
              status: "spawn-error",
              exitCode,
              signal,
              error: { kind: "spawn-error", message: spawnError.message },
            }),
            command.successExitCodes,
          ),
        );
        return;
      }
      if (timedOut) {
        resolve(
          withCommandFailure(
            baseResult(command, opts.attempt, startedAtMs, finishedAtMs, stdout, stderr, {
              status: "timed-out",
              exitCode,
              signal,
              timedOut: true,
            }),
            command.successExitCodes,
          ),
        );
        return;
      }
      if (stalled) {
        resolve(
          withCommandFailure(
            baseResult(command, opts.attempt, startedAtMs, finishedAtMs, stdout, stderr, {
              status: "stalled",
              exitCode,
              signal,
              stalled: true,
            }),
            command.successExitCodes,
          ),
        );
        return;
      }
      const status = signal ? "signaled" : "exited";
      resolve(
        withCommandFailure(
          baseResult(command, opts.attempt, startedAtMs, finishedAtMs, stdout, stderr, {
            status,
            exitCode,
            signal,
          }),
          command.successExitCodes,
        ),
      );
    });
  });
}

function baseResult(
  command: NormalizedWorkflowCommandSpec,
  attempt: number,
  startedAtMs: number,
  finishedAtMs: number,
  stdout: BoundedCapture,
  stderr: BoundedCapture,
  state: {
    status: CommandResult["status"];
    exitCode?: number | null;
    signal?: string | null;
    timedOut?: boolean;
    stalled?: boolean;
    error?: CommandResult["error"];
  },
): CommandResult {
  return {
    key: command.key,
    attempt,
    status: state.status,
    exitCode: state.exitCode ?? null,
    signal: state.signal ?? null,
    timedOut: state.timedOut ?? false,
    stalled: state.stalled ?? false,
    stdout: stdout.text(),
    stderr: stderr.text(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    startedAtMs,
    finishedAtMs,
    workspaceId: command.workspaceId,
    ...(command.workspaceIdentityHash
      ? { workspaceIdentityHash: command.workspaceIdentityHash }
      : {}),
    cwd: command.cwd,
    invocation:
      command.invocation.mode === "argv"
        ? { mode: "argv", argv: command.invocation.argv }
        : {
            mode: "shell",
            shell: command.invocation.shell,
            shellExecutable: command.invocation.shellExecutable,
          },
    output: {
      stdoutCapBytes: command.maxStdoutBytes,
      stderrCapBytes: command.maxStderrBytes,
      resultArtifactBacked: false,
    },
    ...(state.error ? { error: state.error } : {}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
