import { useMemo, useState } from "react";
import type { WorkflowDefinitionSourceView } from "../api/types";
import { EmptyState } from "./controls";

export function CodeViewer({ source }: { source: WorkflowDefinitionSourceView | null }) {
  const files = source?.files ?? [];
  const initial = useMemo(
    () => files.find((file) => file.entry)?.path ?? files[0]?.path ?? "",
    [files],
  );
  const [selected, setSelected] = useState(initial);
  const active = files.find((file) => file.path === (selected || initial)) ?? files[0];

  if (!source || files.length === 0 || !active) {
    return (
      <EmptyState
        title="No source available"
        detail="The current credential may not include run:source."
      />
    );
  }

  return (
    <div className="code-viewer">
      <div className="code-tabs">
        {files.map((file) => (
          <button
            type="button"
            className={file.path === active.path ? "is-active" : ""}
            key={file.path}
            onClick={() => setSelected(file.path)}
          >
            {file.path}
          </button>
        ))}
      </div>
      <pre className="code-block">{active.code}</pre>
    </div>
  );
}
