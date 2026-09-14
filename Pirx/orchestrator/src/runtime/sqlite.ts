import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  deserializeAttempt,
  deserializeTask,
  serializeAttempt,
  serializeTask,
  type AttemptSnapshot,
  type AttemptState,
  type TaskSnapshot,
  type TaskState,
} from "./task-domain.js";

export const RUNTIME_STORAGE_SCHEMA_VERSION = 2 as const;
export const DEFAULT_RUNTIME_BUSY_TIMEOUT_MS = 5_000;

export type StorageOutcome = "success" | "not_found" | "conflict" | "invalid_record" | "storage_error";
export type StorageResult<T> =
  | { readonly outcome: "success"; readonly value: T }
  | { readonly outcome: Exclude<StorageOutcome, "success">; readonly message: string };

export interface RuntimeSqliteStoreOptions {
  readonly filename?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly busyTimeoutMs?: number;
}

export interface TaskCompareAndSet {
  readonly state: TaskState;
  readonly updatedAt: string;
}

export interface RuntimeTransaction {
  readonly tasks: TaskRepository;
  readonly attempts: AttemptRepository;
}

export class RuntimeStorageError extends Error {
  readonly code: "invalid_configuration" | "storage_error";

  public constructor(code: "invalid_configuration" | "storage_error", message: string) {
    super(message);
    this.name = "RuntimeStorageError";
    this.code = code;
  }
}

function success<T>(value: T): StorageResult<T> {
  return { outcome: "success", value };
}
function notFound<T>(message: string): StorageResult<T> {
  return { outcome: "not_found", message };
}
function conflict<T>(message: string): StorageResult<T> {
  return { outcome: "conflict", message };
}
function invalidRecord<T>(): StorageResult<T> {
  return { outcome: "invalid_record", message: "Stored runtime record failed domain validation." };
}
function storageFailure<T>(): StorageResult<T> {
  return { outcome: "storage_error", message: "SQLite runtime storage operation failed." };
}
function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function classifyStorageError<T>(error: unknown): StorageResult<T> {
  const message = asErrorMessage(error).toLowerCase();
  if (message.includes("constraint") || message.includes("unique") || message.includes("foreign key")) return conflict("Runtime record conflicts with an existing record or constraint.");
  return storageFailure();
}
function busyTimeout(value: number | undefined): number {
  const result = value ?? DEFAULT_RUNTIME_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(result) || result < 0 || result > 120_000) throw new RuntimeStorageError("invalid_configuration", "SQLite busy timeout must be an integer from 0 to 120000 ms.");
  return result;
}
function storageFilename(environment: NodeJS.ProcessEnv): string {
  const configured = environment.PIRX_STORAGE_FILE?.trim();
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  const dataHome = environment.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "pirx", "pirx.sqlite");
}
export function defaultRuntimeStoragePath(environment: NodeJS.ProcessEnv = process.env): string {
  return storageFilename(environment);
}

