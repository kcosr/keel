export interface WorkflowSourceModule {
  /** POSIX relative path inside the captured bundle. */
  path: string;
  /** UTF-8 TypeScript source text exactly as captured. */
  code: string;
}

export interface WorkflowSourceBundle {
  kind: "bundle";
  /** Module path that supplies the workflow default export. */
  entry: string;
  /** Complete reachable runtime import graph, including entry. */
  modules: WorkflowSourceModule[];
}

export type WorkflowSourceInput = string | WorkflowSourceBundle;

export const WORKFLOW_SOURCE_ROOT = "client-captured://source";
export const WORKFLOW_MODULE_EXTENSIONS = [".ts", ".tsx"] as const;
export const WORKFLOW_INDEX_MODULES = ["index.ts", "index.tsx"] as const;
export const MAX_WORKFLOW_BUNDLE_MODULES = 64;
