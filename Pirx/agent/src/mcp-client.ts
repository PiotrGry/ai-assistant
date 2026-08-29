import { access } from "node:fs/promises";

import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Tool } from "ollama";

import { toolResultToText } from "./tool-result.js";
import { env } from "node:process";

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

export class PirxMcpClient {
  readonly #serverEntry: string;
  #client: Client | undefined;
  #tools: ListedMcpTool[] = [];
  #unavailableReason: string | undefined;

  constructor(serverEntry: string) {
    this.#serverEntry = serverEntry;
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
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.#serverEntry],
      stderr: "inherit",
      env
    });
    const client = new Client({ name: "pirx-agent", version: "0.1.0" });

    try {
      await client.connect(transport);
      const response = await client.listTools();
      this.#tools = response.tools;
      this.#client = client;
      this.#unavailableReason = undefined;
    } catch (error: unknown) {
      await client.close().catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Nie udało się uruchomić serwera MCP: ${detail}`);
    }
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<ToolExecution> {
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
      const result = await this.#client.callTool({ name, arguments: arguments_ });
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

      this.#unavailableReason = detail;
      this.#tools = [];

      return {
        text: `Serwer MCP przestał odpowiadać podczas wywołania ${name}: ${detail}`,
        isError: true,
        serverUnavailable: true,
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