const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_tasks (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      github_owner TEXT,
      github_repository TEXT,
      github_issue_number INTEGER CHECK (github_issue_number IS NULL OR github_issue_number > 0),
      goal TEXT NOT NULL CHECK (length(trim(goal)) > 0),
      scope TEXT NOT NULL CHECK (length(trim(scope)) > 0),
      acceptance_criteria_json TEXT NOT NULL CHECK (json_valid(acceptance_criteria_json)),
      priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
      risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
      required_capabilities_json TEXT NOT NULL CHECK (json_valid(required_capabilities_json)),
      state TEXT NOT NULL CHECK (state IN ('ready', 'in_progress', 'blocked', 'failed', 'completed', 'cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      blocking_reason TEXT,
      completion_evidence_json TEXT CHECK (completion_evidence_json IS NULL OR json_valid(completion_evidence_json)),
      CHECK ((github_owner IS NULL AND github_repository IS NULL AND github_issue_number IS NULL) OR (github_owner IS NOT NULL AND github_repository IS NOT NULL AND github_issue_number IS NOT NULL)),
      CHECK ((state = 'completed' AND completion_evidence_json IS NOT NULL) OR (state <> 'completed' AND completion_evidence_json IS NULL))
    );

    CREATE TABLE IF NOT EXISTS runtime_attempts (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      worker TEXT NOT NULL CHECK (length(trim(worker)) > 0),
      provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
      state TEXT NOT NULL CHECK (state IN ('running', 'terminal')),
      result TEXT CHECK (result IS NULL OR result IN ('CODE_PUSHED', 'BLOCKED', 'FAILED', 'QUOTA_EXHAUSTED', 'CANCELLED', 'UNKNOWN')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      branch TEXT,
      worktree TEXT,
      current_commit TEXT,
      final_commit TEXT,
      checkpoint_reference TEXT,
      blocking_reason TEXT,
      UNIQUE (task_id, ordinal),
      CHECK ((state = 'running' AND result IS NULL AND ended_at IS NULL) OR (state = 'terminal' AND result IS NOT NULL AND ended_at IS NOT NULL)),
      CHECK ((result = 'CODE_PUSHED' AND final_commit IS NOT NULL) OR (result IS NULL OR result <> 'CODE_PUSHED')),
      CHECK ((result IS NULL OR result = 'CODE_PUSHED') OR blocking_reason IS NOT NULL)
    );
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_attempts_one_running
      ON runtime_attempts (task_id) WHERE state = 'running';
    CREATE INDEX IF NOT EXISTS runtime_tasks_state_updated
      ON runtime_tasks (state, updated_at, id);
    CREATE INDEX IF NOT EXISTS runtime_attempts_task_ordinal
      ON runtime_attempts (task_id, ordinal);
    CREATE INDEX IF NOT EXISTS runtime_attempts_task_state
      ON runtime_attempts (task_id, state, ordinal);
  `,
];

function bootstrap(database: DatabaseSync, timeoutMs: number): void {
  database.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = ${timeoutMs};`);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("CREATE TABLE IF NOT EXISTS runtime_schema_migrations (version INTEGER PRIMARY KEY CHECK (version > 0), applied_at TEXT NOT NULL)");
    const rows = database.prepare("SELECT version FROM runtime_schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    const current = rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.version));
    if (current > RUNTIME_STORAGE_SCHEMA_VERSION || rows.some((row, index) => !Number.isSafeInteger(row.version) || row.version !== index + 1 || row.version > RUNTIME_STORAGE_SCHEMA_VERSION)) {
      throw new RuntimeStorageError("storage_error", "SQLite runtime schema is newer or incompatible.");
    }
    for (let version = current + 1; version <= RUNTIME_STORAGE_SCHEMA_VERSION; version += 1) {
      database.exec(MIGRATIONS[version - 1] ?? "");
      database.prepare("INSERT INTO runtime_schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
    }
    const requiredTables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runtime_tasks', 'runtime_attempts')").all() as Array<{ name: string }>;
    if (requiredTables.length !== 2) throw new RuntimeStorageError("storage_error", "SQLite runtime schema is incomplete.");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* preserve the startup failure */ }
    throw error;
  }
}

type TaskRow = Record<string, unknown>;
type AttemptRow = Record<string, unknown>;

function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}
function jsonParse(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("invalid json");
  return JSON.parse(value) as unknown;
}
function taskFromRow(row: TaskRow): StorageResult<TaskSnapshot> {
  try {
    const githubReference = row.github_owner === null ? undefined : { owner: row.github_owner, repository: row.github_repository, issueNumber: row.github_issue_number };
    const completionEvidence = row.completion_evidence_json === null ? undefined : jsonParse(row.completion_evidence_json);
    const parsed = deserializeTask(JSON.stringify({
      kind: "task", schemaVersion: row.schema_version, id: row.id, githubReference,
      goal: row.goal, scope: row.scope, acceptanceCriteria: jsonParse(row.acceptance_criteria_json), priority: row.priority,
      risk: row.risk, requiredCapabilities: jsonParse(row.required_capabilities_json), state: row.state,
      createdAt: row.created_at, updatedAt: row.updated_at, ...(row.blocking_reason === null ? {} : { blockingReason: row.blocking_reason }),
      ...(completionEvidence === undefined ? {} : { completionEvidence }),
    }));
    return parsed.ok ? success(parsed.value) : invalidRecord();
  } catch {
    return invalidRecord();
  }
}
function attemptFromRow(row: AttemptRow): StorageResult<AttemptSnapshot> {
  try {
    const parsed = deserializeAttempt(JSON.stringify({
      kind: "attempt", schemaVersion: row.schema_version, id: row.id, taskId: row.task_id, ordinal: row.ordinal,
      worker: row.worker, provider: row.provider, state: row.state, startedAt: row.started_at,
      ...(row.result === null ? {} : { result: row.result }), ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      ...(row.branch === null ? {} : { branch: row.branch }), ...(row.worktree === null ? {} : { worktree: row.worktree }),
      ...(row.current_commit === null ? {} : { currentCommit: row.current_commit }), ...(row.final_commit === null ? {} : { finalCommit: row.final_commit }),
      ...(row.checkpoint_reference === null ? {} : { checkpointReference: row.checkpoint_reference }), ...(row.blocking_reason === null ? {} : { blockingReason: row.blocking_reason }),
    }));
    return parsed.ok ? success(parsed.value) : invalidRecord();
  } catch {
    return invalidRecord();
  }
}
function storedRecord<T>(result: StorageResult<T>): StorageResult<T> {
  return result;
}

