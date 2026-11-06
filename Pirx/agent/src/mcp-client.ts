import { access } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Tool } from "ollama";
import { MCP_CHILD_ENVIRONMENT_KEYS, type ToolProfile } from "@pirx/config";
import { modelToolSchema } from "./model-tool-schema.js";

import { toolResultToText } from "./tool-result.js";
import {
  HOST_AUTHORIZATION_META_KEY,
  createHostAuthorization,
  type HostToolAuthorization,
} from "./mcp-authorization.js";

export interface ToolExecution {
  readonly text: string;
  readonly isError: boolean;
  readonly serverUnavailable: boolean;
  readonly outcome: "succeeded" | "failed_before_execution" | "confirmed_failure" | "unknown";
  readonly correlationId?: string;
}

interface ListedMcpTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: unknown;
  readonly annotations?:
    | {
      readonly readOnlyHint?: boolean | undefined;
      }
    | undefined;
}

function childEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of MCP_CHILD_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function isConnectionFailure(error: unknown): boolean {
  const typed = (
    error instanceof SdkError &&
    (error.code === SdkErrorCode.ConnectionClosed ||
      error.code === SdkErrorCode.NotConnected)
  );
  const message = error instanceof Error ? error.message : String(error);
  return typed || /(?:connection|transport) (?:is )?(?:closed|not connected)|not connected/iu.test(message);
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

async function withinDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`${label}: brak pozostałego budżetu czasu.`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} przekroczyło pozostały budżet ${timeoutMs} ms.`)), timeoutMs);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export class PirxMcpClient {
  readonly #serverEntry: string;
  readonly #toolTimeoutMs: number;
  readonly #maxToolResultCharacters: number;
  #authorizationSecret: string;
  readonly #rotateAuthorizationSecret: boolean;
  readonly #toolProfile: ToolProfile | undefined;

  #client: Client | undefined;
  #tools: ListedMcpTool[] = [];
  #unavailableReason: string | undefined;
  #reconnectFailures = 0;
  #nextReconnectAt = 0;

  constructor(
    serverEntry: string,
    toolTimeoutMs: number,
    maxToolResultCharacters = 12_000,
    authorizationSecret?: string,
    toolProfile?: ToolProfile,
  ) {
    this.#serverEntry = serverEntry;
    this.#toolTimeoutMs = toolTimeoutMs;
    this.#maxToolResultCharacters = maxToolResultCharacters;
    this.#authorizationSecret = authorizationSecret ?? randomBytes(32).toString("base64url");
    this.#rotateAuthorizationSecret = authorizationSecret === undefined;
    this.#toolProfile = toolProfile;
  }

  get toolNames(): readonly string[] {
    return this.#tools.map((tool) => tool.name);
  }

  get isAvailable(): boolean {
    return this.#client !== undefined && this.#unavailableReason === undefined;
  }

  get unavailableReason(): string | undefined {
    return this.#unavailableReason;
  }

  isReadOnlyTool(name: string): boolean {
    return this.#tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint === true;
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
            parameters: modelToolSchema(tool.inputSchema),
          },
        }) as Tool,
    );
  }

  async connect(maximumDurationMs: number = this.#toolTimeoutMs): Promise<void> {
    const budget = Math.min(this.#toolTimeoutMs, Math.floor(maximumDurationMs));
    if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Nie można połączyć MCP bez dodatniego budżetu czasu.");
    if (this.isAvailable) return;
    await this.#openConnection(performance.now() + budget);
  }

  async ensureConnected(maximumDurationMs: number): Promise<boolean> {
    if (this.isAvailable) return true;
    const budget = Math.min(this.#toolTimeoutMs, Math.floor(maximumDurationMs));
    if (!Number.isSafeInteger(budget) || budget <= 0) return false;
    const deadline = performance.now() + budget;
    const waitMs = Math.max(0, Math.ceil(this.#nextReconnectAt - performance.now()));
    if (waitMs > 0) {
      if (waitMs >= remainingMilliseconds(deadline)) return false;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, waitMs));
    }
    try {
      await this.#openConnection(deadline);
      return true;
    } catch {
      return false;
    }
  }

  async #openConnection(deadline: number): Promise<void> {
    try {
      await withinDeadline(access(this.#serverEntry), remainingMilliseconds(deadline), "Sprawdzenie serwera MCP");
    } catch {
      const error = new Error(
        `Brak zbudowanego serwera MCP: ${this.#serverEntry}. Uruchom najpierw pnpm build.`,
      );
      this.#markUnavailable(error.message);
      throw error;
    }

    const previous = this.#client;
    this.#client = undefined;
    if (previous !== undefined) void previous.close().catch(() => undefined);
    if (this.#rotateAuthorizationSecret) this.#authorizationSecret = randomBytes(32).toString("base64url");
    const environment = childEnvironment(process.env);
    if (this.#toolProfile !== undefined) environment.PIRX_TOOL_PROFILE = this.#toolProfile;
    environment.PIRX_MCP_AUTH_SECRET = this.#authorizationSecret;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.#serverEntry],
      stderr: "inherit",
      env: environment,
    });

    const client = new Client({
      name: "pirx-agent",
      version: "0.1.0",
    });

    try {
      await client.connect(transport, { timeout: remainingMilliseconds(deadline) });

      const response = await client.listTools(undefined, {
        timeout: remainingMilliseconds(deadline),
      });

      this.#tools = response.tools;
      this.#client = client;
      this.#unavailableReason = undefined;
      this.#reconnectFailures = 0;
      this.#nextReconnectAt = 0;
    } catch (error: unknown) {
      await client.close().catch(() => undefined);

      const detail = error instanceof Error ? error.message : String(error);
      this.#markUnavailable(detail);
      throw new Error(`Nie udało się uruchomić serwera MCP: ${detail}`);
    }
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
    authorization?: Pick<HostToolAuthorization, "operationId"> & Partial<Pick<HostToolAuthorization, "idempotencyKey">>,
    maximumResultCharacters: number = this.#maxToolResultCharacters,
    maximumDurationMs: number = this.#toolTimeoutMs,
  ): Promise<ToolExecution> {
    const budget = Math.min(this.#toolTimeoutMs, Math.floor(maximumDurationMs));
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      return { text: "Nie wykonano wywołania MCP: budżet czasu został wyczerpany przed dispatch.", isError: true, serverUnavailable: false, outcome: "failed_before_execution" };
    }
    const deadline = performance.now() + budget;
    if (!await this.ensureConnected(remainingMilliseconds(deadline))) {
      const reason = this.#unavailableReason ?? "brak aktywnego połączenia";

      return {
        text: `Serwer MCP jest niedostępny: ${reason}`,
        isError: true,
        serverUnavailable: true,
        outcome: "failed_before_execution",
      };
    }

    if (!this.#tools.some((tool) => tool.name === name)) {
      return {
        text: `Nieznane narzędzie MCP: ${name}. Dostępne: ${this.toolNames.join(", ")}.`,
        isError: true,
        serverUnavailable: false,
        outcome: "failed_before_execution",
      };
    }

    let mutating = !this.isReadOnlyTool(name);
    const request = {
      name,
      arguments: arguments_,
      ...(authorization === undefined ? {} : { _meta: { [HOST_AUTHORIZATION_META_KEY]: createHostAuthorization(this.#authorizationSecret, name, arguments_, authorization.operationId, authorization.idempotencyKey ?? authorization.operationId) } }),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = this.#client;
      if (client === undefined || remainingMilliseconds(deadline) <= 0) {
        return { text: "Nie wykonano wywołania MCP: połączenie lub budżet czasu skończyły się przed dispatch.", isError: true, serverUnavailable: client === undefined, outcome: "failed_before_execution" };
      }
      let dispatched = false;
      try {
        dispatched = true;
        const result = await client.callTool(request, { timeout: remainingMilliseconds(deadline) });
        const details = result.structuredContent as Record<string, unknown> | undefined;
        const correlationId = typeof details?.correlationId === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(details.correlationId) ? details.correlationId : undefined;
        const outcome = details?.remoteOutcome === "unknown" || details?.outcome === "unknown" || (mutating && result.isError === true && details?.remoteOutcome !== "not_accepted")
          ? "unknown" : result.isError === true ? "confirmed_failure" : "succeeded";
        return {
          text: toolResultToText(result, Math.max(256, Math.min(this.#maxToolResultCharacters, maximumResultCharacters)), name),
          isError: outcome !== "succeeded", outcome,
          ...(correlationId === undefined ? {} : { correlationId }), serverUnavailable: false,
        };
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        const connectionFailure = isConnectionFailure(error);
        if (connectionFailure) {
          this.#loseConnection(detail);
          if (!mutating && attempt === 0 && remainingMilliseconds(deadline) > 0 && await this.ensureConnected(remainingMilliseconds(deadline))) {
            const refreshed = this.#tools.find((tool) => tool.name === name);
            if (refreshed !== undefined && refreshed.annotations?.readOnlyHint === true) {
              mutating = false;
              continue;
            }
          }
        }
        const outcome = !dispatched ? "failed_before_execution" : mutating ? "unknown" : "confirmed_failure";
        if (error instanceof ProtocolError && !connectionFailure) {
          return { text: `Błąd wywołania narzędzia ${name}: ${detail}`, isError: true, serverUnavailable: false, outcome };
        }
        return {
          text: connectionFailure ? `Serwer MCP jest niedostępny: ${detail}` : `Błąd wywołania narzędzia ${name}: ${detail}`,
          isError: true, serverUnavailable: connectionFailure, outcome,
        };
      }
    }
    return { text: `Nie udało się wykonać odczytu ${name} po jednym kontrolowanym reconnect.`, isError: true, serverUnavailable: true, outcome: "confirmed_failure" };
  }

  #markUnavailable(reason: string): void {
    this.#unavailableReason = reason;
    this.#reconnectFailures = Math.min(this.#reconnectFailures + 1, 8);
    const backoffMs = Math.min(1_000, 25 * 2 ** (this.#reconnectFailures - 1));
    this.#nextReconnectAt = performance.now() + backoffMs;
  }

  #loseConnection(reason: string): void {
    const client = this.#client;
    this.#client = undefined;
    this.#markUnavailable(reason);
    if (client !== undefined) void client.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    const client = this.#client;

    this.#client = undefined;
    this.#tools = [];
    this.#unavailableReason = undefined;
    this.#reconnectFailures = 0;
    this.#nextReconnectAt = 0;

    if (client !== undefined) {
      await client.close().catch(() => undefined);
    }
  }
}
