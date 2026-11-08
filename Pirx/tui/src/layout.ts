export interface TuiLayout {
  readonly rows: number;
  /** Live viewport height; one row below the terminal so Ink never clears scrollback. */
  readonly viewportRows: number;
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
    // Ink 5 clears the whole terminal and reprints all <Static> history on every
    // render once output reaches stdout.rows, which makes the chat jump.
    viewportRows: Math.max(1, terminalRows - 1),
    columns: terminalColumns,
    contentWidth: Math.max(1, terminalColumns - 2),
    compact,
    tiny,
    historyRows: tiny ? 1 : Math.max(1, terminalRows - (compact ? 9 : 8)),
    historyItems: tiny ? 1 : Math.max(2, terminalRows - (compact ? 8 : 9)),
    modelItems: tiny ? 1 : Math.max(1, terminalRows - 9),
  };
}
