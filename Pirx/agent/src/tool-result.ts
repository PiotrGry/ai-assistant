interface ToolContent {
  readonly type?: unknown;
  readonly text?: unknown;
}

export interface McpToolResultLike {
  readonly content?: readonly ToolContent[] | undefined;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
}

// Longest text kept per string field, from the most to the least generous, when a result is too large.
const TEXT_FIELD_LIMITS = [2_000, 1_000, 500, 300, 150, 80];
const MAX_ARRAY_REDUCTIONS = 10;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function summarizeDiagnosticResult(value: unknown, maxCharacters: number, toolName: string | undefined): string | undefined {
  const result = record(value);
  if (result?.outcome !== "success") return undefined;
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxCharacters) return serialized;

  if (toolName === "pirx_orchestrator_diagnostic") {
    const page = record(result.diagnostic);
    if (page === undefined || !Number.isSafeInteger(page.sequence) || !Number.isSafeInteger(page.offset)
      || !Number.isSafeInteger(page.totalCharacters) || typeof page.text !== "string") return undefined;
    const offset = page.offset as number;
    const total = page.totalCharacters as number;
    const text = page.text;
    if (offset < 0 || total < offset || text.length > total - offset) return undefined;
    const make = (length: number): string => JSON.stringify({
      outcome: "success", truncated: true,
      diagnostic: { sequence: page.sequence, offset, totalCharacters: total, text: text.slice(0, length),
        ...(offset + length < total ? { nextOffset: offset + length } : {}) },
    });
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (make(middle).length <= maxCharacters) low = middle;
      else high = middle - 1;
    }
    const summary = make(low);
    return summary.length <= maxCharacters && (low > 0 || text.length === 0) ? summary : undefined;
  }

  if (toolName === "pirx_orchestrator_status") {
    const snapshot = record(result.snapshot);
    if (snapshot === undefined || !Array.isArray(snapshot.diagnostics)) return undefined;
    const diagnostics = snapshot.diagnostics;
    const summary: Record<string, unknown> = { outcome: "success", truncated: true, snapshot: { diagnostics: [] } };
    const compactSnapshot = summary.snapshot as { diagnostics: Record<string, unknown>[]; [key: string]: unknown };
    for (const item of diagnostics) {
      const diagnostic = record(item);
      if (diagnostic === undefined || !Number.isSafeInteger(diagnostic.sequence)) continue;
      const compact: Record<string, unknown> = { sequence: diagnostic.sequence };
      const details = record(diagnostic.details);
      if (typeof details?.correlationId === "string") compact.details = { correlationId: details.correlationId };
      for (const key of ["event", "outcome"]) {
        if (typeof diagnostic[key] === "string") compact[key] = diagnostic[key];
      }
      compactSnapshot.diagnostics.push(compact);
      if (JSON.stringify(summary).length > maxCharacters) {
        delete compact.event;
        delete compact.outcome;
        if (JSON.stringify(summary).length > maxCharacters) delete compact.details;
        if (JSON.stringify(summary).length > maxCharacters) {
          compactSnapshot.diagnostics.pop();
          break;
        }
      }
    }
    for (const key of ["observedState", "requestedMode"]) {
      if (typeof snapshot[key] !== "string") continue;
      compactSnapshot[key] = snapshot[key];
      if (JSON.stringify(summary).length > maxCharacters) delete compactSnapshot[key];
    }
    return JSON.stringify(summary);
  }
  return undefined;
}

function shortenStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") {
    return value.length <= limit
      ? value
      : `${value.slice(0, limit)}… [skrócono z ${value.length} znaków]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => shortenStrings(item, limit));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shortenStrings(item, limit)]),
    );
  }
  return value;
}

function annotate(value: unknown, originalCharacters: number): Record<string, unknown> {
  const note = { truncated: true, original_characters: originalCharacters };
  if (Array.isArray(value)) {
    return { ...note, value_type: "array", items: value };
  }
  if (typeof value === "object" && value !== null) {
    return { ...note, ...(value as Record<string, unknown>) };
  }
  return { ...note, value_type: typeof value, value };
}

interface ArrayLocation {
  readonly parent: Record<string, unknown>;
  readonly key: string;
  readonly items: readonly unknown[];
}

function largestArray(root: unknown): ArrayLocation | undefined {
  let best: ArrayLocation | undefined;
  let bestSize = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (Array.isArray(item) && item.length > 0) {
        const size = JSON.stringify(item).length;
        if (size > bestSize) {
          best = { parent: record, key, items: item };
          bestSize = size;
        }
      }
      visit(item);
    }
  };
  visit(root);
  return best;
}

// Drops trailing items from the largest arrays and records how many were left out next to each array.
function dropArrayItems(root: Record<string, unknown>, maxCharacters: number): string | undefined {
  for (let reduction = 0; reduction < MAX_ARRAY_REDUCTIONS; reduction += 1) {
    if (JSON.stringify(root).length <= maxCharacters) {
      break;
    }
    const target = largestArray(root);
    if (target === undefined) {
      return undefined;
    }
    const omittedKey = `${target.key}_omitted`;
    const alreadyOmitted =
      typeof target.parent[omittedKey] === "number" ? (target.parent[omittedKey] as number) : 0;
    const keep = (count: number): void => {
      target.parent[target.key] = target.items.slice(0, count);
      target.parent[omittedKey] = alreadyOmitted + target.items.length - count;
    };
    let low = 0;
    let high = target.items.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      keep(middle);
      if (JSON.stringify(root).length <= maxCharacters) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    keep(low);
  }
  const serialized = JSON.stringify(root);
  return serialized.length <= maxCharacters ? serialized : undefined;
}

function summarizeStructured(value: unknown, maxCharacters: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxCharacters) {
    return serialized;
  }

  // Keep the result's shape: shorten long text fields first, then drop trailing array items.
  for (const limit of TEXT_FIELD_LIMITS) {
    const candidate = JSON.stringify(annotate(shortenStrings(value, limit), serialized.length));
    if (candidate.length <= maxCharacters) {
      return candidate;
    }
  }
  const reduced = dropArrayItems(
    annotate(shortenStrings(value, TEXT_FIELD_LIMITS.at(-1) ?? 80), serialized.length),
    maxCharacters,
  );
  if (reduced !== undefined) {
    return reduced;
  }

  const summary: Record<string, unknown> = {
    truncated: true,
    original_characters: serialized.length,
    value_type: Array.isArray(value) ? "array" : typeof value,
  };
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const candidate = {
        ...summary,
        items: [...items, item],
        omitted_items: value.length - items.length - 1,
      };
      if (JSON.stringify(candidate).length > maxCharacters) {
        break;
      }
      items.push(item);
    }
    summary.items = items;
    summary.omitted_items = value.length - items.length;
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const metadataKeys = ["error", "id", "status", "name", "message"];
    for (const key of metadataKeys) {
      if (!(key in record)) {
        continue;
      }
      const candidate = { ...summary, [key]: record[key] };
      if (JSON.stringify(candidate).length <= maxCharacters) {
        summary[key] = record[key];
      }
    }
    summary.omitted_fields = Object.keys(record).filter(
      (key) => !(key in summary),
    ).length;
  }
  return JSON.stringify(summary);
}

function reduceText(body: string, maxCharacters: number): string {
  if (body.length <= maxCharacters) {
    return body;
  }
  try {
    return summarizeStructured(JSON.parse(body), maxCharacters);
  } catch {
    const lines = body.split("\n");
    const kept: string[] = [];
    let characters = 0;
    for (const line of lines) {
      const nextLength = characters + (kept.length === 0 ? 0 : 1) + line.length;
      if (nextLength > Math.max(0, maxCharacters - 80)) {
        break;
      }
      kept.push(line);
      characters = nextLength;
    }
    return `${kept.join("\n")}\n[wynik skrócony; pełna długość: ${body.length} znaków]`;
  }
}

export function toolResultToText(
  result: McpToolResultLike,
  maxCharacters = 12_000,
  toolName?: string,
): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 256) {
    throw new Error(`maxCharacters must be an integer >= 256: ${maxCharacters}`);
  }
  let body: string;
  const prefix = result.isError === true ? "Błąd narzędzia: " : "";
  const bodyBudget = Math.max(1, maxCharacters - prefix.length);

  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    body = summarizeDiagnosticResult(result.structuredContent, bodyBudget, toolName)
      ?? summarizeStructured(result.structuredContent, bodyBudget);
  } else {
    body = (result.content ?? [])
      .filter(
        (item): item is ToolContent & { type: "text"; text: string } =>
          item.type === "text" && typeof item.text === "string",
      )
      .map((item) => item.text)
      .join("\n");
  }

  if (body.length === 0) {
    body = "Narzędzie nie zwróciło treści.";
  }

  return prefix + reduceText(body, bodyBudget);
}
