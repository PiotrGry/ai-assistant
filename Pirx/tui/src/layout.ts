export interface TuiLayout {
  readonly rows: number;
  readonly columns: number;
  readonly contentWidth: number;
  readonly compact: boolean;
  readonly tiny: boolean;
  readonly historyRows: number;
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
  const tiny = terminalColumns < 45 || terminalRows < 8;
  const compact = tiny || terminalColumns < 100 || terminalRows < 16;

  return {
    rows: terminalRows,
    columns: terminalColumns,
    contentWidth: Math.max(1, terminalColumns - 2),
    compact,
    tiny,
    historyRows: tiny ? 1 : Math.max(1, terminalRows - (compact ? 9 : 8)),
    historyItems: tiny ? 1 : Math.max(2, terminalRows - (compact ? 8 : 9)),
    modelItems: tiny ? 1 : Math.max(1, terminalRows - 9),
  };
}
