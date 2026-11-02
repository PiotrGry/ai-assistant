/** Provider diagnostics are evidence, never instructions or credential transport. */
export function diagnosticContext(value: unknown): unknown {
  const seen = new WeakSet<object>();
  function clean(item: unknown, key = ""): unknown {
    if (/^(?:token|access.?token|refresh.?token|secret|password|authorization|cookie|prompt|stdout|stderr|body|payload|checkpoint)$/iu.test(key)) return "[REDACTED]";
    if (typeof item === "string") return item
      .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})/gu, "[REDACTED]")
      .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item !== "object") return String(item);
    if (seen.has(item)) return "[CIRCULAR]";
    seen.add(item);
    const result = Array.isArray(item) ? item.map((entry) => clean(entry)) : Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, clean(entry, name)]));
    seen.delete(item);
    return result;
  }
  return clean(value);
}
