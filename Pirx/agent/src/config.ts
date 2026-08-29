import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentConfig {
  readonly model: string;
  readonly numCtx: number;
  readonly keepAlive: string;
  readonly baseUrl: string;
  readonly temperature: number;
  readonly promptFile: string;
  readonly logDir: string;
  readonly mcpServerEntry: string;

  readonly maxToolIterations: number;
  readonly maxRepeatedToolCalls: number;

  readonly llmTimeoutMs: number;
  readonly toolTimeoutMs: number;
}

export interface SystemPrompt {
  readonly content: string;
  readonly sha256: string;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${name} musi być dodatnią liczbą całkowitą (otrzymano: ${value}).`,
    );
  }

  return parsed;
}

function finiteNumber(name: string, value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} musi być liczbą (otrzymano: ${value}).`);
  }

  return parsed;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const compiledDirectory = dirname(fileURLToPath(import.meta.url));
  const pirxDirectory = resolve(compiledDirectory, "..", "..");
  const repositoryDirectory = resolve(pirxDirectory, "..");

  const rawBaseUrl =
    environment.OLLAMA_BASE_URL ?? "http://localhost:11434";

  return {
    model: environment.OLLAMA_MODEL ?? "qwen3:14b",

    numCtx: positiveInteger(
      "OLLAMA_NUM_CTX",
      environment.OLLAMA_NUM_CTX ?? "8192",
    ),

    keepAlive: environment.OLLAMA_KEEP_ALIVE ?? "10m",

    baseUrl: rawBaseUrl.replace(/\/+$/u, ""),

    temperature: finiteNumber(
      "OLLAMA_TEMPERATURE",
      environment.OLLAMA_TEMPERATURE ?? "0.3",
    ),

    promptFile:
      environment.ADA_PROMPT_FILE ??
      resolve(repositoryDirectory, "prompts", "system.md"),

    logDir: resolve(repositoryDirectory, "logs"),

    mcpServerEntry: resolve(
      pirxDirectory,
      "mcp-server",
      "dist",
      "index.js",
    ),

    maxToolIterations: positiveInteger(
      "PIRX_MAX_TOOL_ITERATIONS",
      environment.PIRX_MAX_TOOL_ITERATIONS ?? "8",
    ),

    maxRepeatedToolCalls: positiveInteger(
      "PIRX_MAX_REPEATED_TOOL_CALLS",
      environment.PIRX_MAX_REPEATED_TOOL_CALLS ?? "3",
    ),

    llmTimeoutMs: positiveInteger(
      "PIRX_LLM_TIMEOUT_MS",
      environment.PIRX_LLM_TIMEOUT_MS ?? "120000",
    ),

    toolTimeoutMs: positiveInteger(
      "PIRX_TOOL_TIMEOUT_MS",
      environment.PIRX_TOOL_TIMEOUT_MS ?? "30000",
    ),
  };
}

export async function loadSystemPrompt(path: string): Promise<SystemPrompt> {
  let content: string;

  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    const detail =
      error instanceof Error ? error.message : String(error);

    throw new Error(
      `Nie mogę odczytać system promptu ${path}: ${detail}`,
    );
  }

  if (content.trim().length === 0) {
    throw new Error(`System prompt jest pusty: ${path}`);
  }

  return {
    content,
    sha256: createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 12),
  };
}
