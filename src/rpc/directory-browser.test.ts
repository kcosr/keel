import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseDirectoriesOnHost } from "./directory-browser.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("browseDirectoriesOnHost", () => {
  test("returns sorted child directories and ignores files", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-directory-browser-"));
    roots.push(root);
    mkdirSync(join(root, "zeta"));
    mkdirSync(join(root, "Alpha"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "notes.txt"), "not a directory");

    await expect(browseDirectoriesOnHost({ path: root })).resolves.toEqual({
      path: root,
      parentPath: tmpdir(),
      entries: [
        { name: ".hidden", path: join(root, ".hidden") },
        { name: "Alpha", path: join(root, "Alpha") },
        { name: "zeta", path: join(root, "zeta") },
      ],
      truncated: false,
    });
  });

  test("rejects invalid and unreadable paths explicitly", async () => {
    await expect(browseDirectoriesOnHost({ path: "" })).rejects.toThrow(
      "browseDirectories requires a non-empty path",
    );
    await expect(
      browseDirectoriesOnHost({ path: join(tmpdir(), "missing-keel-directory") }),
    ).rejects.toThrow(/cannot browse directory/);
  });
});
