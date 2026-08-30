import { access } from "node:fs/promises";

import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Tool } from "ollama";

import { toolResultToText } from "./tool-result.js";

export interface ToolExecution {
  readonly text: string;
  readonly isError: boolean;
  readonly serverUnavailable: boolean;
}

interface ListedMcpTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: unknown;
}

const CHILD_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMPDIR",
  "TZ",
  "USER",
  "PIRX_OBSIDIAN_VAULT",
  "PIRX_GOOGLE_CREDENTIALS_FILE",
  "PIRX_GOOGLE_TOKEN_FILE",
  "PIRX_GOOGLE_CALENDAR_ID",
  "PIRX_GOOGLE_CALENDAR_TIMEZONE",
  "PIRX_GOOGLE_TIMEOUT_MS",
  "PIRX_GOOGLE_AUTH_TIMEOUT_MS",
] as const;

function childEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function isConnectionFailure(error: unknown): boolean {
  return (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.ConnectionClosed ||
      error.code === SdkErrorCode.NotConnected)
  );
}

export class PirxMcpClient {
  readonly #serverEntry: string;
  readonly #toolTimeoutMs: number;

  #client: Client | undefined;
  #tools: ListedMcpTool[] = [];
  #unavailableReason: string | undefined;

  constructor(serverEntry: string, toolTimeoutMs: number) {
    this.#serverEntry = serverEntry;
    this.#toolTimeoutMs = toolTimeoutMs;
  }

  get toolNames(): readonly string[] {
    return this.#tools.map((tool) => tool.name);
  }

  get ollamaTools(): readonly Tool[] {
    if (this.#unavailableReason !== undefined) {
      return [];
    }

    return this.#tools.map(
      (tool) =>
        ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description ?? "",
            parameters: tool.inputSchema,
          },
        }) as Tool,
    );
  }

  async connect(): Promise<void> {
    try {
      await access(this.#serverEntry);
    } catch {
      throw new Error(
        `Brak zbudowanego serwera MCP: ${this.#serverEntry}. Uruchom najpierw pnpm build.`,
      );
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.#serverEntry],
      stderr: "inherit",
      env: childEnvironment(process.env),
    });

    const client = new Client({
      name: "pirx-agent",
      version: "0.1.0",
    });

    try {
      await client.connect(transport, { timeout: this.#toolTimeoutMs });

      const response = await client.listTools(undefined, {
        timeout: this.#toolTimeoutMs,
      });

      this.#tools = response.tools;
      this.#client = client;
      this.#unavailableReason = undefined;
    } catch (error: unknown) {
      await client.close().catch(() => undefined);

      const detail = error instanceof Error ? error.message : String(error);

      throw new Error(`Nie udało się uruchomić serwera MCP: ${detail}`);
    }
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<ToolExecution> {
    if (this.#client === undefined || this.#unavailableReason !== undefined) {
      const reason = this.#unavailableReason ?? "brak aktywnego połączenia";

      return {
        text: `Serwer MCP jest niedostępny: ${reason}`,
        isError: true,
        serverUnavailable: true,
      };
    }

    if (!this.#tools.some((tool) => tool.name === name)) {
      return {
        text: `Nieznane narzędzie MCP: ${name}. Dostępne: ${this.toolNames.join(", ")}.`,
        isError: true,
        serverUnavailable: false,
      };
    }

    try {
      const result = await this.#client.callTool(
        {
          name,
          arguments: arguments_,
        },
        { timeout: this.#toolTimeoutMs },
      );

      return {
        text: toolResultToText(result),
        isError: result.isError === true,
        serverUnavailable: false,
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);

      if (error instanceof ProtocolError) {
        return {
          text: `Błąd wywołania narzędzia ${name}: ${detail}`,
          isError: true,
          serverUnavailable: false,
        };
      }

      if (isConnectionFailure(error)) {
        this.#unavailableReason = detail;
        return {
          text: `Serwer MCP jest niedostępny: ${detail}`,
          isError: true,
          serverUnavailable: true,
        };
      }

      return {
        text: `Nie udało się wykonać narzędzia ${name}: ${detail}`,
        isError: true,
        serverUnavailable: false,
      };
    }
  }

  async close(): Promise<void> {
    const client = this.#client;

    this.#client = undefined;
    this.#tools = [];

    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
  }
}