export class TaskRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public create(task: TaskSnapshot): StorageResult<TaskSnapshot> {
    return this.#store.execute(() => {
      const validated = deserializeTask(serializeTask(task));
      if (!validated.ok) return invalidRecord();
      try {
        this.#store.database.prepare(`INSERT INTO runtime_tasks (id, schema_version, github_owner, github_repository, github_issue_number, goal, scope, acceptance_criteria_json, priority, risk, required_capabilities_json, state, created_at, updated_at, blocking_reason, completion_evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          task.id, 1, task.githubReference?.owner ?? null, task.githubReference?.repository ?? null, task.githubReference?.issueNumber ?? null,
          task.goal, task.scope, jsonValue(task.acceptanceCriteria), task.priority, task.risk, jsonValue(task.requiredCapabilities), task.state, task.createdAt, task.updatedAt,
          task.blockingReason ?? null, task.completionEvidence === undefined ? null : jsonValue(task.completionEvidence),
        );
        return success(validated.value);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public get(id: string): StorageResult<TaskSnapshot> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_tasks WHERE id = ?").get(id) as TaskRow | undefined;
        return row === undefined ? notFound("Task was not found.") : storedRecord(taskFromRow(row));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public list(): StorageResult<readonly TaskSnapshot[]> {
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare("SELECT * FROM runtime_tasks ORDER BY created_at, id").all() as TaskRow[];
        const values: TaskSnapshot[] = [];
        for (const row of rows) { const parsed = taskFromRow(row); if (parsed.outcome !== "success") return parsed; values.push(parsed.value); }
        return success(Object.freeze(values));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public update(task: TaskSnapshot, expected: TaskCompareAndSet): StorageResult<TaskSnapshot> {
    return this.#store.execute(() => {
      const validated = deserializeTask(serializeTask(task));
      if (!validated.ok) return invalidRecord();
      try {
        const result = this.#store.database.prepare(`UPDATE runtime_tasks SET schema_version = ?, github_owner = ?, github_repository = ?, github_issue_number = ?, goal = ?, scope = ?, acceptance_criteria_json = ?, priority = ?, risk = ?, required_capabilities_json = ?, state = ?, created_at = ?, updated_at = ?, blocking_reason = ?, completion_evidence_json = ? WHERE id = ? AND state = ? AND updated_at = ?`).run(
          1, task.githubReference?.owner ?? null, task.githubReference?.repository ?? null, task.githubReference?.issueNumber ?? null,
          task.goal, task.scope, jsonValue(task.acceptanceCriteria), task.priority, task.risk, jsonValue(task.requiredCapabilities), task.state, task.createdAt, task.updatedAt,
          task.blockingReason ?? null, task.completionEvidence === undefined ? null : jsonValue(task.completionEvidence), task.id, expected.state, expected.updatedAt,
        );
        if (result.changes !== 1) return this.#store.exists("runtime_tasks", task.id) ? conflict("Task compare-and-set failed.") : notFound("Task was not found.");
        return success(validated.value);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
}

export class AttemptRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public create(attempt: AttemptSnapshot): StorageResult<AttemptSnapshot> {
    return this.#store.execute(() => {
      const validated = deserializeAttempt(serializeAttempt(attempt));
      if (!validated.ok) return invalidRecord();
      try {
        this.#store.database.prepare(`INSERT INTO runtime_attempts (id, schema_version, task_id, ordinal, worker, provider, state, result, started_at, ended_at, branch, worktree, current_commit, final_commit, checkpoint_reference, blocking_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          attempt.id, 1, attempt.taskId, attempt.ordinal, attempt.worker, attempt.provider, attempt.state, attempt.state === "terminal" ? attempt.result : null,
          attempt.startedAt, attempt.state === "terminal" ? attempt.endedAt : null, attempt.branch ?? null, attempt.worktree ?? null, attempt.currentCommit ?? null,
          attempt.state === "terminal" ? attempt.finalCommit ?? null : null, attempt.checkpointReference ?? null, attempt.state === "terminal" ? attempt.blockingReason ?? null : null,
        );
        return success(validated.value);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public get(id: string): StorageResult<AttemptSnapshot> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
        return row === undefined ? notFound("Attempt was not found.") : storedRecord(attemptFromRow(row));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public listByTask(taskId: string): StorageResult<readonly AttemptSnapshot[]> {
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare("SELECT * FROM runtime_attempts WHERE task_id = ? ORDER BY ordinal").all(taskId) as AttemptRow[];
        const values: AttemptSnapshot[] = [];
        for (const row of rows) { const parsed = attemptFromRow(row); if (parsed.outcome !== "success") return parsed; values.push(parsed.value); }
        return success(Object.freeze(values));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public update(attempt: AttemptSnapshot, expectedState: AttemptState): StorageResult<AttemptSnapshot> {
    return this.#store.execute(() => {
      const validated = deserializeAttempt(serializeAttempt(attempt));
      if (!validated.ok) return invalidRecord();
      try {
        const result = this.#store.database.prepare(`UPDATE runtime_attempts SET schema_version = ?, task_id = ?, ordinal = ?, worker = ?, provider = ?, state = ?, result = ?, started_at = ?, ended_at = ?, branch = ?, worktree = ?, current_commit = ?, final_commit = ?, checkpoint_reference = ?, blocking_reason = ? WHERE id = ? AND state = ?`).run(
          1, attempt.taskId, attempt.ordinal, attempt.worker, attempt.provider, attempt.state, attempt.state === "terminal" ? attempt.result : null,
          attempt.startedAt, attempt.state === "terminal" ? attempt.endedAt : null, attempt.branch ?? null, attempt.worktree ?? null, attempt.currentCommit ?? null,
          attempt.state === "terminal" ? attempt.finalCommit ?? null : null, attempt.checkpointReference ?? null, attempt.state === "terminal" ? attempt.blockingReason ?? null : null,
          attempt.id, expectedState,
        );
        if (result.changes !== 1) return this.#store.exists("runtime_attempts", attempt.id) ? conflict("Attempt compare-and-set failed.") : notFound("Attempt was not found.");
        return success(validated.value);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
}

export class RuntimeSqliteStore {
  readonly #database: DatabaseSync;
  readonly #filename: string;
  #closed = false;
  #inTransaction = false;
  readonly tasks: TaskRepository;
  readonly attempts: AttemptRepository;

  private constructor(database: DatabaseSync, filename: string) {
    this.#database = database;
    this.#filename = filename;
    this.tasks = new TaskRepository(this);
    this.attempts = new AttemptRepository(this);
  }

  public static open(options: RuntimeSqliteStoreOptions = {}): RuntimeSqliteStore {
    if (options.filename !== undefined && options.filename.trim().length === 0) throw new RuntimeStorageError("invalid_configuration", "SQLite filename must not be empty.");
    const filename = resolve(options.filename?.trim() ?? storageFilename(options.environment ?? process.env));
    const timeout = busyTimeout(options.busyTimeoutMs);
    let database: DatabaseSync | undefined;
    try {
      mkdirSync(dirname(filename), { recursive: true });
      database = new DatabaseSync(filename);
      bootstrap(database, timeout);
      if (database === undefined) throw new RuntimeStorageError("storage_error", "SQLite runtime storage was not opened.");
      return new RuntimeSqliteStore(database, filename);
    } catch (error: unknown) {
      try { database?.close(); } catch { /* preserve sanitized startup error */ }
      if (error instanceof RuntimeStorageError) throw error;
      throw new RuntimeStorageError("storage_error", "SQLite runtime storage could not be opened or migrated.");
    }
  }

  public get filename(): string { return this.#filename; }
  public get database(): DatabaseSync {
    this.assertOpen();
    return this.#database;
  }

  public transaction<T>(operation: (transaction: RuntimeTransaction) => StorageResult<T>): StorageResult<T> {
    if (this.#inTransaction) {
      try { return operation({ tasks: this.tasks, attempts: this.attempts }); }
      catch { return storageFailure(); }
    }
    try {
      this.assertOpen();
      this.#database.exec("BEGIN IMMEDIATE");
      this.#inTransaction = true;
      const result = operation({ tasks: this.tasks, attempts: this.attempts });
      if (result.outcome === "success") this.#database.exec("COMMIT");
      else this.#database.exec("ROLLBACK");
      return result;
    } catch (error: unknown) {
      try { this.#database.exec("ROLLBACK"); } catch { /* preserve sanitized outcome */ }
      return classifyStorageError(error);
    } finally {
      this.#inTransaction = false;
    }
  }

  public close(): void {
    if (this.#closed) return;
    try { this.#database.close(); } catch { throw new RuntimeStorageError("storage_error", "SQLite runtime storage could not be closed."); }
    this.#closed = true;
  }

  public execute<T>(operation: () => StorageResult<T>): StorageResult<T> {
    if (this.#inTransaction) {
      try { this.assertOpen(); return operation(); } catch (error: unknown) { return classifyStorageError(error); }
    }
    return this.transaction(() => operation());
  }

  public exists(table: "runtime_tasks" | "runtime_attempts", id: string): boolean {
    this.assertOpen();
    return this.#database.prepare(`SELECT 1 AS found FROM ${table} WHERE id = ?`).get(id) !== undefined;
  }

  private assertOpen(): void {
    if (this.#closed) throw new RuntimeStorageError("storage_error", "SQLite runtime storage is closed.");
  }
}
