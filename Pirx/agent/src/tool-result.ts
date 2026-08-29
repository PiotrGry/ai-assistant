interface ToolContent {
  readonly type?: unknown;
  readonly text?: unknown;
}

export interface McpToolResultLike {
  readonly content?: readonly ToolContent[] | undefined;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
}

export function toolResultToText(result: McpToolResultLike): string {
  let body: string;

  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    body = JSON.stringify(result.structuredContent);
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

  return result.isError === true ? `Błąd narzędzia: ${body}` : body;
}
