import { describe, expect, test } from "bun:test";
import { runTui } from "./index.ts";
import {
  ENTER_ALTERNATE_SCREEN,
  EXIT_ALTERNATE_SCREEN,
  TerminalSession,
  type TuiProcessEvent,
  type TuiReadable,
  type TuiWritable,
  installTerminalRestoreGuards,
  withTerminalSession,
} from "./terminal.ts";

function fakeReadable(): TuiReadable & { rawModes: boolean[]; resumed: number; paused: number } {
  return {
    isTTY: true,
    rawModes: [],
    resumed: 0,
    paused: 0,
    setRawMode(mode: boolean) {
      this.rawModes.push(mode);
    },
    resume() {
      this.resumed += 1;
    },
    pause() {
      this.paused += 1;
    },
  };
}

function fakeWritable(isTTY = true): TuiWritable & { writes: string[] } {
  return {
    isTTY,
    columns: 80,
    rows: 24,
    writes: [],
    write(chunk: string) {
      this.writes.push(chunk);
    },
  };
}

function fakeProcess(): {
  listeners: Map<TuiProcessEvent, Set<(...args: any[]) => void>>;
  on(event: TuiProcessEvent, listener: (...args: any[]) => void): void;
  off(event: TuiProcessEvent, listener: (...args: any[]) => void): void;
  emit(event: TuiProcessEvent, ...args: unknown[]): void;
  exitCode?: string | number | null;
  exit(code?: number): never;
} {
  return {
    listeners: new Map(),
    on(event, listener) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    },
    off(event, listener) {
      this.listeners.get(event)?.delete(listener);
    },
    emit(event, ...args) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    },
    exit(code?: number): never {
      this.exitCode = code;
      throw new Error(`exit ${code}`);
    },
  };
}

describe("tui terminal", () => {
  test("restores raw mode and alternate screen when the body throws", async () => {
    const stdin = fakeReadable();
    const stdout = fakeWritable();

    await expect(
      withTerminalSession({ stdin, stdout }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdout.writes.join("")).toContain(ENTER_ALTERNATE_SCREEN);
    expect(stdout.writes.join("")).toContain(EXIT_ALTERNATE_SCREEN);
    expect(stdin.paused).toBe(1);
  });

  test("restores alternate screen if raw mode setup throws", async () => {
    const stdin = fakeReadable();
    stdin.setRawMode = () => {
      throw new Error("raw unavailable");
    };
    const stdout = fakeWritable();

    await expect(withTerminalSession({ stdin, stdout }, async () => {})).rejects.toThrow(
      "raw unavailable",
    );

    expect(stdout.writes.join("")).toContain(EXIT_ALTERNATE_SCREEN);
  });

  test("restore guards cover uncaught exception and unhandled rejection", () => {
    for (const [event, arg, message] of [
      ["uncaughtException", new Error("async boom"), "async boom"],
      ["unhandledRejection", "reject boom", "reject boom"],
    ] as const) {
      const stdin = fakeReadable();
      const stdout = fakeWritable();
      const proc = fakeProcess();
      const session = new TerminalSession({ stdin, stdout });
      session.enter();
      installTerminalRestoreGuards(session, proc);

      expect(() => proc.emit(event, arg)).toThrow(message);
      expect(stdin.rawModes).toEqual([true, false]);
      expect(stdout.writes.join("")).toContain(EXIT_ALTERNATE_SCREEN);
      expect(proc.listeners.get(event)?.size ?? 0).toBe(0);
    }
  });

  test("runTui refuses non-interactive stdout before connecting", async () => {
    let connected = false;
    await expect(
      runTui({
        stdin: fakeReadable(),
        stdout: fakeWritable(false),
        clientFactory: async () => {
          connected = true;
          throw new Error("should not connect");
        },
      }),
    ).rejects.toThrow("requires an interactive terminal");
    expect(connected).toBe(false);
  });
});
