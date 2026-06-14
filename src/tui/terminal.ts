export interface TuiReadable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
  on?: (event: "data", listener: (data: Buffer) => void) => unknown;
  off?: (event: "data", listener: (data: Buffer) => void) => unknown;
}

export interface TuiWritable {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write: (chunk: string) => unknown;
}

export type TuiProcessEvent = "SIGINT" | "uncaughtException" | "unhandledRejection" | "exit";

export interface TuiProcessLike {
  on?: (event: TuiProcessEvent, listener: (...args: any[]) => void) => unknown;
  off?: (event: TuiProcessEvent, listener: (...args: any[]) => void) => unknown;
  exit?: (code?: number) => never;
  exitCode?: string | number | null;
}

export interface TerminalIo {
  stdin: TuiReadable;
  stdout: TuiWritable;
  process?: TuiProcessLike;
}

export interface TerminalDimensions {
  width: number;
  height: number;
}

export const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
export const EXIT_ALTERNATE_SCREEN = "\u001b[?1049l";

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";
const RESET_STYLE = "\u001b[0m";

export function assertInteractiveTerminal(io: Pick<TerminalIo, "stdin" | "stdout">): void {
  if (!io.stdout.isTTY || !io.stdin.isTTY) {
    throw new Error("keel tui requires an interactive terminal; stdout and stdin must be TTYs");
  }
}

export class TerminalSession {
  private rawEnabled = false;
  private entered = false;
  private restored = false;

  constructor(private readonly io: Pick<TerminalIo, "stdin" | "stdout">) {}

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.io.stdout.write(`${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}${CLEAR_SCREEN}`);
    this.io.stdin.setRawMode?.(true);
    this.rawEnabled = true;
    this.io.stdin.resume?.();
  }

  restore(): void {
    if (this.restored) return;
    this.restored = true;
    if (this.rawEnabled) {
      this.io.stdin.setRawMode?.(false);
      this.rawEnabled = false;
    }
    if (this.entered) {
      this.io.stdout.write(`${RESET_STYLE}${SHOW_CURSOR}${EXIT_ALTERNATE_SCREEN}`);
    }
    this.io.stdin.pause?.();
  }
}

export async function withTerminalSession<T>(
  io: Pick<TerminalIo, "stdin" | "stdout">,
  fn: (session: TerminalSession) => Promise<T>,
): Promise<T> {
  const session = new TerminalSession(io);
  try {
    session.enter();
    return await fn(session);
  } finally {
    session.restore();
  }
}

export function installTerminalRestoreGuards(
  session: TerminalSession,
  processLike: TuiProcessLike | undefined,
): () => void {
  if (!processLike?.on || !processLike.off) return () => {};
  const handlers: [TuiProcessEvent, (...args: any[]) => void][] = [];
  const cleanup = () => {
    for (const [event, listener] of handlers) processLike.off?.(event, listener);
  };
  const restoreAndCleanup = () => {
    session.restore();
    cleanup();
  };
  const onSigint = () => {
    restoreAndCleanup();
    if (processLike.exit) processLike.exit(130);
    processLike.exitCode = 130;
  };
  const onUncaughtException = (err: unknown) => {
    restoreAndCleanup();
    throw err;
  };
  const onUnhandledRejection = (reason: unknown) => {
    restoreAndCleanup();
    throw reason instanceof Error ? reason : new Error(String(reason));
  };
  const onExit = () => {
    session.restore();
  };
  handlers.push(
    ["SIGINT", onSigint],
    ["uncaughtException", onUncaughtException],
    ["unhandledRejection", onUnhandledRejection],
    ["exit", onExit],
  );
  for (const [event, listener] of handlers) processLike.on(event, listener);
  return cleanup;
}

export function terminalDimensions(stdout: TuiWritable): TerminalDimensions {
  return {
    width: Math.max(20, stdout.columns ?? 80),
    height: Math.max(6, stdout.rows ?? 24),
  };
}
