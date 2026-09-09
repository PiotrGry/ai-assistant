import { DatabaseSync } from "node:sqlite";

export const STORAGE_SCHEMA_VERSION = 1;

export interface SqliteStoreOptions {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
}

export interface RunEnvironmentRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly payload: Record<string, unknown>;
}

export interface SessionRecord {
  readonly id: string;
  readonly environmentId: string;
  readonly startedAt: string;
  readonly status: "active" | "completed" | "failed";
}

export interface TurnRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly startedAt: string;
  readonly status: "started" | "completed" | "failed";
  readonly userPrompt: string;
  readonly payload: Record<string, unknown>;
}

export interface OperationRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly parentOperationId?: string;
  readonly sequence: number;
  readonly kind: "llm" | "mcp" | "retrieval" | "compaction" | "storage";
  readonly startedAt: string;
  readonly status: "started" | "succeeded" | "failed" | "unknown";
  readonly payload: Record<string, unknown>;
}

export type ActionEventState =
  | "planned"
  | "started"
  | "succeeded"
  | "failed"
  | "unknown";

export interface ActionEventRecord {
  readonly id: string;
  readonly operationId: string;
  readonly mutationId: string;
  readonly target: string;
  readonly attempt: number;
  readonly authorization: Record<string, unknown>;
  readonly state: ActionEventState;
  readonly confirmation?: Record<string, unknown>;
  readonly createdAt: string;
}

export interface ResourceSampleRecord {
  readonly id: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly sampledAt: string;
  readonly source: string;
  readonly host?: string;
  readonly gpuIndex?: number;
  readonly payload: Record<string, unknown>;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function positiveTimeout(value: number | undefined): number {
  if (value === undefined) {
    return 5_000;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`busyTimeoutMs must be a non-negative safe integer: ${value}`);
  }
  return value;
}

