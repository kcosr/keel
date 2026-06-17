export type DiffMode = "unified" | "split";

export function DiffView({
  diff,
  mode = "unified",
}: { diff: string | null | undefined; mode?: DiffMode }) {
  if (!diff) return <div className="table-empty">No diff content available.</div>;
  const lines = diff.split(/\r?\n/);
  if (mode === "split") return <SplitDiff lines={lines} />;
  return (
    <pre className="diff-view diff-view-unified">
      {lines.map((line, index) => (
        <span className={`diff-line ${diffLineClass(line)}`} key={`${index}:${line}`}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function SplitDiff({ lines }: { lines: string[] }) {
  return (
    <div className="diff-view diff-view-split">
      {lines.map((line, index) => {
        const kind = diffLineKind(line);
        return (
          <div className={`diff-split-row ${diffLineClass(line)}`} key={`${index}:${line}`}>
            <div className="diff-split-cell diff-split-old">
              {kind === "delete" || kind === "context" || kind === "meta" ? line || " " : ""}
            </div>
            <div className="diff-split-cell diff-split-new">
              {kind === "add" || kind === "context" || kind === "meta" ? line || " " : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function diffLineClass(line: string): string {
  return `diff-line-${diffLineKind(line)}`;
}

function diffLineKind(line: string): "add" | "delete" | "hunk" | "meta" | "context" {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "delete";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("---") ||
    line.startsWith("+++")
  ) {
    return "meta";
  }
  return "context";
}
