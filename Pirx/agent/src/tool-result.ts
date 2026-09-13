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
): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 256) {
    throw new Error(`maxCharacters must be an integer >= 256: ${maxCharacters}`);
  }
  let body: string;

  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    body = summarizeStructured(result.structuredContent, maxCharacters);
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

  const prefix = result.isError === true ? "Błąd narzędzia: " : "";
  return prefix + reduceText(body, Math.max(1, maxCharacters - prefix.length));
}
