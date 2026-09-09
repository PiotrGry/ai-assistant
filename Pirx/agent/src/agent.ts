import { createHash } from "node:crypto";

import { Ollama, type ChatResponse, type Message, type Tool } from "ollama";

import type { AgentConfig, SystemPrompt } from "./config.js";
import { loadSystemPrompt } from "./config.js";
import type { SqliteActionLedger } from "./action-ledger.js";
import {
  estimateContext,
  selectMessagesForContext,
  type ContextBuild,
  type ContextEstimate,
  type ContextSectionInput,
} from "./context-manager.js";
import { PirxMcpClient, type ToolExecution } from "./mcp-client.js";
import { parseOllamaModelNames } from "./ollama-models.js";
import type { OperationRecorder } from "./operation-recorder.js";
import { readGpuStats, type GpuStats } from "./telemetry.js";
import { currentTimeSystemContext } from "./time-context.js";

type ResponseWithMetrics = ChatResponse;

export interface TurnMetrics {
  readonly timestamp: string;
  readonly model: string;
  readonly time_zone: string;
  readonly context: number;
  readonly temperature: number;
  readonly system_prompt_file: string;
  readonly system_prompt_sha256: string;
  readonly prompt: string;
  readonly response: string;
  readonly turn_duration_ms: number;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_seconds: number | null;
  readonly load_seconds: number | null;
  readonly prompt_tokens_per_second: number | null;
  readonly generation_tokens_per_second: number | null;
  readonly done_reason: string | null;
  readonly model_calls: number;
  readonly tool_calls: number;
  readonly context_estimates: readonly ContextEstimate[];
  readonly context_builds: readonly ContextBuildSummary[];
  readonly gpu_before: GpuStats | null;
  readonly gpu_after: GpuStats | null;
}

export interface ContextBuildSummary {
  readonly estimate: ContextEstimate;
  readonly selected_message_count: number;
  readonly omitted_message_count: number;
}

export interface ChatTurn {
  readonly content: string;
  readonly messages: readonly Message[];
  readonly metrics: TurnMetrics;
}

export interface ChatTurnContext {
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly actionLedger?: SqliteActionLedger;
  readonly operationRecorder?: OperationRecorder;
}

export interface AgentHooks {
  readonly onToolCall?: (name: string, arguments_: Record<string, unknown>) => void;
  readonly onToolResult?: (
    name: string,
    result: ToolExecution,
    durationMs: number,
  ) => void;
  readonly onMcpUnavailable?: (reason: string) => void;
}

export interface AgentDependencies {
  readonly now?: () => Date;
}

interface Totals {
  totalDuration: number | null;
  loadDuration: number | null;
  promptEvalCount: number | null;
  promptEvalDuration: number | null;
  evalCount: number | null;
  evalDuration: number | null;
  modelCalls: number;
  toolCalls: number;
  doneReason: string | null;
  contextEstimates: ContextEstimate[];
  contextBuilds: ContextBuild<Message>[];
}

function addMetrics(totals: Totals, response: ResponseWithMetrics): void {
  totals.totalDuration = addBackendMetric(
    totals.totalDuration,
    response.total_duration,
  );
  totals.loadDuration = addBackendMetric(
    totals.loadDuration,
    response.load_duration,
  );
  totals.promptEvalCount = addBackendMetric(
    totals.promptEvalCount,
    response.prompt_eval_count,
  );
  totals.promptEvalDuration = addBackendMetric(
    totals.promptEvalDuration,
    response.prompt_eval_duration,
  );
  totals.evalCount = addBackendMetric(totals.evalCount, response.eval_count);
  totals.evalDuration = addBackendMetric(
    totals.evalDuration,
    response.eval_duration,
  );
  totals.modelCalls += 1;
  totals.doneReason = response.done_reason ?? null;
}

function addBackendMetric(
  current: number | null,
  value: number | undefined,
): number | null {
  if (current === null || value === undefined) {
    return null;
  }
  return current + value;
}

