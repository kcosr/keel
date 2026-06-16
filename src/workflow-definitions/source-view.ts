import type { WorkflowDefinitionRow } from "../journal/types.ts";
import { validateWorkflowModulePath } from "./imports.ts";

export interface WorkflowDefinitionSourceFile {
  path: string;
  code: string;
  entry: boolean;
}

export interface WorkflowDefinitionSourceSelection {
  entry: string;
  files: WorkflowDefinitionSourceFile[];
}

interface PersistedWorkflowDefinitionManifest {
  format?: unknown;
  entry?: unknown;
  modules?: unknown;
}

export function workflowDefinitionSourceSelection(
  row: WorkflowDefinitionRow,
  opts: { file?: string; all?: boolean } = {},
): WorkflowDefinitionSourceSelection {
  if (opts.file !== undefined && opts.all) {
    throw new Error("--file and --all are mutually exclusive");
  }
  const { entry, files: allFiles } = workflowDefinitionSourceFiles(row);
  let files = allFiles;
  if (opts.file !== undefined) {
    validateWorkflowModulePath(opts.file, "workflow source file path");
    const file = files.find((candidate) => candidate.path === opts.file);
    if (!file) throw new Error(`workflow source file ${opts.file} does not exist`);
    files = [file];
  } else if (!opts.all) {
    const file = files.find((candidate) => candidate.entry);
    if (!file) throw invalidDefinition(row.hash, `manifest entry ${entry} is missing`);
    files = [file];
  }
  return { entry, files };
}

export function workflowDefinitionSourceFiles(
  row: WorkflowDefinitionRow,
): WorkflowDefinitionSourceSelection {
  try {
    const manifest = parseSourceManifest(row);
    if (manifest === null || manifest.modules.length === 0) {
      return {
        entry: "entry.ts",
        files: [{ path: "entry.ts", code: row.code, entry: true }],
      };
    }
    validateWorkflowModulePath(manifest.entry, "workflow entry path");
    const seen = new Set<string>();
    let entryCount = 0;
    const files = manifest.modules.map((module) => {
      validateWorkflowModulePath(module.path);
      if (seen.has(module.path)) throw new Error(`manifest has duplicate module ${module.path}`);
      seen.add(module.path);
      const entry = module.path === manifest.entry;
      if (entry) entryCount += 1;
      return { path: module.path, code: module.code, entry };
    });
    if (entryCount !== 1) throw new Error(`manifest entry ${manifest.entry} is missing`);
    const entryFile = files.find((file) => file.entry);
    if (!entryFile) throw new Error(`manifest entry ${manifest.entry} is missing`);
    const helpers = files
      .filter((file) => !file.entry)
      .sort((a, b) => a.path.localeCompare(b.path));
    return { entry: manifest.entry, files: [entryFile, ...helpers] };
  } catch (err) {
    throw invalidDefinition(row.hash, err instanceof Error ? err.message : String(err));
  }
}

function parseSourceManifest(
  row: WorkflowDefinitionRow,
): { entry: string; modules: Array<{ path: string; code: string }> } | null {
  if (!row.manifestJson) return null;
  const parsed = JSON.parse(row.manifestJson) as PersistedWorkflowDefinitionManifest;
  if (parsed.format !== "keel.workflow-definition.v1") {
    throw new Error("unsupported workflow definition manifest");
  }
  if (!Array.isArray(parsed.modules)) {
    throw new Error("manifest modules must be an array");
  }
  if (parsed.modules.length === 0) {
    return { entry: "entry.ts", modules: [] };
  }
  if (typeof parsed.entry !== "string") {
    throw new Error("manifest entry must be a string");
  }
  const modules = parsed.modules.map((module) => {
    if (
      typeof module !== "object" ||
      module === null ||
      typeof (module as { path?: unknown }).path !== "string" ||
      typeof (module as { code?: unknown }).code !== "string"
    ) {
      throw new Error("manifest module entries are invalid");
    }
    return {
      path: (module as { path: string }).path,
      code: (module as { code: string }).code,
    };
  });
  return { entry: parsed.entry, modules };
}

function invalidDefinition(hash: string, reason: string): Error {
  return new Error(`workflow definition ${hash} cannot display source: ${reason}`);
}
