import { useEffect, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";

import type { PirxAgent, TurnMetrics } from "@pirx/agent";

import { Composer } from "./composer.js";
import type { TuiEvent } from "./events.js";
import { TuiEventBus } from "./events.js";
import { buildHistoryLines, type ChatItem } from "./history.js";
import { isExitCommand } from "./input-state.js";
import { calculateTuiLayout } from "./layout.js";
import { runRecordedTurn, type RecordedTurn, type TurnRecorder } from "./recorded-turn.js";

interface AppProps {
  readonly agent: PirxAgent;
  readonly events: TuiEventBus;
  readonly recorder?: TurnRecorder | undefined;
  readonly initialNotice?: string | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactDetail(value: string): string {
  const firstLine = value.split("\n", 1)[0] ?? value;
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine;
}

export function App({ agent, events, recorder, initialNotice }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState({
    rows: stdout.rows ?? 24,
    columns: stdout.columns ?? 80,
  });
  const [history, setHistory] = useState<ChatItem[]>([]);
  const [clearToken, setClearToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lastMetrics, setLastMetrics] = useState<TurnMetrics | undefined>();
  const [notice, setNotice] = useState<string | undefined>(initialNotice);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [models, setModels] = useState<readonly string[]>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | undefined>();
  const [activeTools, setActiveTools] = useState<readonly string[]>([]);

  const layout = calculateTuiLayout(terminalSize.rows, terminalSize.columns);

  useEffect(() => {
    const updateTerminalSize = (): void => {
      setTerminalSize({
        rows: stdout.rows ?? 24,
        columns: stdout.columns ?? 80,
      });
    };

    updateTerminalSize();
    stdout.on("resize", updateTerminalSize);
    return () => {
      stdout.off("resize", updateTerminalSize);
    };
  }, [stdout]);

  useEffect(() => events.subscribe((event: TuiEvent) => {
    if (event.type === "tool-started") {
      setActiveTools((current) => [...current, event.name]);
      return;
    }

    if (event.type === "tool-finished") {
      setActiveTools((current) => {
        const next = [...current];
        const pendingIndex = next.lastIndexOf(event.name);
        if (pendingIndex !== -1) next.splice(pendingIndex, 1);
        return next;
      });
      setHistory((current) => [...current, {
        kind: "tool",
        name: event.name,
        status: event.isError ? "error" : "done",
        durationMs: event.durationMs,
        ...(event.isError ? { detail: compactDetail(event.text) } : {}),
      }]);
      return;
    }

    setNotice(`MCP: ${event.reason}`);
  }), [events]);

  useEffect(() => {
    if (!selectorOpen) return;
    let active = true;
    setModelLoading(true);
    setModelError(undefined);
    void agent.listModels().then((availableModels) => {
      if (!active) return;
      setModels(availableModels);
      const currentIndex = availableModels.indexOf(agent.model);
      setModelIndex(currentIndex >= 0 ? currentIndex : 0);
    }).catch((error: unknown) => {
      if (active) setModelError(errorMessage(error));
    }).finally(() => {
      if (active) setModelLoading(false);
    });
    return () => {
      active = false;
    };
  }, [agent, selectorOpen]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    if (selectorOpen) {
      if (key.escape) {
        setSelectorOpen(false);
        return;
      }
      if (key.upArrow) {
        setModelIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        setModelIndex((current) => Math.min(Math.max(0, models.length - 1), current + 1));
        return;
      }
      if (key.return && !modelLoading && models[modelIndex] !== undefined) {
        const selectedModel = models[modelIndex];
        setModelLoading(true);
        setModelError(undefined);
        void agent.setModel(selectedModel).then(() => {
          setNotice(`Model zmieniony na ${agent.model}.`);
          setSelectorOpen(false);
        }).catch((error: unknown) => {
          setModelError(errorMessage(error));
        }).finally(() => setModelLoading(false));
      }
      return;
    }

    if (key.ctrl && input === "o" && !busy) {
      setSelectorOpen(true);
      setNotice(undefined);
    }
  }, { isActive: true });

  const submit = (value: string): void => {
    if (busy || selectorOpen || value.trim().length === 0) return;
    if (isExitCommand(value)) {
      exit();
      return;
    }
    setHistory((current) => [...current, { kind: "user", content: value }]);
    setClearToken((current) => current + 1);
    setNotice(undefined);
    setBusy(true);
    const run: Promise<RecordedTurn> = recorder === undefined
      ? agent.chat(value).then((turn) => ({ turn }))
      : runRecordedTurn(agent, recorder, value);
    void run.then(({ turn, recordingError }) => {
      setLastMetrics(turn.metrics);
      setHistory((current) => [...current, { kind: "assistant", content: turn.content }]);
      if (recordingError !== undefined) {
        setNotice(`Nie zapisano tury: ${recordingError}`);
      }
    }).catch((error: unknown) => {
      const detail = errorMessage(error);
      setNotice(detail);
      setHistory((current) => [...current, { kind: "error", content: detail }]);
    }).finally(() => setBusy(false));
  };

  const modelStart = Math.min(
    Math.max(0, modelIndex - layout.modelItems + 1),
    Math.max(0, models.length - layout.modelItems),
  );
  const visibleModels = models.slice(modelStart, modelStart + layout.modelItems);
  const context = agent.lastContextTokens === undefined
    ? "prompt ctx —"
    : `prompt ctx ${agent.lastContextTokens}/${agent.contextSize}`;
  const speed = lastMetrics === undefined
    ? "—"
    : lastMetrics.generation_tokens_per_second === null
      ? "—"
      : `${lastMetrics.generation_tokens_per_second.toFixed(1)} tok/s`;
  const hint = notice ?? (busy
    ? "working…"
    : "mouse wheel scroll · select text · Cmd/Ctrl+Shift+C copy · Ctrl+O models");
  const mcpColor = agent.mcpAvailable ? "green" : "red";

  return (
    <Box
      flexDirection="column"
      paddingX={1}
    >
      {/* Completed chat items stay in terminal scrollback instead of being
          redrawn in a virtual full-screen viewport. This lets the terminal
          own mouse scrolling, text selection, and clipboard shortcuts. */}
      <Static items={history}>
        {(item, itemIndex) => (
          <Box key={`history-${itemIndex}`} flexDirection="column" width={layout.contentWidth}>
            {buildHistoryLines([item], layout.contentWidth).map((line) => (
              <Text
                key={line.key}
                {...(line.emphasis ? { bold: true } : {})}
                {...(line.kind === "error"
                  ? { color: "red" }
                  : line.kind === "user"
                    ? { color: "cyan" }
                    : line.kind === "tool"
                      ? { color: "yellow" }
                      : {})}
              >
                {line.text}
              </Text>
            ))}
          </Box>
        )}
      </Static>

      <Box width={layout.contentWidth} flexShrink={0}>
        {layout.tiny ? (
          <Text bold color="cyan">◆ Pirx</Text>
        ) : (
          <Box
            width={layout.contentWidth}
            borderStyle="round"
            borderColor="cyan"
            paddingX={1}
            justifyContent="space-between"
          >
            <Box>
              <Text bold color="cyan">◆ Pirx</Text>
              <Text color="gray">  local chat</Text>
            </Box>
            <Box>
              <Text color="gray">{agent.model}  </Text>
              <Text color={mcpColor}>● MCP</Text>
            </Box>
          </Box>
        )}
      </Box>

      <Box flexDirection="column" width={layout.contentWidth} paddingY={1}>
        {history.length === 0 ? <Text color="gray">Ask Pirx something. Ctrl+O switches the model.</Text> : null}
        {activeTools.map((name, index) => <Text key={`${name}-${index}`} color="yellow">[tool] {name} …</Text>)}
        {busy ? <Text color="yellow">◌ Pirx is thinking…</Text> : null}
      </Box>

      <Box flexDirection="column" width={layout.contentWidth} flexShrink={0}>
        {selectorOpen ? (
          <Box
            flexDirection="column"
            width={layout.contentWidth}
            flexShrink={0}
            overflow="hidden"
            borderStyle="round"
            borderColor="magenta"
            paddingX={1}
          >
            <Text bold color="magenta">Select model {modelLoading ? "(loading…)" : ""}</Text>
            {modelError ? <Text color="red">{modelError}</Text> : null}
            {models.length === 0 && !modelLoading && !modelError ? <Text color="gray">No installed Ollama models found.</Text> : null}
            {visibleModels.map((model, offset) => {
              const index = modelStart + offset;
              return (
                <Text key={model} {...(index === modelIndex ? { color: "cyan" } : {})}>
                  {index === modelIndex ? "› " : "  "}{model}{model === agent.model ? " · current" : ""}
                </Text>
              );
            })}
            {models.length > visibleModels.length ? <Text color="gray">… {models.length - visibleModels.length} more</Text> : null}
            <Text color="gray">↑/↓ select · Enter apply · Esc close</Text>
          </Box>
        ) : (
          <Composer
            clearToken={clearToken}
            disabled={busy}
            onSubmit={submit}
            width={layout.contentWidth}
          />
        )}

        {layout.tiny ? (
          <Box width={layout.contentWidth} flexShrink={0}>
            <Text wrap="truncate-end" color={notice ? "yellow" : "gray"}>{hint}</Text>
          </Box>
        ) : (
          <Box
            flexDirection={layout.compact ? "column" : "row"}
            width={layout.contentWidth}
            flexShrink={0}
            justifyContent={layout.compact ? undefined : "space-between"}
            paddingTop={1}
          >
            <Text wrap="truncate-end" color={notice ? "yellow" : "gray"}>
              {notice ? "⚠ " : busy ? "◌ " : "› "}{hint}
            </Text>
            <Text wrap="truncate-end" color="gray">
              {context}  ·  <Text color="magenta">{speed} tok/s</Text>
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
