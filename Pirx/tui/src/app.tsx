import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import type { ChatTurn, PirxAgent, TurnMetrics } from "@pirx/agent";

import { Composer } from "./composer.js";
import type { TuiEvent } from "./events.js";
import { TuiEventBus } from "./events.js";
import { isExitCommand } from "./input-state.js";
import { calculateTuiLayout } from "./layout.js";

type ChatItem =
  | { readonly kind: "user" | "assistant"; readonly content: string }
  | { readonly kind: "error"; readonly content: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly status: "running" | "done" | "error";
      readonly durationMs?: number;
      readonly detail?: string;
    };

interface AppProps {
  readonly agent: PirxAgent;
  readonly events: TuiEventBus;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactDetail(value: string): string {
  const firstLine = value.split("\n", 1)[0] ?? value;
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine;
}

function toolStatus(item: Extract<ChatItem, { kind: "tool" }>): string {
  if (item.status === "running") return "…";
  const duration = item.durationMs === undefined ? "" : ` ${Math.round(item.durationMs)} ms`;
  return item.status === "error" ? `✕${duration}` : `✓${duration}`;
}

function renderItem(item: ChatItem, index: number): React.JSX.Element {
  if (item.kind === "tool") {
    return (
      <Text key={`${item.kind}-${item.name}-${index}`} color={item.status === "error" ? "red" : "yellow"}>
        [{item.status === "error" ? "tool error" : "tool"}] {item.name} {toolStatus(item)}
        {item.detail === undefined ? "" : ` — ${item.detail}`}
      </Text>
    );
  }

  const label = item.kind === "user" ? "You" : item.kind === "assistant" ? "Pirx" : "Pirx error";
  return (
    <Box key={`${item.kind}-${index}`} flexDirection="column" marginBottom={1}>
      <Text bold color={item.kind === "error" ? "red" : item.kind === "user" ? "cyan" : "green"}>
        {label}:
      </Text>
      {item.kind === "error" ? <Text color="red">{item.content}</Text> : <Text>{item.content}</Text>}
    </Box>
  );
}

export function App({ agent, events }: AppProps): React.JSX.Element {
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
  const [notice, setNotice] = useState<string | undefined>();
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [models, setModels] = useState<readonly string[]>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState<string | undefined>();

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
      setHistory((current) => [...current, {
        kind: "tool",
        name: event.name,
        status: "running",
      }]);
      return;
    }

    if (event.type === "tool-finished") {
      setHistory((current) => {
        const next = [...current];
        const pendingIndex = next.findLastIndex(
          (item) => item.kind === "tool" && item.name === event.name && item.status === "running",
        );
        const replacement: Extract<ChatItem, { kind: "tool" }> = {
          kind: "tool",
          name: event.name,
          status: event.isError ? "error" : "done",
          durationMs: event.durationMs,
          ...(event.isError ? { detail: compactDetail(event.text) } : {}),
        };
        if (pendingIndex === -1) next.push(replacement);
        else next[pendingIndex] = replacement;
        return next;
      });
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
    void agent.chat(value).then((turn: ChatTurn) => {
      setLastMetrics(turn.metrics);
      setHistory((current) => [...current, { kind: "assistant", content: turn.content }]);
    }).catch((error: unknown) => {
      const detail = errorMessage(error);
      setNotice(detail);
      setHistory((current) => [...current, { kind: "error", content: detail }]);
    }).finally(() => setBusy(false));
  };

  const layout = calculateTuiLayout(terminalSize.rows, terminalSize.columns);
  const visibleItems = history.slice(-layout.historyItems);
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
  const hint = notice ?? (busy ? "working…" : "Enter send · Shift+Enter newline · Ctrl+O models");
  const runtimeStatus = `${agent.model} | MCP ${agent.mcpAvailable ? "●" : "○"} | ${context} | ${speed}`;

  return (
    <Box
      flexDirection="column"
      width={layout.columns}
      height={layout.rows}
      paddingX={1}
      overflow="hidden"
    >
      {layout.tiny ? (
        <Text bold color="cyan">Pirx</Text>
      ) : (
        <Box width={layout.contentWidth} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">Pirx</Text><Text color="gray"> · local chat</Text>
        </Box>
      )}

      <Box flexDirection="column" width={layout.contentWidth} flexGrow={1} overflow="hidden" paddingY={1}>
        {visibleItems.length === 0 ? <Text color="gray">Ask Pirx something. Ctrl+O switches the model.</Text> : null}
        {visibleItems.map(renderItem)}
        {busy ? <Text color="gray">Pirx is thinking…</Text> : null}
      </Box>

      {selectorOpen ? (
        <Box
          flexDirection="column"
          width={layout.contentWidth}
          height={Math.max(3, layout.rows - (layout.tiny ? 3 : 5))}
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
        <Box width={layout.contentWidth}>
          <Text wrap="truncate-end" color={notice ? "yellow" : "gray"}>{hint}</Text>
        </Box>
      ) : (
        <Box
          flexDirection={layout.compact ? "column" : "row"}
          width={layout.contentWidth}
          justifyContent={layout.compact ? undefined : "space-between"}
          paddingTop={1}
        >
          <Text wrap="truncate-end" color={notice ? "yellow" : "gray"}>{hint}</Text>
          <Text wrap="truncate-end" color="gray">{runtimeStatus}</Text>
        </Box>
      )}
    </Box>
  );
}
