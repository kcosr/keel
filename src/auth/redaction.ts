const CAPABILITY_TOKEN_PATTERN = /\bkc_(?:run|admin)_[A-Za-z0-9_-]+\b/g;

export function redactCapabilityTokens(text: string): string {
  return text.replace(CAPABILITY_TOKEN_PATTERN, "«redacted-capability»");
}

export function redactCapabilityTokensInValue<T>(value: T): T {
  if (typeof value === "string") return redactCapabilityTokens(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactCapabilityTokensInValue(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactCapabilityTokensInValue(item);
    return out as T;
  }
  return value;
}