function initialize(database: DatabaseSync, busyTimeoutMs: number): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = ${busyTimeoutMs};

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_environments (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL REFERENCES run_environments(id),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'failed'))
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
      user_prompt TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      UNIQUE (session_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      turn_id TEXT NOT NULL REFERENCES turns(id),
      parent_operation_id TEXT REFERENCES operations(id),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      kind TEXT NOT NULL CHECK (kind IN ('llm', 'mcp', 'retrieval', 'compaction', 'storage')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'unknown')),
      error TEXT,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      UNIQUE (turn_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS context_builds (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES operations(id),
      policy_version TEXT NOT NULL,
      estimated_input_tokens INTEGER,
      budget_tokens INTEGER,
      selected_json TEXT NOT NULL CHECK (json_valid(selected_json)),
      omitted_json TEXT NOT NULL CHECK (json_valid(omitted_json)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS action_events (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES operations(id),
      mutation_id TEXT NOT NULL,
      target TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
      state TEXT NOT NULL CHECK (state IN ('planned', 'started', 'succeeded', 'failed', 'unknown')),
      confirmation_json TEXT CHECK (confirmation_json IS NULL OR json_valid(confirmation_json)),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_samples (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES sessions(id),
      turn_id TEXT REFERENCES turns(id),
      sampled_at TEXT NOT NULL,
      source TEXT NOT NULL,
      host TEXT,
      gpu_index INTEGER,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
    );

    CREATE INDEX IF NOT EXISTS idx_turns_session_sequence
      ON turns (session_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_operations_turn_sequence
      ON operations (turn_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_operations_kind_status
      ON operations (kind, status, started_at);
    CREATE INDEX IF NOT EXISTS idx_action_events_mutation
      ON action_events (mutation_id, attempt);
    CREATE INDEX IF NOT EXISTS idx_resource_samples_time
      ON resource_samples (sampled_at);
  `);

  const migration = database.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  migration.run(STORAGE_SCHEMA_VERSION, new Date().toISOString());
  const row = database
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  if (row.version !== STORAGE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported storage schema version: ${String(row.version)} (expected ${STORAGE_SCHEMA_VERSION}).`,
    );
  }
}

export class SqliteStore {
  readonly #database: DatabaseSync;
  readonly #filename: string;
  #closed = false;

  private constructor(database: DatabaseSync, filename: string) {
    this.#database = database;
    this.#filename = filename;
  }

  static open(options: SqliteStoreOptions): SqliteStore {
    const database = new DatabaseSync(options.filename);
    try {
      initialize(database, positiveTimeout(options.busyTimeoutMs));
      return new SqliteStore(database, options.filename);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  get filename(): string {
    return this.#filename;
  }

  insertRunEnvironment(record: RunEnvironmentRecord): void {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO run_environments
          (id, schema_version, created_at, payload_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(record.id, STORAGE_SCHEMA_VERSION, record.createdAt, json(record.payload));
  }

  insertSession(record: SessionRecord): void {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO sessions (id, environment_id, started_at, status)
         VALUES (?, ?, ?, ?)`,
      )
      .run(record.id, record.environmentId, record.startedAt, record.status);
  }

  insertTurn(record: TurnRecord): void {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO turns
          (id, session_id, sequence, started_at, status, user_prompt, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.sequence,
        record.startedAt,
        record.status,
        record.userPrompt,
        json(record.payload),
      );
  }

  finishTurn(
    id: string,
    endedAt: string,
    status: "completed" | "failed",
    payload: Record<string, unknown>,
  ): void {
    this.#assertOpen();
    const result = this.#database
      .prepare(
        `UPDATE turns
         SET ended_at = ?, status = ?, payload_json = ?
         WHERE id = ? AND status = 'started'`,
      )
      .run(endedAt, status, json(payload), id);
    if (result.changes !== 1) {
      throw new Error(`Started SQLite turn not found: ${id}`);
    }
  }

  insertOperation(record: OperationRecord): void {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO operations
          (id, session_id, turn_id, parent_operation_id, sequence, kind,
           started_at, status, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.turnId,
        record.parentOperationId ?? null,
        record.sequence,
        record.kind,
        record.startedAt,
        record.status,
        json(record.payload),
      );
  }

  finishSession(
    id: string,
    endedAt: string,
    status: "completed" | "failed",
  ): void {
    this.#assertOpen();
    const result = this.#database
      .prepare(
        `UPDATE sessions
         SET ended_at = ?, status = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(endedAt, status, id);
    if (result.changes !== 1) {
      throw new Error(`Active SQLite session not found: ${id}`);
    }
  }

  finishOperation(
    id: string,
    endedAt: string,
    status: "succeeded" | "failed" | "unknown",
    error?: string,
    payload?: Record<string, unknown>,
  ): void {
    this.#assertOpen();
    const result = this.#database
      .prepare(
        `UPDATE operations
         SET ended_at = ?, status = ?, error = ?,
             payload_json = COALESCE(?, payload_json)
         WHERE id = ? AND status = 'started'`,
      )
      .run(
        endedAt,
        status,
        error ?? null,
        payload === undefined ? null : json(payload),
        id,
      );
    if (result.changes !== 1) {
      throw new Error(`Started SQLite operation not found: ${id}`);
    }
  }

  insertActionEvent(record: ActionEventRecord): void {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO action_events
          (id, operation_id, mutation_id, target, attempt,
           authorization_json, state, confirmation_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.operationId,
        record.mutationId,
        record.target,
        record.attempt,
        json(record.authorization),
        record.state,
        record.confirmation === undefined ? null : json(record.confirmation),
        record.createdAt,
      );
  }

  insertResourceSample(record: ResourceSampleRecord): void {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO resource_samples
          (id, session_id, turn_id, sampled_at, source, host, gpu_index, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId ?? null,
        record.turnId ?? null,
        record.sampledAt,
        record.source,
        record.host ?? null,
        record.gpuIndex ?? null,
        json(record.payload),
      );
  }

  latestActionState(
    mutationId: string,
  ): { readonly state: ActionEventState; readonly attempt: number } | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        `SELECT state, attempt
         FROM action_events
         WHERE mutation_id = ?
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(mutationId) as
      | { state: ActionEventState; attempt: number }
      | undefined;
    return row;
  }

  count(
    table:
      | "run_environments"
      | "sessions"
      | "turns"
      | "operations"
      | "action_events"
      | "resource_samples",
  ): number {
    this.#assertOpen();
    const row = this.#database
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count: number };
    return row.count;
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("SQLite store is closed.");
    }
  }
}
