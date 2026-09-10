export type ChatItem =
  | { readonly kind: "user" | "assistant"; readonly content: string }
  | { readonly kind: "error"; readonly content: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly status: "running" | "done" | "error";
      readonly durationMs?: number;
      readonly detail?: string;
    };

export interface HistoryLine {
  readonly key: string;
  readonly kind: ChatItem["kind"];
  readonly text: string;
}

function wrapText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];

  for (const sourceLine of value.split("\n")) {
    const characters = Array.from(sourceLine);
    if (characters.length === 0) {
      lines.push("");
      continue;
    }
    for (let offset = 0; offset < characters.length; offset += safeWidth) {
      lines.push(characters.slice(offset, offset + safeWidth).join(""));
    }
  }

  return lines;
}

function toolText(item: Extract<ChatItem, { readonly kind: "tool" }>): string {
  if (item.status === "running") return `[tool] ${item.name} …`;
  const duration = item.durationMs === undefined ? "" : ` ${Math.round(item.durationMs)} ms`;
  const prefix = item.status === "error" ? `[tool error] ${item.name} ✕${duration}` : `[tool] ${item.name} ✓${duration}`;
  return item.detail === undefined ? prefix : `${prefix} — ${item.detail}`;
}

export function buildHistoryLines(items: readonly ChatItem[], width: number): HistoryLine[] {
  const lines: HistoryLine[] = [];

  items.forEach((item, itemIndex) => {
    if (item.kind === "tool") {
      wrapText(toolText(item), width).forEach((text, lineIndex) => {
        lines.push({
          key: `history-${itemIndex}-${lineIndex}`,
          kind: item.kind,
          text,
        });
      });
      return;
    }

    const label = item.kind === "user" ? "You:" : item.kind === "assistant" ? "Pirx:" : "Pirx error:";
    lines.push({
      key: `history-${itemIndex}-label`,
      kind: item.kind,
      text: label,
    });
    const contentLines = wrapText(item.content, Math.max(1, width - 2));
    contentLines.forEach((text, lineIndex) => {
      lines.push({
        key: `history-${itemIndex}-content-${lineIndex}`,
        kind: item.kind,
        text: `  ${text}`,
      });
    });
    lines.push({
      key: `history-${itemIndex}-spacing`,
      kind: item.kind,
      text: "",
    });
  });

  return lines;
}
