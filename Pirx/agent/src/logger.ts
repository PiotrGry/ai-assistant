import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";

import type { AgentConfig, StorageMode, SystemPrompt } from "./config.js";
import type { TurnMetrics } from "./agent.js";
import type { Message } from "ollama";
import { SqliteActionLedger } from "./action-ledger.js";
import { SqliteOperationRecorder } from "./operation-recorder.js";
import type { OperationRecorder } from "./operation-recorder.js";
import { ResourceSampler } from "./resource-sampler.js";
import { SqliteStore, type ResourceSummary } from "./storage/sqlite.js";
import { readGpuStats } from "./telemetry.js";

export interface SessionTurn {
  readonly id: string;
  readonly sequence: number;
  readonly sessionId?: string;
  readonly actionLedger?: SqliteActionLedger;
  readonly operationRecorder?: OperationRecorder;
}

function sessionId(date: Date): string {
  return date.toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function contentReference(content: string): Record<string, unknown> {
  return {
    sha256: contentHash(content),
    characters: Array.from(content).length,
  };
}

export class SessionLogger {
  readonly transcriptFile: string;
  readonly metricsFile: string;
  readonly storageFile: string | undefined;
  readonly storageMode: StorageMode;
  readonly actionLedger: SqliteActionLedger | undefined;
  readonly operationRecorder: OperationRecorder | undefined;
  readonly #store: SqliteStore | undefined;
  readonly #resourceSampler: ResourceSampler | undefined;
  readonly #sessionId: string | undefined;
  #lastMetrics: TurnMetrics | undefined;
  #turnSequence = 0;
  #closed = false;

  private constructor(
    transcriptFile: string,
    metricsFile: string,
    store: SqliteStore | undefined,
    sessionId: string | undefined,
    actionLedger: SqliteActionLedger | undefined,
    operationRecorder: OperationRecorder | undefined,
    resourceSampler: ResourceSampler | undefined,
    storageMode: StorageMode,
  ) {
    this.transcriptFile = transcriptFile;
    this.metricsFile = metricsFile;
    this.storageFile = store?.filename;
    this.storageMode = storageMode;
    this.#store = store;
    this.#sessionId = sessionId;
    this.actionLedger = actionLedger;
    this.operationRecorder = operationRecorder;
    this.#resourceSampler = resourceSampler;
  }

  static async create(config: AgentConfig, prompt: SystemPrompt): Promise<SessionLogger> {
    await mkdir(config.logDir, { recursive: true, mode: 0o700 });
    await chmod(config.logDir, 0o700).catch(() => undefined);

    const startedAt = new Date().toISOString();
    const id = sessionId(new Date(startedAt));
    let store: SqliteStore | undefined;
    let databaseSessionId: string | undefined;
    const gpuAtSessionStart = await readGpuStats();

    if (config.storagePath !== undefined) {
      await mkdir(dirname(config.storagePath), { recursive: true, mode: 0o700 });
      await chmod(dirname(config.storagePath), 0o700).catch(() => undefined);
      store = SqliteStore.open({ filename: config.storagePath });
      databaseSessionId = randomUUID();
      try {
        store.recoverInterrupted(startedAt);
        const environmentId = randomUUID();
        store.insertRunEnvironment({
          id: environmentId,
          createdAt: startedAt,
          payload: {
            schema_version: 1,
            node_version: process.version,
            model: config.model,
            base_url: config.baseUrl,
            num_ctx: config.numCtx,
            keep_alive: config.keepAlive,
            temperature: config.temperature,
            max_output_tokens: config.maxOutputTokens ?? null,
            context_safety_margin_tokens:
              config.contextSafetyMarginTokens ?? null,
            time_zone: config.timeZone,
            prompt_file: config.promptFile,
            prompt_sha256: prompt.sha256,
            storage_mode: config.storageMode ?? "redacted",
            environment: {
              node_version: process.version,
              platform: platform(),
              release: release(),
              arch: arch(),
              hostname: hostname(),
              cpu_count: cpus().length,
              total_memory_bytes: totalmem(),
              free_memory_bytes: freemem(),
              gpu_at_session_start: gpuAtSessionStart,
            },
          },
        });
        store.insertSession({
          id: databaseSessionId,
          environmentId,
          startedAt,
          status: "active",
        });
      } catch (error) {
        store.close();
        throw error;
      }
    }

    const logger = new SessionLogger(
      resolve(config.logDir, `session_${id}.md`),
      resolve(config.logDir, `session_${id}.jsonl`),
      store,
      databaseSessionId,
      store === undefined ? undefined : new SqliteActionLedger(store),
      store === undefined ? undefined : new SqliteOperationRecorder(store),
      store === undefined ||
      databaseSessionId === undefined ||
      config.resourceSampleIntervalMs === undefined
        ? undefined
        : new ResourceSampler(store, {
            intervalMs: config.resourceSampleIntervalMs,
            sessionId: databaseSessionId,
          }),
      config.storageMode ?? "redacted",
    );
    const header = [
      "# Rozmowa z Pirxem",
      "",
      `- Model: \`${config.model}\``,
      `- Kontekst: \`${config.numCtx}\``,
      `- Strefa czasowa: \`${config.timeZone}\``,
      `- System prompt: \`${config.promptFile}\` (sha256: \`${prompt.sha256}\`)`,
      `- Start: \`${startedAt}\``,
      "",
    ].join("\n");

    await writeFile(logger.transcriptFile, header, { encoding: "utf8", mode: 0o600 });
    await writeFile(logger.metricsFile, "", { encoding: "utf8", mode: 0o600 });
    logger.#resourceSampler?.start();
    return logger;
  }

  get lastMetrics(): TurnMetrics | undefined {
    return this.#lastMetrics;
  }

  get resourceSummary(): ResourceSummary | undefined {
    return this.#store === undefined || this.#sessionId === undefined
      ? undefined
      : this.#store.resourceSummary(this.#sessionId);
  }

  beginTurn(prompt: string): SessionTurn {
    if (this.#closed) {
      throw new Error("Session logger is closed.");
    }
    const turn: SessionTurn = {
      id: randomUUID(),
      sequence: this.#turnSequence,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(this.actionLedger === undefined ? {} : { actionLedger: this.actionLedger }),
      ...(this.operationRecorder === undefined
        ? {}
        : { operationRecorder: this.operationRecorder }),
    };
    if (this.#store !== undefined && this.#sessionId !== undefined) {
      this.#store.insertTurn({
        id: turn.id,
        sessionId: this.#sessionId,
        sequence: turn.sequence,
        startedAt: new Date().toISOString(),
        status: "started",
        userPrompt: this.storageMode === "full_local" ? prompt : "",
        payload: {
          schema_version: 1,
          storage_mode: this.storageMode,
          ...(this.storageMode === "full_local"
            ? {}
            : { user_prompt: contentReference(prompt) }),
        },
      });
    }
    this.#turnSequence += 1;
    this.#resourceSampler?.setTurnId(turn.id);
    return turn;
  }

  async saveTurn(
    prompt: string,
    response: string,
    metrics: TurnMetrics,
    turn?: SessionTurn,
    messages: readonly Message[] = [],
  ): Promise<void> {
    if (this.#closed) {
      throw new Error("Session logger is closed.");
    }
    const transcript = `## Ty\n\n${prompt}\n\n## Pirx\n\n${response}\n\n`;
    if (
      this.#store !== undefined &&
      this.#sessionId !== undefined &&
      turn !== undefined
    ) {
      const createdAt = new Date().toISOString();
      if (this.storageMode !== "metrics_only") {
        for (const [sequence, message] of messages.entries()) {
          const content = message.content ?? "";
          const payload =
            this.storageMode === "full_local"
              ? (message as unknown as Record<string, unknown>)
              : {
                  schema_version: 1,
                  content: contentReference(content),
                };
          this.#store.insertMessage({
            id: randomUUID(),
            sessionId: this.#sessionId,
            turnId: turn.id,
            sequence,
            role: message.role,
            ...(this.storageMode === "full_local" ? { content } : {}),
            ...(message.tool_name === undefined
              ? {}
              : { toolName: message.tool_name }),
            payload,
            createdAt,
          });
          if (message.role === "tool") {
            this.#store.insertArtifact({
              id: randomUUID(),
              sessionId: this.#sessionId,
              turnId: turn.id,
              kind: "mcp_tool_result",
              source: message.tool_name ?? "unknown",
              contentHash: contentHash(content),
              ...(this.storageMode === "full_local" ? { content } : {}),
              payload: {
                schema_version: 1,
                ...(this.storageMode === "full_local"
                  ? {}
                  : { content: contentReference(content) }),
              },
              createdAt,
            });
          }
        }
      }
    } else if (this.#store !== undefined && this.#sessionId !== undefined) {
      this.#store.insertTurn({
        id: randomUUID(),
        sessionId: this.#sessionId,
        sequence: this.#turnSequence,
        startedAt: metrics.timestamp,
        status: "completed",
        userPrompt: this.storageMode === "full_local" ? prompt : "",
        payload: {
          schema_version: 1,
          storage_mode: this.storageMode,
          ...(this.storageMode === "full_local"
            ? { response }
            : {
                user_prompt: contentReference(prompt),
                response: contentReference(response),
              }),
          metrics,
        },
      });
      this.#turnSequence += 1;
    }
    await appendFile(this.transcriptFile, transcript, "utf8");
    await appendFile(this.metricsFile, `${JSON.stringify(metrics)}\n`, "utf8");
    if (
      this.#store !== undefined &&
      this.#sessionId !== undefined &&
      turn !== undefined
    ) {
      this.#store.finishTurn(turn.id, new Date().toISOString(), "completed", {
        schema_version: 1,
        storage_mode: this.storageMode,
        ...(this.storageMode === "full_local"
          ? { response }
          : { response: contentReference(response) }),
        metrics,
      });
    }
    this.#lastMetrics = metrics;
    this.#resourceSampler?.setTurnId(undefined);
  }

  async failTurn(turn: SessionTurn, error: unknown): Promise<void> {
    if (this.#closed) {
      throw new Error("Session logger is closed.");
    }
    if (this.#store !== undefined && this.#sessionId !== undefined) {
      this.#store.finishTurn(turn.id, new Date().toISOString(), "failed", {
        schema_version: 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.#resourceSampler?.setTurnId(undefined);
  }

  async notePromptReload(prompt: SystemPrompt): Promise<void> {
    if (this.#closed) {
      throw new Error("Session logger is closed.");
    }
    await appendFile(
      this.transcriptFile,
      `> System prompt wczytany ponownie (sha256: \`${prompt.sha256}\`). Historia wyczyszczona.\n\n`,
      "utf8",
    );
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#resourceSampler?.stop();
    if (this.#store !== undefined && this.#sessionId !== undefined) {
      try {
        this.#store.finishSession(
          this.#sessionId,
          new Date().toISOString(),
          "completed",
        );
      } finally {
        this.#store.close();
      }
    }
  }
}
