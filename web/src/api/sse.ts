export interface SseMessage {
  event: string;
  data: unknown;
  raw: string;
}

export interface SseStreamHandlers {
  onMessage(frame: SseMessage): void;
  onComment?(comment: string): void;
}

export function parseSseBlock(block: string): SseMessage | null {
  const normalized = block.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const dataLines: string[] = [];
  let event = "message";
  let sawField = false;
  const comments: string[] = [];

  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) {
      comments.push(line.slice(1).trimStart());
      continue;
    }
    sawField = true;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "event") event = value || "message";
    if (field === "data") dataLines.push(value);
  }

  if (!sawField && comments.length > 0) {
    return { event: "heartbeat", data: null, raw: normalized };
  }

  if (!sawField && dataLines.length === 0) return null;

  const dataText = dataLines.join("\n");
  return {
    event,
    data: parseData(dataText),
    raw: normalized,
  };
}

export function parseSseText(text: string): SseMessage[] {
  return splitBlocks(text).flatMap((block) => {
    const parsed = parseSseBlock(block);
    return parsed ? [parsed] : [];
  });
}

export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  handlers: SseStreamHandlers,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatchBlock(block, handlers);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) dispatchBlock(buffer, handlers);
  } finally {
    reader.releaseLock();
  }
}

function dispatchBlock(block: string, handlers: SseStreamHandlers): void {
  const parsed = parseSseBlock(block);
  if (!parsed) return;
  if (parsed.event === "heartbeat" && typeof parsed.raw === "string") {
    handlers.onComment?.(parsed.raw);
  }
  handlers.onMessage(parsed);
}

function parseData(dataText: string): unknown {
  if (dataText.length === 0) return null;
  try {
    return JSON.parse(dataText);
  } catch {
    return dataText;
  }
}

function splitBlocks(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .filter((block) => block.trim().length > 0);
}
