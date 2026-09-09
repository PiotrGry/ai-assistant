export interface TuiLayout {
  readonly rows: number;
  readonly columns: number;
  readonly contentWidth: number;
  readonly compact: boolean;
  readonly historyItems: number;
  readonly modelItems: number;
}

export function calculateTuiLayout(
  rows: number | undefined,
  columns: number | undefined,
): TuiLayout {
  const terminalRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows ?? 24)) : 24;
  const terminalColumns = Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns ?? 80))
    : 80;
  const compact = terminalColumns < 100;

  return {
    rows: Math.max(10, terminalRows),
    columns: terminalColumns,
    contentWidth: Math.max(1, terminalColumns - 2),
    compact,
    historyItems: Math.max(4, terminalRows - (compact ? 11 : 9)),
    modelItems: Math.max(1, terminalRows - 9),
  };
}
