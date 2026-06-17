import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "./controls";

export interface CodeViewerSource {
  entry: string;
  files: Array<{ path: string; code: string; entry: boolean }>;
}

export function CodeViewer({
  source,
  emptyDetail = "The current credential may not include source access.",
}: {
  source: CodeViewerSource | null;
  emptyDetail?: string;
}) {
  const files = source?.files ?? [];
  const initial = useMemo(
    () => files.find((file) => file.entry)?.path ?? files[0]?.path ?? "",
    [files],
  );
  const [selected, setSelected] = useState(initial);

  useEffect(() => {
    setSelected(initial);
  }, [initial]);

  const active = files.find((file) => file.path === (selected || initial)) ?? files[0];

  if (!source || files.length === 0 || !active) {
    return <EmptyState title="No source available" detail={emptyDetail} />;
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
