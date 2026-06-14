import { redactCapabilityTokens } from "../auth/redaction.ts";

export const DEFAULT_TERMINAL_COMPACT_MAX = 300;

export function compactTerminalText(value: unknown, max = DEFAULT_TERMINAL_COMPACT_MAX): string {
  if (max < 0) throw new Error("max must be non-negative");
  let text = stringifyTerminalValue(value);
  text = stripAnsiSequences(text);
  text = redactCapabilityTokens(text);
  text = text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\r", "\\r");
  text = stripTerminalControlCharacters(text, { preserveLineFeed: false, preserveTab: false });
  return truncateEnd(text, max, "...");
}

export function sanitizeTerminalInlineText(value: string): string {
  return redactCapabilityTokens(
    stripTerminalControlCharacters(stripAnsiSequences(value), {
      preserveLineFeed: true,
      preserveTab: true,
    }),
  );
}

export function sanitizeTerminalTableText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return redactCapabilityTokens(
    stripTerminalControlCharacters(stripAnsiSequences(String(value)).replace(/\s+/g, " "), {
      preserveLineFeed: false,
      preserveTab: false,
    }),
  ).trim();
}

export function sanitizeTerminalLineText(value: string): string {
  const stripped = stripAnsiSequences(value);
  let out = "";
  for (const char of stripped) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += " ";
      continue;
    }
    if (isTerminalControlCode(code)) continue;
    out += char;
  }
  return redactCapabilityTokens(out);
}

export function stripAnsiSequences(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; ) {
    const code = value.charCodeAt(i);
    if (code === 0x1b) {
      i = skipEscSequence(value, i);
      continue;
    }
    if (code === 0x9b) {
      i = skipCsiSequence(value, i + 1);
      continue;
    }
    if (code === 0x9d) {
      i = skipOscSequence(value, i + 1);
      continue;
    }
    out += value[i];
    i += 1;
  }
  return out;
}

export function truncateEnd(value: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth < 0) throw new Error("maxWidth must be non-negative");
  const chars = Array.from(value);
  if (chars.length <= maxWidth) return value;
  if (maxWidth === 0) return "";
  if (maxWidth <= ellipsis.length) return ellipsis.slice(0, maxWidth);
  return `${chars.slice(0, maxWidth - ellipsis.length).join("")}${ellipsis}`;
}

export function trailingTextWindow(value: string, maxWidth: number): string {
  if (maxWidth < 0) throw new Error("maxWidth must be non-negative");
  const chars = Array.from(value);
  if (chars.length <= maxWidth) return value;
  if (maxWidth === 0) return "";
  if (maxWidth === 1) return "…";
  return `…${chars.slice(-(maxWidth - 1)).join("")}`;
}

function stringifyTerminalValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function stripTerminalControlCharacters(
  value: string,
  opts: { preserveLineFeed: boolean; preserveTab: boolean },
): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((opts.preserveTab && code === 0x09) || (opts.preserveLineFeed && code === 0x0a)) {
      out += char;
      continue;
    }
    if (isTerminalControlCode(code)) continue;
    out += char;
  }
  return out;
}

function isTerminalControlCode(code: number): boolean {
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

function skipEscSequence(value: string, index: number): number {
  const next = value.charCodeAt(index + 1);
  if (Number.isNaN(next)) return index + 1;
  if (next === 0x5b) return skipCsiSequence(value, index + 2);
  if (next === 0x5d) return skipOscSequence(value, index + 2);
  if ((next >= 0x40 && next <= 0x5a) || (next >= 0x5c && next <= 0x5f)) return index + 2;
  return index + 1;
}

function skipCsiSequence(value: string, index: number): number {
  for (let i = index; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
  }
  return value.length;
}

function skipOscSequence(value: string, index: number): number {
  for (let i = index; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x07 || code === 0x9c) return i + 1;
    if (code === 0x1b && value.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return value.length;
}
