import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";

import { applyComposerKey, type ComposerState } from "./input-state.js";

interface ComposerProps {
  readonly clearToken: number;
  readonly disabled: boolean;
  readonly onSubmit: (value: string) => void;
}

function cursorPosition(value: string, cursor: number): { line: number; column: number } {
  const lines = value.slice(0, cursor).split("\n");
  return { line: lines.length - 1, column: lines.at(-1)?.length ?? 0 };
}

export function Composer({ clearToken, disabled, onSubmit }: ComposerProps): React.JSX.Element {
  const [state, setState] = useState<ComposerState>({ value: "", cursor: 0 });
  const [lastClearToken, setLastClearToken] = useState(clearToken);

  useEffect(() => {
    if (clearToken !== lastClearToken) {
      setState({ value: "", cursor: 0 });
      setLastClearToken(clearToken);
    }
  }, [clearToken, lastClearToken]);

  useInput((input, key) => {
    if (disabled) return;

    // Ink 5 reports line-feed Enter as a non-alphanumeric key with an empty
    // input string. Normalize that form so Enter remains distinct from the
    // modifier sequence used by Shift+Enter.
    const isPlainEnter =
      input.length === 0 &&
      !key.return &&
      !key.escape &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.pageUp &&
      !key.pageDown &&
      !key.tab &&
      !key.backspace &&
      !key.delete &&
      !key.ctrl &&
      !key.meta;
    const normalizedInput = isPlainEnter ? "\n" : input;
    const result = applyComposerKey(state, normalizedInput, {
      ...key,
      ctrl: key.ctrl,
      up: key.upArrow,
      down: key.downArrow,
      left: key.leftArrow,
      right: key.rightArrow,
    });
    if (result.submitted !== undefined) {
      onSubmit(result.submitted);
      return;
    }
    if (result.state !== state) setState(result.state);
  }, { isActive: true });

  const position = cursorPosition(state.value, state.cursor);
  const lines = state.value.split("\n");

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={disabled ? "gray" : "cyan"} paddingX={1}>
      {state.value.length === 0 ? <Text color="gray">› type a message…</Text> : lines.map((line, index) => {
        const isCursorLine = index === position.line;
        const cursorColumn = isCursorLine ? position.column : -1;
        const cursorChar = cursorColumn >= 0 ? line[cursorColumn] ?? " " : "";
        const rendered = isCursorLine
          ? <Text>{line.slice(0, cursorColumn)}<Text inverse>{cursorChar}</Text>{line.slice(cursorColumn + (cursorColumn < line.length ? 1 : 0))}</Text>
          : <Text>{line}</Text>;

        return (
          <Text key={index}>
            {index === 0 ? <Text color="cyan">› </Text> : <Text>  </Text>}
            {rendered}
          </Text>
        );
      })}
    </Box>
  );
}
