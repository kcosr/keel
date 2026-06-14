export interface TableCellOptions {
  maxWidth?: number;
}

export interface TableCell {
  readonly __tableCell: true;
  readonly value: unknown;
  readonly maxWidth?: number;
}

export type TableCellInput = string | number | boolean | null | undefined | TableCell;

export function tableCell(value: unknown, opts: TableCellOptions = {}): TableCell {
  if (opts.maxWidth !== undefined && opts.maxWidth < 0) {
    throw new Error("table cell maxWidth must be non-negative");
  }
  return opts.maxWidth === undefined
    ? { __tableCell: true, value }
    : { __tableCell: true, value, maxWidth: opts.maxWidth };
}

export function formatTable(
  headers: readonly TableCellInput[],
  rows: readonly (readonly TableCellInput[])[],
): string {
  if (headers.length === 0) return "";
  const normalizedHeaders = headers.map(normalizeCell);
  const normalizedRows = rows.map((row, rowIndex) => {
    if (row.length !== headers.length) {
      throw new Error(
        `table row ${rowIndex + 1} has ${row.length} cells; expected ${headers.length}`,
      );
    }
    return row.map(normalizeCell);
  });
  const widths = normalizedHeaders.map((header, column) =>
    Math.max(header.length, ...normalizedRows.map((row) => row[column]?.length ?? 0)),
  );
  const lines = [normalizedHeaders, ...normalizedRows].map((row) => formatTableRow(row, widths));
  return `${lines.join("\n")}\n`;
}

export function sanitizeTableText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

export function truncateText(value: string, maxWidth: number): string {
  if (maxWidth < 0) throw new Error("maxWidth must be non-negative");
  const chars = Array.from(value);
  if (chars.length <= maxWidth) return value;
  if (maxWidth === 0) return "";
  if (maxWidth === 1) return "…";
  return `${chars.slice(0, maxWidth - 1).join("")}…`;
}

function normalizeCell(cell: TableCellInput): string {
  if (isTableCellObject(cell)) {
    const text = sanitizeTableText(cell.value);
    return cell.maxWidth === undefined ? text : truncateText(text, cell.maxWidth);
  }
  return sanitizeTableText(cell);
}

function isTableCellObject(cell: TableCellInput): cell is TableCell {
  return typeof cell === "object" && cell !== null && "__tableCell" in cell;
}

function formatTableRow(row: readonly string[], widths: readonly number[]): string {
  return row
    .map((cell, column) => {
      if (column === row.length - 1) return cell;
      return `${cell.padEnd(widths[column] ?? 0)}  `;
    })
    .join("");
}
