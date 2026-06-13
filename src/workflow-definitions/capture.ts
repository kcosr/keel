import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { WorkflowProvenance } from "../rpc/contract.ts";

export interface CapturedWorkflowFile {
  source: string;
  name: string | null;
  provenance: WorkflowProvenance;
}

export function captureWorkflowFile(path: string, name = basename(path)): CapturedWorkflowFile {
  const abs = resolve(path);
  return {
    source: readFileSync(abs, "utf8"),
    name,
    provenance: { kind: "clientPath", path: abs },
  };
}
