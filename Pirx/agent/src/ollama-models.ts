export interface OllamaTagsPayload {
  readonly models?: readonly unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseOllamaModelNames(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    return [];
  }

  const names: string[] = [];
  for (const model of payload.models) {
    if (!isRecord(model) || typeof model.name !== "string") {
      continue;
    }

    const name = model.name.trim();
    if (name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }

  return names;
}
