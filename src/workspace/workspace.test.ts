// Phase 15: capabilities, git-worktree isolation + diff gate, and secret env side channel.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DENY_ALL,
  resolveCapabilities,
  resolveInvocationToolPolicy,
  resolveToolPolicy,
  resolvedToolPolicyToClaudeArgs,
  resolvedToolPolicyToPiArgs,
} from "../agents/capabilities.ts";
import { SecretStore } from "../agents/secrets.ts";
import { createWorktree } from "./worktree.ts";

describe("capabilities → Pi tool flags", () => {
  test("omitted tool policy defaults to read-only tools", () => {
    const resolved = resolveToolPolicy({});
    expect(resolved.toolPolicy).toBe("read-only");
    expect(resolved.capabilities).toEqual({ ...DENY_ALL, fs: "read" });
    expect(resolvedToolPolicyToPiArgs(resolved)).toEqual(["--tools", "read,grep,ls"]);
    expect(resolvedToolPolicyToClaudeArgs(resolved)).toEqual([
      "--allowed-tools",
      "Read",
      "Grep",
      "Glob",
      "LS",
    ]);
  });

  test("fs:none → --no-tools (cannot write)", () => {
    expect(resolvedToolPolicyToPiArgs(resolveToolPolicy({ toolPolicy: "none" }))).toEqual([
      "--no-tools",
    ]);
  });

  test("explicit tool policy wins over capabilities", () => {
    const resolved = resolveToolPolicy({
      toolPolicy: "none",
      capabilities: { fs: "workspace-write", shell: true },
    });
    expect(resolved.capabilities).toEqual(DENY_ALL);
    expect(resolvedToolPolicyToPiArgs(resolved)).toEqual(["--no-tools"]);
    expect(resolvedToolPolicyToClaudeArgs(resolved)).toEqual(["--allowed-tools", ""]);
  });

  test("resolved default capabilities are not shared mutable policy objects", () => {
    const resolved = resolveToolPolicy({});
    resolved.capabilities.fs = "workspace-write";
    resolved.capabilities.secrets.push("LEAK");
    expect(resolveToolPolicy({}).capabilities).toEqual({ ...DENY_ALL, fs: "read" });
  });

  test("adapter-layer resolution keeps already-resolved capabilities authoritative", () => {
    const kernelResolved = resolveToolPolicy({
      capabilities: { fs: "read", network: ["api.example.com"] },
    });
    expect(kernelResolved.toolPolicy).toBe("workspace-write");

    const providerResolved = resolveInvocationToolPolicy(kernelResolved);
    expect(providerResolved.capabilities).toEqual({
      ...DENY_ALL,
      fs: "read",
      network: ["api.example.com"],
    });
    expect(resolvedToolPolicyToPiArgs(providerResolved)).toEqual(["--tools", "read,grep,ls"]);
    expect(resolvedToolPolicyToClaudeArgs(providerResolved)).toEqual([
      "--allowed-tools",
      "Read",
      "Grep",
      "Glob",
      "LS",
      "WebFetch",
      "WebSearch",
    ]);
  });

  test("adapter-layer resolution preserves shell without adding write tools", () => {
    const kernelResolved = resolveToolPolicy({ capabilities: { fs: "none", shell: true } });
    expect(kernelResolved.toolPolicy).toBe("workspace-write");
    const providerResolved = resolveInvocationToolPolicy(kernelResolved);
    expect(resolvedToolPolicyToPiArgs(providerResolved)).toEqual(["--tools", "bash"]);
    expect(resolvedToolPolicyToClaudeArgs(providerResolved)).toEqual(["--allowed-tools", "Bash"]);
  });

  test("fs:read → read/grep/ls only (no write)", () => {
    const args = resolvedToolPolicyToPiArgs(resolveToolPolicy({ toolPolicy: "read-only" }));
    expect(args).toEqual(["--tools", "read,grep,ls"]);
    expect(args.join()).not.toContain("write");
  });
  test("fs:workspace-write → adds edit/write; shell adds bash", () => {
    const caps = resolveCapabilities({ capabilities: { fs: "workspace-write", shell: true } });
    expect(
      resolvedToolPolicyToPiArgs(
        resolveToolPolicy({ capabilities: { fs: "workspace-write", shell: true } }),
      ),
    ).toEqual(["--tools", "read,grep,ls,edit,write,bash"]);
    expect(caps.fs).toBe("workspace-write");
    expect(DENY_ALL.fs).toBe("none");
  });
  test("explicit allow and deny tools adjust the final Pi allowlist", () => {
    const resolved = resolveToolPolicy({
      toolPolicy: "read-only",
      allowTools: ["Bash"],
      denyTools: ["LS"],
    });
    expect(resolved.capabilities.shell).toBe(false);
    expect(resolvedToolPolicyToPiArgs(resolved)).toEqual(["--tools", "read,grep,bash"]);
  });

  test("provider-native allow tools adjust provider flags without broadening capabilities", () => {
    const resolved = resolveToolPolicy({
      toolPolicy: "read-only",
      allowTools: ["mcp__foo__bar"],
    });
    expect(resolved.capabilities).toEqual({ ...DENY_ALL, fs: "read" });
    expect(resolvedToolPolicyToPiArgs(resolved)).toEqual(["--tools", "read,grep,ls,mcp__foo__bar"]);
    expect(resolvedToolPolicyToClaudeArgs(resolved)).toEqual([
      "--allowed-tools",
      "Read",
      "Grep",
      "Glob",
      "LS",
      "mcp__foo__bar",
    ]);
  });

  test("tool policy maps to Claude available tools with provider-native adjustments", () => {
    const resolved = resolveToolPolicy({
      toolPolicy: "read-only",
      allowTools: ["bash"],
      denyTools: ["glob"],
    });
    expect(resolvedToolPolicyToClaudeArgs(resolved)).toEqual([
      "--allowed-tools",
      "Read",
      "Grep",
      "LS",
      "Bash",
    ]);
  });

  test("unrestricted leaves provider defaults alone unless adjusted", () => {
    expect(
      resolvedToolPolicyToClaudeArgs(resolveToolPolicy({ toolPolicy: "unrestricted" })),
    ).toEqual([]);
  });

  test("unrestricted rejects allow or deny adjustments until providers expose native deny", () => {
    expect(() => resolveToolPolicy({ toolPolicy: "unrestricted", denyTools: ["bash"] })).toThrow(
      /unrestricted/,
    );
    expect(() => resolveToolPolicy({ toolPolicy: "unrestricted", allowTools: ["Read"] })).toThrow(
      /unrestricted/,
    );
    expect(() =>
      resolveInvocationToolPolicy({
        toolPolicy: "unrestricted",
        capabilities: {
          fs: "workspace-write",
          network: ["*"],
          shell: true,
          secrets: [],
        },
        denyTools: ["bash"],
      }),
    ).toThrow(/unrestricted/);
  });
});