function messageText(message: Message): string {
  return JSON.stringify(message);
}

function messageHash(message: Message): string {
  return createHash("sha256").update(messageText(message)).digest("hex");
}

function contextBuildReferences(
  allMessages: readonly Message[],
  selectedMessages: readonly Message[],
): {
  readonly selected: Record<string, unknown>;
  readonly omitted: Record<string, unknown>;
} {
  const selectedSet = new Set(selectedMessages);
  const references = allMessages.map((message, index) => ({
    index,
    role: message.role,
    characters: Array.from(messageText(message)).length,
    sha256: messageHash(message),
  }));
  const selectedReferences = references.filter((_, index) =>
    selectedSet.has(allMessages[index] as Message),
  );
  const omittedReferences = references.filter((_, index) =>
    !selectedSet.has(allMessages[index] as Message),
  );
  const selectedHash = createHash("sha256")
    .update(JSON.stringify(selectedMessages.map(messageText)))
    .digest("hex");

  return {
    selected: {
      sha256: selectedHash,
      messages: selectedReferences,
    },
    omitted: {
      message_count: omittedReferences.length,
      messages: omittedReferences,
    },
  };
}

function contextSections(
  messages: readonly Message[],
  tools: readonly Tool[],
): ContextSectionInput[] {
  const currentRequestIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  const currentRequest =
    currentRequestIndex >= 0 ? messages[currentRequestIndex] : undefined;
  const instructions = messages.filter((message) => message.role === "system");
  const workingMemory = messages.filter((message) => message.role === "tool");
  const history = messages.filter(
    (message, index) =>
      message.role !== "system" &&
      message.role !== "tool" &&
      index !== currentRequestIndex,
  );

  return [
    {
      name: "instructions",
      text: instructions.map(messageText).join("\n"),
    },
    {
      name: "tool_schemas",
      text: JSON.stringify(tools),
    },
    {
      name: "working_memory",
      text: workingMemory.map(messageText).join("\n"),
    },
    {
      name: "history",
      text: history.map(messageText).join("\n"),
    },
    {
      name: "sources",
      text: "",
    },
    {
      name: "current_request",
      text: currentRequest === undefined ? "" : messageText(currentRequest),
    },
  ];
}

function tokensPerSecond(
  tokens: number | null,
  durationNanoseconds: number | null,
): number | null {
  if (tokens === null || durationNanoseconds === null || durationNanoseconds <= 0) {
    return null;
  }
  return tokens / (durationNanoseconds / 1_000_000_000);
}

