import { Ollama, type ChatResponse, type Message } from "ollama";

import type { AgentConfig, SystemPrompt } from "./config.js";
import { loadSystemPrompt } from "./config.js";
import { PirxMcpClient } from "./mcp-client.js";
import { readGpuStats, type GpuStats } from "./telemetry.js";

type ResponseWithMetrics = ChatResponse;

export interface TurnMetrics {
  readonly timestamp: string;
  readonly model: string;
  readonly context: number;
  readonly temperature: number;
  readonly system_prompt_file: string;
  readonly system_prompt_sha256: string;
  readonly prompt: string;
  readonly response: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_seconds: number;
  readonly load_seconds: number;
  readonly prompt_tokens_per_second: number;
  readonly generation_tokens_per_second: number;
  readonly done_reason: string | null;
  readonly model_calls: number;
  readonly tool_calls: number;
  readonly gpu_before: GpuStats | null;
  readonly gpu_after: GpuStats | null;
}

export interface ChatTurn {
  readonly content: string;
  readonly metrics: TurnMetrics;
}

export interface AgentHooks {
  readonly onToolCall?: (name: string, arguments_: Record<string, unknown>) => void;
  readonly onMcpUnavailable?: (reason: string) => void;
}

interface Totals {
  totalDuration: number;
  loadDuration: number;
  promptEvalCount: number;
  promptEvalDuration: number;
  evalCount: number;
  evalDuration: number;
  modelCalls: number;
  toolCalls: number;
  doneReason: string | null;
}

function addMetrics(totals: Totals, response: ResponseWithMetrics): void {
  totals.totalDuration += response.total_duration ?? 0;
  totals.loadDuration += response.load_duration ?? 0;
  totals.promptEvalCount += response.prompt_eval_count ?? 0;
  totals.promptEvalDuration += response.prompt_eval_duration ?? 0;
  totals.evalCount += response.eval_count ?? 0;
  totals.evalDuration += response.eval_duration ?? 0;
  totals.modelCalls += 1;
  totals.doneReason = response.done_reason ?? null;
}

function tokensPerSecond(tokens: number, durationNanoseconds: number): number {
  return durationNanoseconds > 0 ? tokens / (durationNanoseconds / 1_000_000_000) : 0;
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
  #prompt: SystemPrompt;
  #messages: Message[];
  #mcpFailureReported = false;
  #lastContextTokens: number | undefined;

  private constructor(config: AgentConfig, prompt: SystemPrompt, hooks: AgentHooks) {
    this.#config = config;
    this.#prompt = prompt;
    this.#hooks = hooks;
    this.#ollama = new Ollama({
      host: config.baseUrl,
      fetch: boundedFetch(config.llmTimeoutMs),
    });
    this.#mcp = new PirxMcpClient(
      config.mcpServerEntry,
      config.toolTimeoutMs,
    );
    this.#messages = [{ role: "system", content: prompt.content }];
  }

  static async create(config: AgentConfig, hooks: AgentHooks = {}): Promise<PirxAgent> {
    const prompt = await loadSystemPrompt(config.promptFile);
    const agent = new PirxAgent(config, prompt, hooks);

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

  get toolNames(): readonly string[] {
    return this.#mcp.toolNames;
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

  async chat(prompt: string): Promise<ChatTurn> {
    const checkpoint = this.#messages.length;
    const timestamp = new Date().toISOString();
    const gpuBefore = await readGpuStats();
    const repeatedToolCalls = new Map<string, number>();
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
        const request = {
          model: this.#config.model,
          messages: this.#messages,
          stream: false as const,
          keep_alive: this.#config.keepAlive,
          options: {
            num_ctx: this.#config.numCtx,
            temperature: this.#config.temperature,
          },
          ...(tools.length > 0 ? { tools: [...tools] } : {}),
        };

        const response = (await withTimeout(
          this.#ollama.chat(request),
          this.#config.llmTimeoutMs,
          "Ollama",
        )) as ResponseWithMetrics;

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
          this.#hooks.onToolCall?.(name, arguments_);

          const execution = await this.#mcp.callTool(name, arguments_);
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
        metrics: {
          timestamp,
          model: this.#config.model,
          context: this.#config.numCtx,
          temperature: this.#config.temperature,
          system_prompt_file: this.#config.promptFile,
          system_prompt_sha256: this.#prompt.sha256,
          prompt,
          response: finalContent,
          input_tokens: totals.promptEvalCount,
          output_tokens: totals.evalCount,
          total_seconds: totals.totalDuration / 1_000_000_000,
          load_seconds: totals.loadDuration / 1_000_000_000,
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
        model: this.#config.model,
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