describe("git-worktree isolation + diff gate", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "keel-repo-"));
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t"]);
    g(["config", "user.name", "t"]);
    writeFileSync(join(repo, "app.js"), "const x = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "init"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("a write agent's changes stay confined to the worktree until merge", () => {
    const wt = createWorktree(repo, "writer");
    try {
      // the "agent" edits in the worktree
      writeFileSync(join(wt.path, "app.js"), "const x = 2;\n");
      writeFileSync(join(wt.path, "new.js"), "export const y = 3;\n");

      const bundle = wt.diff();
      expect(bundle.modified).toContain("app.js");
      expect(bundle.added).toContain("new.js");
      expect(bundle.contentDiff).toContain("const x = 2;");
      // the untracked added file's CONTENT is in the reviewable patch, not just a marker
      expect(bundle.contentDiff).toContain("export const y = 3;");
      expect(bundle.contentDiff).toContain("+++ b/new.js");

      // the REAL tree is unchanged (confined)
      expect(readFileSync(join(repo, "app.js"), "utf8")).toBe("const x = 1;\n");
      expect(() => readFileSync(join(repo, "new.js"), "utf8")).toThrow();

      // approval → merge applies the diff to the real tree
      wt.mergeInto(repo);
      expect(readFileSync(join(repo, "app.js"), "utf8")).toBe("const x = 2;\n");
      expect(readFileSync(join(repo, "new.js"), "utf8")).toBe("export const y = 3;\n");
    } finally {
      wt.remove();
    }
  });

  test("merge conflicts fail before mutating the target", () => {
    const wt = createWorktree(repo, "conflict");
    try {
      writeFileSync(join(wt.path, "app.js"), "const x = 2;\n");
      writeFileSync(join(repo, "app.js"), "const x = 99;\n");

      expect(() => wt.mergeInto(repo)).toThrow(
        /conflict|patch does not apply|target was not modified/,
      );
      expect(readFileSync(join(repo, "app.js"), "utf8")).toBe("const x = 99;\n");
      expect(() => readFileSync(join(repo, "app.js.rej"), "utf8")).toThrow();
    } finally {
      wt.remove();
    }
  });

  test("merge preserves binary files, executable modes, and symlinks", () => {
    const wt = createWorktree(repo, "content");
    try {
      const binary = Buffer.from([0, 1, 2, 3, 255, 0, 42]);
      writeFileSync(join(wt.path, "asset.bin"), binary);
      writeFileSync(join(wt.path, "script.sh"), "#!/bin/sh\necho ok\n");
      chmodSync(join(wt.path, "script.sh"), 0o755);
      symlinkSync("app.js", join(wt.path, "app-link"));

      wt.mergeInto(repo);

      expect(Buffer.compare(readFileSync(join(repo, "asset.bin")), binary)).toBe(0);
      expect(lstatSync(join(repo, "script.sh")).mode & 0o111).not.toBe(0);
      expect(lstatSync(join(repo, "app-link")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(repo, "app-link"))).toBe("app.js");
    } finally {
      wt.remove();
    }
  });
});

describe("secrets side-channel env injection", () => {
  test("store resolves and wipes; secrets are never returned after wipe", () => {
    const store = new SecretStore();
    store.put("r", "DB_PASS", "s3cr3t");
    expect(store.resolve("r", ["DB_PASS"])).toEqual([{ name: "DB_PASS", value: "s3cr3t" }]);
    store.wipe("r");
    expect(store.resolve("r", ["DB_PASS"])).toEqual([]);
  });
});