function secondsFromNanoseconds(value: number | null): number | null {
  return value === null ? null : value / 1_000_000_000;
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return normalizeArguments(parsed);
    } catch {
      return {};
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function numericMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rawOllamaMetrics(response: unknown): Record<string, unknown> {
  const record = response as Record<string, unknown>;
  return {
    total_duration_ns: numericMetric(record["total_duration"]),
    load_duration_ns: numericMetric(record["load_duration"]),
    prompt_eval_count: numericMetric(record["prompt_eval_count"]),
    prompt_eval_cached_count: numericMetric(record["prompt_eval_cached_count"]),
    prompt_eval_duration_ns: numericMetric(record["prompt_eval_duration"]),
    eval_count: numericMetric(record["eval_count"]),
    eval_duration_ns: numericMetric(record["eval_duration"]),
    done_reason:
      typeof record["done_reason"] === "string" ? record["done_reason"] : null,
  };
}

function actionTarget(
  name: string,
  arguments_: Record<string, unknown>,
): string {
  const identifiers = [
    "path",
    "source",
    "destination",
    "calendarId",
    "eventId",
  ]
    .filter((key) => typeof arguments_[key] === "string")
    .map((key) => `${key}=${String(arguments_[key])}`);
  return [name, ...identifiers].join(" ");
}

function boundedFetch(timeoutMs: number): typeof fetch {
  return async (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      init.signal === undefined || init.signal === null
        ? timeoutSignal
        : AbortSignal.any([init.signal, timeoutSignal]);
    return fetch(input, { ...init, signal });
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} przekroczyło timeout ${timeoutMs} ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
export class PirxAgent {
  readonly #config: AgentConfig;
  readonly #ollama: Ollama;
  readonly #mcp: PirxMcpClient;
  readonly #hooks: AgentHooks;
  readonly #now: () => Date;
  #prompt: SystemPrompt;
  #messages: Message[];
  #currentModel: string;
  #mcpFailureReported = false;
  #lastContextTokens: number | undefined;

  private constructor(
    config: AgentConfig,
    prompt: SystemPrompt,
    hooks: AgentHooks,
    dependencies: AgentDependencies,
  ) {
    this.#config = config;
    this.#prompt = prompt;
    this.#hooks = hooks;
    this.#now = dependencies.now ?? (() => new Date());
    this.#ollama = new Ollama({
      host: config.baseUrl,
      fetch: boundedFetch(config.llmTimeoutMs),
    });
    this.#mcp = new PirxMcpClient(
      config.mcpServerEntry,
      config.toolTimeoutMs,
      config.maxToolResultCharacters,
    );
    this.#messages = [{ role: "system", content: prompt.content }];
    this.#currentModel = config.model;
  }

  static async create(
    config: AgentConfig,
    hooks: AgentHooks = {},
    dependencies: AgentDependencies = {},
  ): Promise<PirxAgent> {
    const prompt = await loadSystemPrompt(config.promptFile);
    const agent = new PirxAgent(config, prompt, hooks, dependencies);

    await agent.checkOllama();
    try {
      await agent.#mcp.connect();
    } catch (error) {
      await agent.#mcp.close();
      throw error;
    }

    return agent;
  }

  get systemPrompt(): SystemPrompt {
    return this.#prompt;
  }

  get model(): string {
    return this.#currentModel;
  }

  get contextSize(): number {
    return this.#config.numCtx;
  }

  get toolNames(): readonly string[] {
    return this.#mcp.toolNames;
  }

  get mcpAvailable(): boolean {
    return this.#mcp.isAvailable;
  }

  get lastContextTokens(): number | undefined {
    return this.#lastContextTokens;
  }

  clearHistory(): void {
    this.#messages = [{ role: "system", content: this.#prompt.content }];
    this.#lastContextTokens = undefined;
  }

  async reloadSystemPrompt(): Promise<SystemPrompt> {
    this.#prompt = await loadSystemPrompt(this.#config.promptFile);
    this.clearHistory();
    return this.#prompt;
  }

  async listModels(): Promise<readonly string[]> {
    let response: Response;
    try {
      response = await fetch(`${this.#config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(this.#config.llmTimeoutMs),
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Nie można pobrać listy modeli Ollamy: ${detail}`);
    }

    if (!response.ok) {
      throw new Error(`Ollama /api/tags zwróciła HTTP ${response.status}.`);
    }

    return parseOllamaModelNames(await response.json());
  }

  async setModel(model: string): Promise<void> {
    const requestedModel = model.trim();
    if (requestedModel.length === 0) {
      throw new Error("Nazwa modelu Ollamy nie może być pusta.");
    }

    const models = await this.listModels();
    if (!models.includes(requestedModel)) {
      throw new Error(`Model „${requestedModel}” nie jest zainstalowany w Ollamie.`);
    }

    this.#currentModel = requestedModel;
  }

  async chat(prompt: string, context: ChatTurnContext = {}): Promise<ChatTurn> {
    const model = this.#currentModel;
    const turnStartedAt = performance.now();
    const checkpoint = this.#messages.length;
    const timestamp = this.#now().toISOString();
    const gpuBefore = await readGpuStats();
    const repeatedToolCalls = new Map<string, number>();
    let operationSequence = 0;
    const totals: Totals = {
      totalDuration: 0,
      loadDuration: 0,
      promptEvalCount: 0,
      promptEvalDuration: 0,
      evalCount: 0,
      evalDuration: 0,
      modelCalls: 0,
      toolCalls: 0,
      doneReason: null,
      contextEstimates: [],
      contextBuilds: [],
    };

    this.#messages.push({ role: "user", content: prompt });

    try {
      let finalContent: string | undefined;

      for (
        let iteration = 0;
        iteration <= this.#config.maxToolIterations;
        iteration += 1
      ) {
        const mayExecuteTools = iteration < this.#config.maxToolIterations;
        const tools = mayExecuteTools ? this.#mcp.ollamaTools : [];
        const messagesForModel = this.#messagesForModel();
        const budget = {
          contextWindowTokens: this.#config.numCtx,
          maxOutputTokens: this.#config.maxOutputTokens ?? 0,
          safetyMarginTokens: this.#config.contextSafetyMarginTokens ?? 0,
        };
        const contextBuild = selectMessagesForContext(
          messagesForModel,
          (messages) => estimateContext(contextSections(messages, tools), budget),
        );
        totals.contextBuilds.push(contextBuild);
        totals.contextEstimates.push(contextBuild.estimate);
        const messages = [...contextBuild.messages];
        const llmOperationSequence = operationSequence;
        operationSequence += 1;
        const llmOperation =
          context.operationRecorder !== undefined &&
          context.sessionId !== undefined &&
          context.turnId !== undefined
            ? context.operationRecorder.start({
                sessionId: context.sessionId,
                turnId: context.turnId,
                sequence: llmOperationSequence,
                kind: "llm",
                startedAt: this.#now().toISOString(),
                payload: {
                  schema_version: 1,
                  model,
                  iteration,
                  context_estimate: totals.contextEstimates.at(-1),
                },
              })
            : undefined;
        const llmStartedAt = performance.now();
        const request = {
          model,
          messages,
          stream: false as const,
          keep_alive: this.#config.keepAlive,
          options: {
            num_ctx: this.#config.numCtx,
            temperature: this.#config.temperature,
            ...(this.#config.maxOutputTokens !== undefined
              ? { num_predict: this.#config.maxOutputTokens }
              : {}),
          },
          ...(tools.length > 0 ? { tools: [...tools] } : {}),
        };

        let response: ResponseWithMetrics;
        try {
          if (llmOperation !== undefined) {
            const references = contextBuildReferences(
              messagesForModel,
              contextBuild.messages,
            );
            context.operationRecorder?.recordContextBuild?.(llmOperation, {
              policyVersion: contextBuild.estimate.policyVersion,
              estimatedInputTokens: contextBuild.estimate.estimatedInputTokens,
              budgetTokens: contextBuild.estimate.inputBudgetTokens,
              selected: references.selected,
              omitted: references.omitted,
              createdAt: this.#now().toISOString(),
            });
          }
          response = (await withTimeout(
            this.#ollama.chat(request),
            this.#config.llmTimeoutMs,
            "Ollama",
          )) as ResponseWithMetrics;
        } catch (error: unknown) {
          if (llmOperation !== undefined) {
            context.operationRecorder?.finish(llmOperation, {
              endedAt: this.#now().toISOString(),
              status: "failed",
              payload: {
                schema_version: 1,
                wall_duration_ms: performance.now() - llmStartedAt,
              },
              error: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        }
        if (llmOperation !== undefined) {
          context.operationRecorder?.finish(llmOperation, {
            endedAt: this.#now().toISOString(),
            status: "succeeded",
            payload: {
              schema_version: 1,
              ...rawOllamaMetrics(response),
              wall_duration_ms: performance.now() - llmStartedAt,
            },
          });
        }

        this.#lastContextTokens = response.prompt_eval_count ?? undefined;
        addMetrics(totals, response);

        const toolCalls = response.message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          this.#messages.push(response.message);
          finalContent = response.message.content;
          break;
        }

        if (!mayExecuteTools || tools.length === 0) {
          finalContent = mayExecuteTools
            ? "Serwer MCP jest niedostępny, więc nie wykonano kolejnego wywołania narzędzia."
            : `Osiągnięto limit ${this.#config.maxToolIterations} rund wywołań narzędzi. ` +
            "Ostatnia żądana akcja nie została wykonana.";
          this.#messages.push({ role: "assistant", content: finalContent });
          totals.doneReason = mayExecuteTools
            ? "mcp_unavailable"
            : "tool_iteration_limit";
          break;
        }

        this.#messages.push(response.message);

        for (const call of toolCalls) {
          const name = call.function.name;
          const arguments_ = normalizeArguments(call.function.arguments);
          const fingerprint = JSON.stringify({ name, arguments: arguments_ });
          const repeatedToolCallCount = (repeatedToolCalls.get(fingerprint) ?? 0) + 1;
          repeatedToolCalls.set(fingerprint, repeatedToolCallCount);

          if (repeatedToolCallCount > this.#config.maxRepeatedToolCalls) {
            this.#messages.push({
              role: "tool",
              tool_name: name,
              content:
                "Przerwano identyczną operację narzędzia z powodu wykrycia pętli powtarzających się wywołań.",
            });
            continue;
          }

          totals.toolCalls += 1;
          const mcpOperationSequence = operationSequence;
          operationSequence += 1;

          const actionPlan =
            context.actionLedger !== undefined &&
            context.sessionId !== undefined &&
            context.turnId !== undefined &&
            !this.#mcp.isReadOnlyTool(name)
              ? context.actionLedger.plan({
                  sessionId: context.sessionId,
                  turnId: context.turnId,
                  sequence: mcpOperationSequence,
                  target: actionTarget(name, arguments_),
                  toolName: name,
                  arguments: arguments_,
                  authorization: {
                    source: "user_prompt",
                    turn_id: context.turnId,
                  },
                })
              : undefined;

          if (actionPlan?.alreadySucceeded === true) {
            this.#messages.push({
              role: "tool",
              tool_name: name,
              content:
                "Operacja ma już zapisane potwierdzenie sukcesu i nie została wykonana ponownie.",
            });
            continue;
          }

          if (actionPlan?.requiresReconciliation === true) {
            this.#messages.push({
              role: "tool",
              tool_name: name,
              content:
                "Wynik poprzedniej próby operacji jest niepewny. Najpierw sprawdź aktualny stan zewnętrzny; operacji nie wykonano ponownie.",
            });
            continue;
          }

          actionPlan === undefined
            ? undefined
            : context.actionLedger?.start(actionPlan);
          const mcpOperation =
            actionPlan === undefined &&
            context.operationRecorder !== undefined &&
            context.sessionId !== undefined &&
            context.turnId !== undefined
              ? context.operationRecorder.start({
                  sessionId: context.sessionId,
                  turnId: context.turnId,
                  sequence: mcpOperationSequence,
                  kind: "mcp",
                  startedAt: this.#now().toISOString(),
                  payload: {
                    schema_version: 1,
                    tool_name: name,
                    arguments: arguments_,
                  },
                })
              : undefined;
          this.#hooks.onToolCall?.(name, arguments_);

          const toolStartedAt = performance.now();
          const execution = await this.#mcp.callTool(name, arguments_);
          const toolDurationMs = performance.now() - toolStartedAt;
          if (mcpOperation !== undefined) {
            context.operationRecorder?.finish(mcpOperation, {
              endedAt: this.#now().toISOString(),
              status: execution.serverUnavailable
                ? "unknown"
                : execution.isError
                  ? "failed"
                  : "succeeded",
              payload: {
                schema_version: 1,
                tool_name: name,
                is_error: execution.isError,
                server_unavailable: execution.serverUnavailable,
                wall_duration_ms: toolDurationMs,
              },
              ...(execution.isError ? { error: execution.text } : {}),
            });
          }
          if (actionPlan !== undefined) {
            const state = execution.serverUnavailable
              ? "unknown"
              : execution.isError
                ? "failed"
                : "succeeded";
            context.actionLedger?.finish(
              actionPlan,
              state,
              {
                is_error: execution.isError,
                server_unavailable: execution.serverUnavailable,
              },
              execution.isError ? execution.text : undefined,
            );
          }
          this.#hooks.onToolResult?.(
            name,
            execution,
            toolDurationMs,
          );
          this.#messages.push({
            role: "tool",
            tool_name: name,
            content: execution.text,
          });

          if (execution.serverUnavailable && !this.#mcpFailureReported) {
            this.#mcpFailureReported = true;
            this.#hooks.onMcpUnavailable?.(execution.text);
          }
        }
      }

      if (finalContent === undefined) {
        finalContent = "Nie udało się uzyskać finalnej odpowiedzi.";
        this.#messages.push({ role: "assistant", content: finalContent });
        totals.doneReason = "unexpected_loop_end";
      }

      const gpuAfter = await readGpuStats();
      return {
        content: finalContent,
        messages: this.#messages.slice(checkpoint),
        metrics: {
          timestamp,
          model,
          time_zone: this.#config.timeZone,
          context: this.#config.numCtx,
          temperature: this.#config.temperature,
          system_prompt_file: this.#config.promptFile,
          system_prompt_sha256: this.#prompt.sha256,
          prompt,
          response: finalContent,
          turn_duration_ms: performance.now() - turnStartedAt,
          input_tokens: totals.promptEvalCount,
          output_tokens: totals.evalCount,
          total_seconds: secondsFromNanoseconds(totals.totalDuration),
          load_seconds: secondsFromNanoseconds(totals.loadDuration),
          prompt_tokens_per_second: tokensPerSecond(
            totals.promptEvalCount,
            totals.promptEvalDuration,
          ),
          generation_tokens_per_second: tokensPerSecond(
            totals.evalCount,
            totals.evalDuration,
          ),
          done_reason: totals.doneReason,
          model_calls: totals.modelCalls,
          tool_calls: totals.toolCalls,
          context_estimates: totals.contextEstimates,
          context_builds: totals.contextBuilds.map((build) => ({
            estimate: build.estimate,
            selected_message_count: build.messages.length,
            omitted_message_count: build.omittedMessageCount,
          })),
          gpu_before: gpuBefore,
          gpu_after: gpuAfter,
        },
      };
    } catch (error) {
      this.#messages.splice(checkpoint);
      throw error;
    }
  }

  async modelStatus(): Promise<unknown> {
    const response = await fetch(`${this.#config.baseUrl}/api/ps`);
    if (!response.ok) {
      throw new Error(`Ollama /api/ps zwróciła HTTP ${response.status}.`);
    }
    return response.json();
  }

  async unloadModel(): Promise<void> {
    const response = await fetch(`${this.#config.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.#currentModel,
        prompt: "",
        stream: false,
        keep_alive: 0,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama nie zwolniła modelu (HTTP ${response.status}).`);
    }
  }

  async close(): Promise<void> {
    await this.#mcp.close();
  }

  #messagesForModel(): Message[] {
    const timeContext = currentTimeSystemContext(this.#now(), this.#config.timeZone);
    return [
      {
        role: "system",
        content: `${this.#prompt.content.trimEnd()}\n\n---\n\n${timeContext}`,
      },
      ...this.#messages.slice(1),
    ];
  }

  private async checkOllama(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.#config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Ollama nie odpowiada pod ${this.#config.baseUrl}. Uruchom ollama serve. (${detail})`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Ollama pod ${this.#config.baseUrl} zwróciła HTTP ${response.status}.`,
      );
    }
  }
}
