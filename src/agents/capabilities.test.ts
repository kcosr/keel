import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInvocationToolPolicy, resolvedToolPolicyToCodexParams } from "./capabilities.ts";

describe("Codex capability mapping", () => {
  test("default read-only rejects with unrestricted guidance", () => {
    const resolved = resolveInvocationToolPolicy({});
    expect(() => resolvedToolPolicyToCodexParams(resolved, process.cwd())).toThrow(
      /toolPolicy: "unrestricted"/,
    );
  });

  test("none and read-only policies reject", () => {
    expect(() =>
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({ toolPolicy: "none" }),
        process.cwd(),
      ),
    ).toThrow(/toolPolicy: "unrestricted"/);
    expect(() =>
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({ toolPolicy: "read-only" }),
        process.cwd(),
      ),
    ).toThrow(/toolPolicy: "unrestricted"/);
  });

  test("workspace-write without all-host network rejects", () => {
    expect(() =>
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({
          capabilities: { fs: "workspace-write", shell: true, network: "none", secrets: [] },
        }),
        process.cwd(),
      ),
    ).toThrow(/network=none/);
    expect(() =>
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({
          capabilities: {
            fs: "workspace-write",
            shell: true,
            network: ["example.com"],
            secrets: [],
          },
        }),
        process.cwd(),
      ),
    ).toThrow(/example\.com/);
  });

  test("allowTools and denyTools reject", () => {
    expect(() =>
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({ toolPolicy: "read-only", allowTools: ["bash"] }),
        process.cwd(),
      ),
    ).toThrow(/allowTools|denyTools/);
    expect(() =>
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({ toolPolicy: "workspace-write", denyTools: ["ls"] }),
        process.cwd(),
      ),
    ).toThrow(/allowTools|denyTools/);
  });

  test("unrestricted maps to Codex yolo params", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-codex-cap-"));
    try {
      const expected = {
        thread: { approvalPolicy: "never", sandbox: "danger-full-access" },
        turn: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
      } as const;
      expect(
        resolvedToolPolicyToCodexParams(
          resolveInvocationToolPolicy({ toolPolicy: "unrestricted" }),
          dir,
        ),
      ).toEqual(expected);
      expect(
        resolvedToolPolicyToCodexParams(
          resolveInvocationToolPolicy({
            capabilities: {
              fs: "workspace-write",
              shell: true,
              network: ["*"],
              secrets: [],
            },
          }),
          dir,
        ),
      ).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing or unusable cwd rejects", () => {
    const resolved = resolveInvocationToolPolicy({ toolPolicy: "unrestricted" });
    expect(() => resolvedToolPolicyToCodexParams(resolved, undefined)).toThrow(/cwd is missing/);
    expect(() => resolvedToolPolicyToCodexParams(resolved, "relative")).toThrow(
      /cwd is not absolute/,
    );
    expect(() =>
      resolvedToolPolicyToCodexParams(resolved, join(tmpdir(), "keel-codex-missing-cwd")),
    ).toThrow(/cwd is not an existing directory/);
  });
});
