import type { KeyboardEvent, ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  width?: string;
  className?: string;
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
            <col
              className={column.className}
              key={column.key}
              style={column.width ? { width: column.width } : undefined}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th className={columnClassName(column)} key={column.key}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row);
            const selected = selectedKey === key;
            const activate = () => onRowClick?.(row);
            const activateAt = (event: KeyboardEvent<HTMLTableRowElement>, nextIndex: number) => {
              const next = rows[nextIndex];
              if (!next) return;
              event.preventDefault();
              const nextRow = event.currentTarget.parentElement?.children.item(nextIndex);
              if (nextRow instanceof HTMLElement) nextRow.focus();
              onRowClick?.(next);
            };
            return (
              <tr
                className={`${selected ? "is-selected" : ""} ${onRowClick ? "is-clickable" : ""}`}
                key={key}
                onClick={onRowClick ? activate : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (isInteractiveEventTarget(event.target, event.currentTarget)) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          activate();
                          return;
                        }
                        if (event.key === "ArrowDown") activateAt(event, index + 1);
                        if (event.key === "ArrowUp") activateAt(event, index - 1);
                        if (event.key === "Home") activateAt(event, 0);
                        if (event.key === "End") activateAt(event, rows.length - 1);
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
              >
                {columns.map((column) => (
                  <td className={columnClassName(column)} key={column.key}>
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

function columnClassName<T>(column: Column<T>): string | undefined {
  const classes = [column.align ? `align-${column.align}` : null, column.className].filter(Boolean);
  return classes.length > 0 ? classes.join(" ") : undefined;
}

function isInteractiveEventTarget(target: EventTarget, row: HTMLTableRowElement): boolean {
  if (!(target instanceof Element) || target === row) return false;
  const interactive = target.closest(
    "a, button, input, select, textarea, [role='button'], [role='link'], [contenteditable='true']",
  );
  return interactive !== null && row.contains(interactive);
}
