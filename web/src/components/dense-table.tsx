import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  width?: string;
  align?: "left" | "center" | "right";
  render(row: T): ReactNode;
}

export function DenseTable<T>({
  columns,
  rows,
  rowKey,
  selectedKey,
  onRowClick,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey(row: T): string;
  selectedKey?: string | null;
  onRowClick?(row: T): void;
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return <div className="table-empty">{empty ?? "No rows"}</div>;
  }

  return (
    <div className="table-wrap">
      <table className="dtable">
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th className={column.align ? `align-${column.align}` : undefined} key={column.key}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const selected = selectedKey === key;
            const activate = () => onRowClick?.(row);
            return (
              <tr
                className={`${selected ? "is-selected" : ""} ${onRowClick ? "is-clickable" : ""}`}
                key={key}
                onClick={onRowClick ? activate : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        activate();
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
              >
                {columns.map((column) => (
                  <td
                    className={column.align ? `align-${column.align}` : undefined}
                    key={column.key}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
