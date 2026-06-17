export function DiffView({ diff }: { diff: string | null | undefined }) {
  if (!diff) return <div className="table-empty">No diff content available.</div>;
  return <pre className="diff-view">{diff}</pre>;
}
