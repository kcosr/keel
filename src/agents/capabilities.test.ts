import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveInvocationToolPolicy,
  resolvedToolPolicyToCodexParams,
  validateCapabilitiesDeclaration,
} from "./capabilities.ts";

describe("Codex capability mapping", () => {
  test("default and explicit read-only map to Codex read-only params", () => {
    const expected = {
      thread: { approvalPolicy: "never", sandbox: "read-only" },
      turn: {
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    } as const;
    expect(resolvedToolPolicyToCodexParams(resolveInvocationToolPolicy({}), process.cwd())).toEqual(
      expected,
    );
    expect(
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({ toolPolicy: "read-only" }),
        process.cwd(),
      ),
    ).toEqual(expected);
  });

  test("workspace-write maps to Codex workspace-write params with cwd writable root", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-codex-cap-"));
    try {
      expect(
        resolvedToolPolicyToCodexParams(
          resolveInvocationToolPolicy({ toolPolicy: "workspace-write" }),
          dir,
        ),
      ).toEqual({
        thread: { approvalPolicy: "never", sandbox: "workspace-write" },
        turn: {
          approvalPolicy: "never",
          sandboxPolicy: { type: "workspaceWrite", writableRoots: [dir], networkAccess: false },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("none policy rejects with no-tools guidance", () => {
    expect(() =>
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({ toolPolicy: "none" }),
        process.cwd(),
      ),
    ).toThrow(/no-tools capability shapes/);
  });

  test("unsupported network and capability mixes reject with shape details", () => {
    expect(() =>
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({
          capabilities: { fs: "workspace-write", shell: true, network: "none", secrets: [] },
        }),
        process.cwd(),
      ),
    ).toThrow(/shell=true, network=none/);
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
    expect(() =>
      resolvedToolPolicyToCodexParams(
        resolveInvocationToolPolicy({
          capabilities: { fs: "read", shell: false, network: ["*"], secrets: [] },
        }),
        process.cwd(),
      ),
    ).toThrow(/fs=read, shell=false, network=\["\*"\]/);
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
        resolveInvocationToolPolicy({
          capabilities: {
            fs: "workspace-write",
            shell: true,
            network: ["*"],
            secrets: [],
          },
        }).toolPolicy,
      ).toBe("workspace-write");
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

  test("capability array validation rejects sparse holes", () => {
    const sparseNetwork = new Array(1);
    expect(() => validateCapabilitiesDeclaration({ network: sparseNetwork })).toThrow(
      /network\[0\]/,
    );
    const sparseSecrets = new Array(1);
    expect(() => validateCapabilitiesDeclaration({ secrets: sparseSecrets })).toThrow(
      /secrets\[0\]/,
    );
  });
});
