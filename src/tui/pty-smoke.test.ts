import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../daemon/client.ts";
import { KeelDaemon } from "../daemon/server.ts";

const CLI = new URL("../cli/keel.ts", import.meta.url).pathname;
const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = new URL("chain.workflow.ts", FIX).pathname;

test("opt-in PTY smoke renders the browser under script(1)", async () => {
  if (process.env.KEEL_TUI_PTY !== "1") return;

  const scriptPath = Bun.spawnSync(["bash", "-lc", "command -v script"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(scriptPath.exitCode).toBe(0);

  const dir = mkdtempSync(join(tmpdir(), "keel-tui-pty-"));
  const socketPath = join(dir, "keel.sock");
  const dbPath = join(dir, "keel.db");
  const adminToken = "kc_admin_tui_pty";
  const daemon = new KeelDaemon({ socketPath, dbPath, adminToken });
  try {
    await daemon.start();
    const client = await DaemonClient.connect(socketPath);
    try {
      await client.authenticate(adminToken);
      const launched = await client.launchRun({
        source: readFileSync(chainUrl, "utf8"),
        input: { n: 1 },
        name: "pty-smoke",
        provenance: { kind: "clientPath", path: chainUrl },
      });
      await client.waitForRun(launched.runId);

      const command = [
        `KEEL_SOCKET=${shellQuote(socketPath)}`,
        `KEEL_ADMIN_TOKEN=${shellQuote(adminToken)}`,
        shellQuote(process.execPath),
        shellQuote(CLI),
        "tui",
        "--limit",
        "5",
      ].join(" ");
      const proc = Bun.spawn(
        ["bash", "-lc", `(sleep 0.4; printf q) | script -q -c ${shellQuote(command)} /dev/null`],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Keel runs");
      expect(stdout).toContain(launched.runId);
    } finally {
      client.close();
    }
  } finally {
    daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
