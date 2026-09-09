interface ToolContent {
  readonly type?: unknown;
  readonly text?: unknown;
}

export interface McpToolResultLike {
  readonly content?: readonly ToolContent[] | undefined;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
}

function summarizeStructured(value: unknown, maxCharacters: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxCharacters) {
    return serialized;
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
