import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import type { BrowseDirectoriesRequest, BrowseDirectoriesResult } from "./contract.ts";

export const DIRECTORY_BROWSE_MAX_PATH_LENGTH = 4_096;
export const DIRECTORY_BROWSE_MAX_ENTRIES = 1_000;

export async function browseDirectoriesOnHost(
  req: BrowseDirectoriesRequest,
): Promise<BrowseDirectoriesResult> {
  const requestedPath = requireBrowsePath(req.path);
  const path = resolve(expandHome(requestedPath));

  let entries: Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot browse directory "${path}": ${detail}`);
  }

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    path,
    parentPath: path === parse(path).root ? null : dirname(path),
    entries: directories.slice(0, DIRECTORY_BROWSE_MAX_ENTRIES),
    truncated: directories.length > DIRECTORY_BROWSE_MAX_ENTRIES,
  };
}

function requireBrowsePath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("browseDirectories requires a non-empty path");
  }
  const path = value.trim();
  if (path.length > DIRECTORY_BROWSE_MAX_PATH_LENGTH) {
    throw new Error(
      `browseDirectories path must be at most ${DIRECTORY_BROWSE_MAX_PATH_LENGTH} characters`,
    );
  }
  if (path.includes("\0")) throw new Error("browseDirectories path must not contain null bytes");
  return path;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
