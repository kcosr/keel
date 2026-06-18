// Static workflow-structure extraction for the web "Flow" view. Parses the
// run's captured workflow source into an operation/container IR the browser
// renders (with our own SVG styling) and overlays runtime status on. This is
// deliberately a web-transport concern: it reuses the source the run-detail
// response already carries and keeps the TypeScript parser out of the browser
// bundle.

import { parseWorkflowSource } from "./workflow-flow-extract.ts";
import type { Diagnostic, EntryInfo, InputInfo, WorkflowOperation } from "./workflow-flow-ir.ts";

export interface WorkflowFlowView {
  entry: EntryInfo;
  input: InputInfo | null;
  operations: WorkflowOperation[];
  diagnostics: Diagnostic[];
}

interface SourceLike {
  entry?: string | null;
  files?: Array<{ path: string; code: string; entry: boolean }>;
}

/** Build the workflow-structure IR from a captured source view, or null when
 *  there is no parseable entry file or no recognized operations. */
export function buildWorkflowFlow(source: SourceLike | null | undefined): WorkflowFlowView | null {
  const files = source?.files ?? [];
  if (files.length === 0) return null;
  const entryFile =
    files.find((file) => file.path === source?.entry) ??
    files.find((file) => file.entry) ??
    files[0];
  if (!entryFile) return null;
  try {
    const ir = parseWorkflowSource(entryFile.path, entryFile.code);
    if (ir.operations.length === 0) return null;
    return {
      entry: ir.entry,
      input: ir.input,
      operations: ir.operations,
      diagnostics: ir.diagnostics,
    };
  } catch {
    // Source that does not parse (or is not a recognizable workflow) simply has
    // no flow view; the rest of run detail is unaffected.
    return null;
  }
}
