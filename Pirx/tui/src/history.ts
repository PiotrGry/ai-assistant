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
  readonly emphasis?: boolean;
}

type TableAlignment = "left" | "center" | "right";

interface FormattedContentLine {
  readonly text: string;
  readonly emphasis?: boolean;
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

function splitTableRow(value: string): string[] | undefined {
  let source = value.trim();
  if (!source.includes("|")) return undefined;
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (const character of source) {
    if (character === "|" && !escaped) {
      cells.push(cell.trim().replaceAll("\\|", "|"));
      cell = "";
      continue;
    }
    cell += character;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  cells.push(cell.trim().replaceAll("\\|", "|"));
  return cells.length > 0 ? cells : undefined;
}

function tableAlignment(value: string): TableAlignment | undefined {
  const cell = value.trim();
  if (!/^:?-{1,}:?$/u.test(cell)) return undefined;
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : "left";
}

function textWidth(value: string): number {
  return Array.from(value).length;
}

function padTableCell(value: string, width: number, alignment: TableAlignment): string {
  const padding = Math.max(0, width - textWidth(value));
  if (alignment === "right") return `${" ".repeat(padding)}${value}`;
  if (alignment === "center") {
    const rightPadding = Math.ceil(padding / 2);
    return `${" ".repeat(padding - rightPadding)}${value}${" ".repeat(rightPadding)}`;
  }
  return `${value}${" ".repeat(padding)}`;
}

function renderMarkdownTable(sourceLines: readonly string[], start: number, width: number): { readonly end: number; readonly lines: readonly FormattedContentLine[] } | undefined {
  const header = splitTableRow(sourceLines[start] ?? "");
  const separator = splitTableRow(sourceLines[start + 1] ?? "");
  if (header === undefined || separator === undefined || header.length !== separator.length || header.length === 0) return undefined;
  const alignments = separator.map(tableAlignment);
  if (alignments.some((alignment) => alignment === undefined)) return undefined;

  const rows: string[][] = [header];
  let end = start + 2;
  while (end < sourceLines.length) {
    const row = splitTableRow(sourceLines[end] ?? "");
    if (row === undefined || row.length !== header.length) break;
    rows.push(row);
    end += 1;
  }

  const columnCount = header.length;
  const availableContentWidth = width - (3 * columnCount + 1);
  if (availableContentWidth < columnCount) return undefined;
  const widths = Array.from({ length: columnCount }, (_, column) => Math.max(1, ...rows.map((row) => Math.min(textWidth(row[column] ?? ""), availableContentWidth))));
  while (widths.reduce((total, value) => total + value, 0) > availableContentWidth) {
    const widest = widths.reduce((best, value, index) => value > (widths[best] ?? 0) ? index : best, 0);
    const widestWidth = widths[widest] ?? 1;
    if (widestWidth <= 1) break;
    widths[widest] = widestWidth - 1;
  }

  const border = (left: string, join: string, right: string, fill: string): string => `${left}${widths.map((columnWidth) => fill.repeat(columnWidth)).join(join)}${right}`;
  const lines: FormattedContentLine[] = [{ text: border("┌", "┬", "┐", "─") }];
  rows.forEach((row, rowIndex) => {
    const cellLines = row.map((cell, column) => wrapText(cell, widths[column] ?? 1));
    const rowHeight = Math.max(...cellLines.map((cell) => cell.length));
    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex += 1) {
      const cells = cellLines.map((cell, column) => padTableCell(cell[lineIndex] ?? "", widths[column] ?? 1, alignments[column] ?? "left"));
      lines.push({ text: `│${cells.map((cell) => ` ${cell} `).join("│")}│`, ...(rowIndex === 0 ? { emphasis: true } : {}) });
    }
    if (rowIndex < rows.length - 1) lines.push({ text: border("├", "┼", "┤", "─") });
  });
  lines.push({ text: border("└", "┴", "┘", "─") });
  return { end, lines };
}

function formatContent(value: string, width: number): FormattedContentLine[] {
  const lines: FormattedContentLine[] = [];
  const sourceLines = value.split("\n");
  let inFence = false;
  for (let index = 0; index < sourceLines.length;) {
    const sourceLine = sourceLines[index] ?? "";
    const trimmed = sourceLine.trim();
    if (trimmed.startsWith("```")) inFence = !inFence;
    if (!inFence && index + 1 < sourceLines.length) {
      const table = renderMarkdownTable(sourceLines, index, width);
      if (table !== undefined) {
        lines.push(...table.lines);
        index = table.end;
        continue;
      }
    }
    wrapText(sourceLine, width).forEach((text) => lines.push({ text }));
    index += 1;
  }
  return lines;
}

function toolText(item: Extract<ChatItem, { readonly kind: "tool" }>): string {
  if (item.status === "running") return `[tool] ${item.name} …`;
  const duration = item.durationMs === undefined ? "" : ` ${Math.round(item.durationMs)} ms`;
  const prefix = item.status === "error" ? `[tool error] ${item.name} ✕${duration}` : `[tool] ${item.name} ✓${duration}`;
  return item.detail === undefined ? prefix : `${prefix} — ${item.detail}`;
}

function messageLabel(item: Exclude<ChatItem, { readonly kind: "tool" }>): string {
  return item.kind === "user" ? "You" : item.kind === "assistant" ? "Pirx" : "Pirx error";
}

function messageColorKind(item: Exclude<ChatItem, { readonly kind: "tool" }>): ChatItem["kind"] {
  return item.kind;
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

    const label = messageLabel(item);
    const headerWidth = Math.max(1, width - label.length - 5);
    lines.push({
      key: `history-${itemIndex}-label`,
      kind: messageColorKind(item),
      text: `┌─ ${label} ${"─".repeat(headerWidth)}┐`,
      emphasis: true,
    });
    const contentLines = formatContent(item.content, Math.max(1, width - 2));
    contentLines.forEach((line, lineIndex) => {
      lines.push({
        key: `history-${itemIndex}-content-${lineIndex}`,
        kind: item.kind,
        text: `│ ${line.text}`,
        ...(line.emphasis === true ? { emphasis: true } : {}),
      });
    });
    lines.push({
      key: `history-${itemIndex}-footer`,
      kind: item.kind,
      text: `└${"─".repeat(Math.max(1, width - 2))}┘`,
    });
    lines.push({ key: `history-${itemIndex}-spacing`, kind: item.kind, text: "" });
  });

  return lines;
}
