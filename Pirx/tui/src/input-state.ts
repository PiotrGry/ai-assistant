export interface ComposerState {
  readonly value: string;
  readonly cursor: number;
}

export interface ComposerKey {
  readonly backspace?: boolean;
  readonly ctrl?: boolean;
  readonly delete?: boolean;
  readonly down?: boolean;
  readonly end?: boolean;
  readonly home?: boolean;
  readonly left?: boolean;
  readonly meta?: boolean;
  readonly return?: boolean;
  readonly right?: boolean;
  readonly shift?: boolean;
  readonly up?: boolean;
}

export interface ComposerResult {
  readonly state: ComposerState;
  readonly submitted?: string;
}

export function isExitCommand(value: string): boolean {
  const command = value.trim();
  return command === "/exit" || command === "/quit";
}

function lineStart(value: string, cursor: number): number {
  const newline = value.lastIndexOf("\n", cursor - 1);
  return newline + 1;
}

function lineEnd(value: string, cursor: number): number {
  const newline = value.indexOf("\n", cursor);
  return newline === -1 ? value.length : newline;
}

function moveVertical(
  state: ComposerState,
  direction: "up" | "down",
): number {
  const start = lineStart(state.value, state.cursor);
  const column = state.cursor - start;

  if (direction === "up") {
    if (start === 0) return 0;
    const previousEnd = start - 1;
    const previousStart = lineStart(state.value, previousEnd);
    return Math.min(previousStart + column, previousEnd);
  }

  const currentEnd = lineEnd(state.value, state.cursor);
  if (currentEnd === state.value.length) return state.value.length;
  const nextStart = currentEnd + 1;
  const nextEnd = lineEnd(state.value, nextStart);
  return Math.min(nextStart + column, nextEnd);
}

function insert(state: ComposerState, text: string): ComposerState {
  const value = `${state.value.slice(0, state.cursor)}${text}${state.value.slice(state.cursor)}`;
  return { value, cursor: state.cursor + text.length };
}

export function applyComposerKey(
  state: ComposerState,
  input: string,
  key: ComposerKey,
): ComposerResult {
  const shiftEnterSequence =
    input === "\u001b[13;2u" ||
    input === "[13;2u" ||
    input === "\u001b[27;13;2~" ||
    input === "[27;13;2~";

  if (shiftEnterSequence) {
    return { state: insert(state, "\n") };
  }

  if (key.return === true) {
    return { state, submitted: state.value };
  }

  if (input === "\r" || input === "\n") {
    return { state, submitted: state.value };
  }

  // Ink 5 reports the terminal's usual Backspace byte (DEL, 0x7f) as
  // `key.delete`. Treat both flags as backward deletion so Backspace works
  // across terminals.
  if (key.backspace === true || key.delete === true) {
    if (state.cursor === 0) return { state };
    return {
      state: {
        value: `${state.value.slice(0, state.cursor - 1)}${state.value.slice(state.cursor)}`,
        cursor: state.cursor - 1,
      },
    };
  }

  if (key.left === true) return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (key.right === true) {
    return { state: { ...state, cursor: Math.min(state.value.length, state.cursor + 1) } };
  }
  if (key.home === true) return { state: { ...state, cursor: lineStart(state.value, state.cursor) } };
  if (key.end === true) return { state: { ...state, cursor: lineEnd(state.value, state.cursor) } };
  if (key.up === true) return { state: { ...state, cursor: moveVertical(state, "up") } };
  if (key.down === true) return { state: { ...state, cursor: moveVertical(state, "down") } };

  if (
    input.length > 0 &&
    key.ctrl !== true &&
    key.meta !== true &&
    input !== "\r" &&
    input !== "\n"
  ) {
    return { state: insert(state, input) };
  }

  return { state };
}
