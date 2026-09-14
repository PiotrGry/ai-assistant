import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  deserializeAttempt,
  deserializeTask,
  recordAttemptProgress,
  retryTask,
  serializeAttempt,
  serializeTask,
  startInitialAttempt,
  type AttemptId,
  type AttemptSnapshot,
  type AttemptProgressUpdate,
  type AttemptState,
  type RetriedTask,
  type StartedAttempt,
  type StartAttemptInput,
  type GitHubTaskReference,
  type TaskSnapshot,
  type TaskState,
  type TaskId,
  type UtcTimestamp,
  utcTimestamp,
} from "./task-domain.js";
import {
  deserializeCheckpoint,
  serializeCheckpoint,
  validateCheckpoint,
  type Checkpoint,
} from "./checkpoint.js";
import {
  leaseDuration,
  leaseExpiresAt,
  leaseId,
  leaseIsExpired,
  leaseTimestamp,
  leaseWorkerId,
  type LeaseAcquireInput,
  type LeaseId,
  type LeaseOwnershipToken,
  type LeaseRecord,
  type LeaseRecoveryReason,
  type LeaseState,
} from "./lease.js";

export const RUNTIME_STORAGE_SCHEMA_VERSION = 9 as const;
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

export interface CanonicalIssueIdentity {
  readonly owner: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly nodeId: string;
  readonly url: string;
}

export interface RuntimeProjectionInput {
  readonly eventId: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly timestamp: string;
  readonly summary: string;
  readonly branch?: string;
  readonly commit?: string;
}

export type RuntimeProjectionStatus = "pending" | "published" | "ignored";
export interface RuntimeProjectionRecord extends RuntimeProjectionInput {
  readonly status: RuntimeProjectionStatus;
  readonly commentId?: number;
  readonly commentUrl?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}
export interface ProjectionCommentReference {
  readonly id: number;
  readonly url: string;
}

export type RuntimeWebhookDeliveryStatus = "accepted" | "ignored";
export interface RuntimeWebhookDelivery {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action: string;
  readonly payloadDigest: string;
  readonly status: RuntimeWebhookDeliveryStatus;
  readonly receivedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type RuntimeSyncIntentKind = "issue" | "issue_relationship" | "project" | "repository";
export type RuntimeSyncIntentStatus = "pending" | "reconciled";
export interface RuntimeSyncIntentInput {
  readonly intentId: string;
  readonly deliveryId: string;
  readonly kind: RuntimeSyncIntentKind;
  readonly owner?: string;
  readonly repository?: string;
  readonly issueNumber?: number;
  readonly issueNodeId?: string;
  readonly projectId?: string;
  readonly projectItemId?: string;
  readonly eventName: string;
  readonly action: string;
  readonly eventTimestamp: string;
}
export interface RuntimeSyncIntent extends RuntimeSyncIntentInput {
  readonly status: RuntimeSyncIntentStatus;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface RuntimeWebhookAcceptance {
  readonly duplicate: boolean;
  readonly delivery: RuntimeWebhookDelivery;
  readonly intents: readonly RuntimeSyncIntent[];
}

export interface RuntimeTransaction {
  readonly tasks: TaskRepository;
  readonly attempts: AttemptRepository;
  readonly checkpoints: CheckpointRepository;
  readonly leases: LeaseRepository;
  readonly projections: ProjectionRepository;
  readonly webhooks: WebhookRepository;
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
function validCanonicalIdentity(value: CanonicalIssueIdentity): boolean {
  if (typeof value.owner !== "string" || typeof value.repository !== "string" || typeof value.nodeId !== "string" || typeof value.url !== "string" || value.owner.trim().length === 0 || value.repository.trim().length === 0 || value.nodeId.trim().length === 0 || !Number.isSafeInteger(value.issueNumber) || value.issueNumber <= 0) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.pathname === `/${value.owner}/${value.repository}/issues/${String(value.issueNumber)}`;
  } catch { return false; }
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
  `
    CREATE TABLE IF NOT EXISTS runtime_task_issue_links (
      task_id TEXT PRIMARY KEY REFERENCES runtime_tasks(id) ON DELETE CASCADE,
      owner TEXT NOT NULL CHECK (length(trim(owner)) > 0),
      repository TEXT NOT NULL CHECK (length(trim(repository)) > 0),
      issue_number INTEGER NOT NULL CHECK (issue_number > 0),
      node_id TEXT NOT NULL UNIQUE CHECK (length(trim(node_id)) > 0),
      url TEXT NOT NULL CHECK (length(trim(url)) > 0),
      linked_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (owner, repository, issue_number)
    );
    CREATE INDEX IF NOT EXISTS runtime_task_issue_links_issue
      ON runtime_task_issue_links (owner, repository, issue_number);
  `,
  `
    CREATE TABLE IF NOT EXISTS runtime_github_projections (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE CASCADE,
      attempt_id TEXT,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_type TEXT NOT NULL CHECK (event_type IN ('task_accepted', 'attempt_started', 'attempt_result', 'branch_prepared', 'code_pushed', 'blocked_human_action_required', 'retry_cooldown', 'task_completed')),
      timestamp TEXT NOT NULL,
      summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
      branch TEXT,
      commit_sha TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'ignored')),
      comment_id INTEGER,
      comment_url TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (task_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS runtime_github_projections_pending
      ON runtime_github_projections (task_id, status, sequence);
  `,
  `
    CREATE TABLE IF NOT EXISTS runtime_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY CHECK (length(trim(delivery_id)) > 0),
      event_name TEXT NOT NULL CHECK (length(trim(event_name)) > 0),
      action TEXT NOT NULL CHECK (length(trim(action)) > 0),
      payload_digest TEXT NOT NULL CHECK (length(trim(payload_digest)) > 0),
      status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored')),
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_sync_intents (
      intent_id TEXT PRIMARY KEY CHECK (length(trim(intent_id)) > 0),
      delivery_id TEXT NOT NULL REFERENCES runtime_webhook_deliveries(delivery_id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('issue', 'issue_relationship', 'project', 'repository')),
      owner TEXT,
      repository TEXT,
      issue_number INTEGER CHECK (issue_number IS NULL OR issue_number > 0),
      issue_node_id TEXT,
      project_id TEXT,
      project_item_id TEXT,
      event_name TEXT NOT NULL,
      action TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'reconciled')),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (delivery_id, kind, owner, repository, issue_number, issue_node_id, project_id, project_item_id)
    );
    CREATE INDEX IF NOT EXISTS runtime_sync_intents_pending
      ON runtime_sync_intents (status, created_at, intent_id);
  `,
  `
    ALTER TABLE runtime_attempts ADD COLUMN progress TEXT;
    ALTER TABLE runtime_attempts ADD COLUMN test_summary TEXT;
  `,
  `
    CREATE TABLE IF NOT EXISTS runtime_checkpoints (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT,
      previous_attempt_id TEXT NOT NULL REFERENCES runtime_attempts(id) ON DELETE RESTRICT,
      trigger TEXT NOT NULL CHECK (trigger IN ('PROVIDER_QUOTA', 'WORKER_INTERRUPTION', 'MACHINE_RESTART', 'EXPLICIT_PAUSE', 'RECOVERABLE_FAILURE', 'REQUIRED_ATTEMPT')),
      created_at TEXT NOT NULL,
      created_sequence INTEGER NOT NULL UNIQUE CHECK (created_sequence > 0),
      content_json TEXT NOT NULL CHECK (json_valid(content_json)),
      content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) = 64)
    );
    CREATE INDEX IF NOT EXISTS runtime_checkpoints_task_order
      ON runtime_checkpoints (task_id, created_sequence, created_at, id);
  `,
  `
    ALTER TABLE runtime_attempts ADD COLUMN predecessor_attempt_id TEXT REFERENCES runtime_attempts(id) ON DELETE RESTRICT;
  `,
  `
    CREATE TABLE IF NOT EXISTS runtime_leases (
      id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
      task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT,
      attempt_id TEXT REFERENCES runtime_attempts(id) ON DELETE RESTRICT,
      worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0),
      acquired_at TEXT NOT NULL,
      renewed_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'released', 'recovered', 'uncertain')),
      ownership_token TEXT NOT NULL UNIQUE CHECK (length(trim(ownership_token)) > 0),
      version INTEGER NOT NULL CHECK (version > 0),
      released_at TEXT,
      recovered_at TEXT,
      recovery_reason TEXT CHECK (recovery_reason IS NULL OR recovery_reason IN ('expired', 'uncertain')),
      CHECK (state <> 'released' OR released_at IS NOT NULL),
      CHECK (state <> 'recovered' OR (recovered_at IS NOT NULL AND recovery_reason IS NOT NULL)),
      CHECK (state <> 'uncertain' OR recovery_reason = 'uncertain')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_leases_one_task_active
      ON runtime_leases (task_id) WHERE state = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_leases_one_global_active
      ON runtime_leases (state) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS runtime_leases_worker_state
      ON runtime_leases (worker_id, state, expires_at, id);
    CREATE INDEX IF NOT EXISTS runtime_leases_recoverable
      ON runtime_leases (state, expires_at, id);
  `,
];

const TASK_SELECT = "SELECT t.*, l.owner AS link_owner, l.repository AS link_repository, l.issue_number AS link_issue_number, l.node_id AS link_node_id, l.url AS link_url FROM runtime_tasks t LEFT JOIN runtime_task_issue_links l ON l.task_id = t.id";

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
function checkpointHash(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}
function taskFromRow(row: TaskRow): StorageResult<TaskSnapshot> {
  try {
    const githubReference = row.link_node_id !== null
      ? { owner: row.link_owner, repository: row.link_repository, issueNumber: row.link_issue_number, nodeId: row.link_node_id, url: row.link_url }
      : row.github_owner === null ? undefined : { owner: row.github_owner, repository: row.github_repository, issueNumber: row.github_issue_number };
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
      ...(row.predecessor_attempt_id === null || row.predecessor_attempt_id === undefined ? {} : { predecessorAttemptId: row.predecessor_attempt_id }),
      ...(row.result === null ? {} : { result: row.result }), ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      ...(row.branch === null ? {} : { branch: row.branch }), ...(row.worktree === null ? {} : { worktree: row.worktree }),
      ...(row.current_commit === null ? {} : { currentCommit: row.current_commit }), ...(row.final_commit === null ? {} : { finalCommit: row.final_commit }),
      ...(row.checkpoint_reference === null ? {} : { checkpointReference: row.checkpoint_reference }), ...(row.progress === null ? {} : { progress: row.progress }), ...(row.test_summary === null ? {} : { testSummary: row.test_summary }), ...(row.blocking_reason === null ? {} : { blockingReason: row.blocking_reason }),
    }));
    return parsed.ok ? success(parsed.value) : invalidRecord();
  } catch {
    return invalidRecord();
  }
}
function completionIsBacked(database: DatabaseSync, task: TaskSnapshot): boolean {
  const evidence = task.completionEvidence;
  if (evidence === undefined) return true;
  return database.prepare(`SELECT 1 FROM runtime_attempts WHERE id = ? AND task_id = ? AND state = 'terminal' AND result = 'CODE_PUSHED' AND final_commit = ?
    AND NOT EXISTS (SELECT 1 FROM runtime_attempts WHERE task_id = ? AND state = 'running')`).get(evidence.attemptId, task.id, evidence.finalCommit, task.id) !== undefined;
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
      if (!completionIsBacked(this.#store.database, validated.value)) return conflict("Task completion evidence is not backed by a terminal CODE_PUSHED Attempt of this Task.");
      try {
        this.#store.database.prepare(`INSERT INTO runtime_tasks (id, schema_version, github_owner, github_repository, github_issue_number, goal, scope, acceptance_criteria_json, priority, risk, required_capabilities_json, state, created_at, updated_at, blocking_reason, completion_evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          task.id, 1, task.githubReference?.owner ?? null, task.githubReference?.repository ?? null, task.githubReference?.issueNumber ?? null,
          task.goal, task.scope, jsonValue(task.acceptanceCriteria), task.priority, task.risk, jsonValue(task.requiredCapabilities), task.state, task.createdAt, task.updatedAt,
          task.blockingReason ?? null, task.completionEvidence === undefined ? null : jsonValue(task.completionEvidence),
        );
        const linkResult = this.#store.syncIssueLink(validated.value);
        if (linkResult.outcome !== "success") return linkResult;
        return success(validated.value);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public get(id: string): StorageResult<TaskSnapshot> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
        return row === undefined ? notFound("Task was not found.") : storedRecord(taskFromRow(row));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public getByIssue(identity: Pick<CanonicalIssueIdentity, "owner" | "repository" | "issueNumber">): StorageResult<TaskSnapshot> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare(`${TASK_SELECT} WHERE l.owner = ? AND l.repository = ? AND l.issue_number = ?`).get(identity.owner, identity.repository, identity.issueNumber) as TaskRow | undefined;
        return row === undefined ? notFound("Task was not found for the GitHub Issue.") : taskFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public getByNodeId(nodeId: string): StorageResult<TaskSnapshot> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare(`${TASK_SELECT} WHERE l.node_id = ?`).get(nodeId) as TaskRow | undefined;
        return row === undefined ? notFound("Task was not found for the GitHub Issue node.") : taskFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public linkIssue(taskId: string, identity: CanonicalIssueIdentity, linkedAt: string): StorageResult<TaskSnapshot> {
    return this.#store.execute(() => {
      if (!validCanonicalIdentity(identity)) return { outcome: "invalid_record", message: "Canonical GitHub Issue identity is invalid." };
      if (!utcTimestamp(linkedAt).ok) return { outcome: "invalid_record", message: "Issue linkage timestamp must be canonical UTC." };
      const existing = this.get(taskId);
      if (existing.outcome !== "success") return existing;
      try {
        this.#store.database.prepare("UPDATE runtime_tasks SET github_owner = ?, github_repository = ?, github_issue_number = ? WHERE id = ?").run(identity.owner, identity.repository, identity.issueNumber, taskId);
        this.#store.database.prepare(`INSERT INTO runtime_task_issue_links (task_id, owner, repository, issue_number, node_id, url, linked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET owner = excluded.owner, repository = excluded.repository, issue_number = excluded.issue_number, node_id = excluded.node_id, url = excluded.url, updated_at = excluded.updated_at`).run(taskId, identity.owner, identity.repository, identity.issueNumber, identity.nodeId, identity.url, linkedAt, linkedAt);
        return this.get(taskId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public list(): StorageResult<readonly TaskSnapshot[]> {
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare(`${TASK_SELECT} ORDER BY t.created_at, t.id`).all() as TaskRow[];
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
      if (!completionIsBacked(this.#store.database, validated.value)) return conflict("Task completion evidence is not backed by a terminal CODE_PUSHED Attempt of this Task.");
      try {
        const result = this.#store.database.prepare(`UPDATE runtime_tasks SET schema_version = ?, github_owner = ?, github_repository = ?, github_issue_number = ?, goal = ?, scope = ?, acceptance_criteria_json = ?, priority = ?, risk = ?, required_capabilities_json = ?, state = ?, created_at = ?, updated_at = ?, blocking_reason = ?, completion_evidence_json = ? WHERE id = ? AND state = ? AND updated_at = ?`).run(
          1, task.githubReference?.owner ?? null, task.githubReference?.repository ?? null, task.githubReference?.issueNumber ?? null,
          task.goal, task.scope, jsonValue(task.acceptanceCriteria), task.priority, task.risk, jsonValue(task.requiredCapabilities), task.state, task.createdAt, task.updatedAt,
          task.blockingReason ?? null, task.completionEvidence === undefined ? null : jsonValue(task.completionEvidence), task.id, expected.state, expected.updatedAt,
        );
        if (result.changes !== 1) return this.#store.exists("runtime_tasks", task.id) ? conflict("Task compare-and-set failed.") : notFound("Task was not found.");
        const linkResult = this.#store.syncIssueLink(task);
        if (linkResult.outcome !== "success") return linkResult;
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
        this.#store.database.prepare(`INSERT INTO runtime_attempts (id, schema_version, task_id, predecessor_attempt_id, ordinal, worker, provider, state, result, started_at, ended_at, branch, worktree, current_commit, final_commit, checkpoint_reference, progress, test_summary, blocking_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          attempt.id, 1, attempt.taskId, attempt.predecessorAttemptId ?? null, attempt.ordinal, attempt.worker, attempt.provider, attempt.state, attempt.state === "terminal" ? attempt.result : null,
          attempt.startedAt, attempt.state === "terminal" ? attempt.endedAt : null, attempt.branch ?? null, attempt.worktree ?? null, attempt.currentCommit ?? null,
          attempt.state === "terminal" ? attempt.finalCommit ?? null : null, attempt.checkpointReference ?? null, attempt.progress ?? null, attempt.testSummary ?? null, attempt.state === "terminal" ? attempt.blockingReason ?? null : null,
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

  public currentByTask(taskId: string): StorageResult<AttemptSnapshot> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_attempts WHERE task_id = ? AND state = 'running' ORDER BY ordinal DESC LIMIT 1").get(taskId) as AttemptRow | undefined;
        return row === undefined ? notFound("No running Attempt was found for the Task.") : attemptFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public recordProgress(attemptId: string, expected: { readonly state: "running"; readonly startedAt: string }, update: AttemptProgressUpdate, evaluatedAt: UtcTimestamp): StorageResult<AttemptSnapshot> {
    return this.#store.execute(() => {
      const current = this.get(attemptId);
      if (current.outcome !== "success") return current;
      if (current.value.state !== expected.state || current.value.startedAt !== expected.startedAt) return conflict("Attempt compare-and-set failed.");
      const next = recordAttemptProgress(current.value, expected.state, update, evaluatedAt);
      if (!next.ok) return { outcome: "invalid_record", message: next.error.message };
      return this.update(next.value, expected.state);
    });
  }

  public update(attempt: AttemptSnapshot, expectedState: AttemptState): StorageResult<AttemptSnapshot> {
    return this.#store.execute(() => {
      const validated = deserializeAttempt(serializeAttempt(attempt));
      if (!validated.ok) return invalidRecord();
      const current = this.get(attempt.id);
      if (current.outcome !== "success") return current;
      if (current.value.taskId !== attempt.taskId || current.value.predecessorAttemptId !== attempt.predecessorAttemptId || current.value.ordinal !== attempt.ordinal || current.value.worker !== attempt.worker || current.value.provider !== attempt.provider || current.value.startedAt !== attempt.startedAt) return conflict("Attempt identity, predecessor, and ordinal are immutable.");
      if (current.value.state === "terminal" && attempt.state === "terminal") return serializeAttempt(current.value) === serializeAttempt(validated.value) ? success(current.value) : conflict("Terminal Attempt completion conflicts with the stored result or evidence.");
      try {
        const result = this.#store.database.prepare(`UPDATE runtime_attempts SET state = ?, result = ?, ended_at = ?, branch = ?, worktree = ?, current_commit = ?, final_commit = ?, checkpoint_reference = ?, progress = ?, test_summary = ?, blocking_reason = ? WHERE id = ? AND state = ? AND task_id = ? AND ordinal = ? AND started_at = ? AND ((predecessor_attempt_id = ?) OR (predecessor_attempt_id IS NULL AND ? IS NULL))`).run(
          attempt.state, attempt.state === "terminal" ? attempt.result : null, attempt.state === "terminal" ? attempt.endedAt : null, attempt.branch ?? null, attempt.worktree ?? null, attempt.currentCommit ?? null,
          attempt.state === "terminal" ? attempt.finalCommit ?? null : null, attempt.checkpointReference ?? null, attempt.progress ?? null, attempt.testSummary ?? null, attempt.state === "terminal" ? attempt.blockingReason ?? null : null,
          attempt.id, expectedState, attempt.taskId, attempt.ordinal, attempt.startedAt, attempt.predecessorAttemptId ?? null, attempt.predecessorAttemptId ?? null,
        );
        if (result.changes !== 1) return this.#store.exists("runtime_attempts", attempt.id) ? conflict("Attempt compare-and-set failed.") : notFound("Attempt was not found.");
        return success(validated.value);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
}

interface StoredCheckpoint {
  readonly checkpoint: Checkpoint;
  readonly serialized: string;
  readonly contentHash: string;
  readonly sequence: number;
}

function checkpointFromRow(row: Record<string, unknown>): StorageResult<StoredCheckpoint> {
  if (typeof row.id !== "string" || typeof row.schema_version !== "number" || typeof row.task_id !== "string" || typeof row.previous_attempt_id !== "string" || typeof row.trigger !== "string" || typeof row.created_at !== "string" || typeof row.created_sequence !== "number" || typeof row.content_json !== "string" || typeof row.content_hash !== "string") return invalidRecord();
  const parsed = deserializeCheckpoint(row.content_json);
  if (!parsed.ok) return invalidRecord();
  const serialized = serializeCheckpoint(parsed.value);
  if (row.schema_version !== parsed.value.schemaVersion || row.id !== parsed.value.id || row.task_id !== parsed.value.taskId || row.previous_attempt_id !== parsed.value.previousAttemptId || row.trigger !== parsed.value.trigger || row.created_at !== parsed.value.createdAt || serialized !== row.content_json || checkpointHash(serialized) !== row.content_hash || checkpointHash(serialized).length !== 64 || !Number.isSafeInteger(row.created_sequence) || row.created_sequence <= 0) return invalidRecord();
  return success({ checkpoint: parsed.value, serialized, contentHash: row.content_hash, sequence: row.created_sequence });
}

export class CheckpointRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public save(checkpoint: Checkpoint): StorageResult<Checkpoint> {
    const validated = validateCheckpoint(checkpoint);
    if (!validated.ok) return invalidRecord();
    const canonical = validated.value;
    const serialized = serializeCheckpoint(canonical);
    const contentHash = checkpointHash(serialized);
    return this.#store.execute(() => {
      try {
        const existingRow = this.#store.database.prepare("SELECT * FROM runtime_checkpoints WHERE id = ?").get(canonical.id) as Record<string, unknown> | undefined;
        if (existingRow !== undefined) {
          const existing = checkpointFromRow(existingRow);
          if (existing.outcome !== "success") return existing;
          return existing.value.serialized === serialized && existing.value.contentHash === contentHash ? success(existing.value.checkpoint) : conflict("Checkpoint ID conflicts with different content.");
        }
        const task = this.#store.tasks.get(canonical.taskId);
        if (task.outcome !== "success") return task;
        const attempt = this.#store.attempts.get(canonical.previousAttemptId);
        if (attempt.outcome !== "success") return attempt;
        if (attempt.value.taskId !== canonical.taskId) return conflict("Checkpoint previous Attempt belongs to another Task.");
        const next = this.#store.database.prepare("SELECT COALESCE(MAX(created_sequence), 0) + 1 AS sequence FROM runtime_checkpoints").get() as { sequence: number };
        this.#store.database.prepare("INSERT INTO runtime_checkpoints (id, schema_version, task_id, previous_attempt_id, trigger, created_at, created_sequence, content_json, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(canonical.id, canonical.schemaVersion, canonical.taskId, canonical.previousAttemptId, canonical.trigger, canonical.createdAt, next.sequence, serialized, contentHash);
        return this.get(canonical.id);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public get(id: string): StorageResult<Checkpoint> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_checkpoints WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        if (row === undefined) return notFound("Checkpoint was not found.");
        const parsed = checkpointFromRow(row);
        if (parsed.outcome !== "success") return parsed;
        return this.verifyRelationship(parsed.value);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public latestByTask(taskId: string): StorageResult<Checkpoint> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_checkpoints WHERE task_id = ? ORDER BY created_sequence DESC, created_at DESC, id DESC LIMIT 1").get(taskId) as Record<string, unknown> | undefined;
        if (row === undefined) return notFound("No Checkpoint was found for the Task.");
        const parsed = checkpointFromRow(row);
        if (parsed.outcome !== "success") return parsed;
        return this.verifyRelationship(parsed.value);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public listByTask(taskId: string): StorageResult<readonly Checkpoint[]> {
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare("SELECT * FROM runtime_checkpoints WHERE task_id = ? ORDER BY created_sequence ASC, created_at ASC, id ASC").all(taskId) as Record<string, unknown>[];
        const values: Checkpoint[] = [];
        for (const row of rows) {
          const parsed = checkpointFromRow(row);
          if (parsed.outcome !== "success") return parsed;
          const verified = this.verifyRelationship(parsed.value);
          if (verified.outcome !== "success") return verified;
          values.push(verified.value);
        }
        return success(Object.freeze(values));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  private verifyRelationship(stored: StoredCheckpoint): StorageResult<Checkpoint> {
    const task = this.#store.database.prepare("SELECT id FROM runtime_tasks WHERE id = ?").get(stored.checkpoint.taskId) as { id: string } | undefined;
    const attempt = this.#store.database.prepare("SELECT task_id FROM runtime_attempts WHERE id = ?").get(stored.checkpoint.previousAttemptId) as { task_id: string } | undefined;
    if (task === undefined || attempt === undefined) return invalidRecord();
    if (attempt.task_id !== stored.checkpoint.taskId) return invalidRecord();
    return success(stored.checkpoint);
  }
}

function leaseFromRow(row: Record<string, unknown>): StorageResult<LeaseRecord> {
  try {
    if (typeof row.id !== "string" || typeof row.task_id !== "string" || typeof row.worker_id !== "string" || typeof row.acquired_at !== "string" || typeof row.renewed_at !== "string" || typeof row.expires_at !== "string" || typeof row.state !== "string" || typeof row.ownership_token !== "string" || typeof row.version !== "number" || !["active", "released", "recovered", "uncertain"].includes(row.state)) return invalidRecord();
    const state = row.state as LeaseState;
    const id = leaseId(row.id);
    const acquiredAt = leaseTimestamp(row.acquired_at);
    const renewedAt = leaseTimestamp(row.renewed_at);
    const expiresAt = leaseTimestamp(row.expires_at);
    const releasedAt = row.released_at === null || row.released_at === undefined ? undefined : leaseTimestamp(String(row.released_at));
    const recoveredAt = row.recovered_at === null || row.recovered_at === undefined ? undefined : leaseTimestamp(String(row.recovered_at));
    if (!Number.isSafeInteger(row.version) || row.version <= 0 || row.task_id.trim().length === 0 || row.worker_id.trim().length === 0 || row.ownership_token.trim().length === 0) return invalidRecord();
    if (state === "released" && typeof row.released_at !== "string") return invalidRecord();
    if (state === "recovered" && (typeof row.recovered_at !== "string" || !["expired", "uncertain"].includes(String(row.recovery_reason)))) return invalidRecord();
    if (state === "uncertain" && row.recovery_reason !== "uncertain") return invalidRecord();
    return success({
      id,
      taskId: row.task_id as TaskId,
      ...(row.attempt_id === null || row.attempt_id === undefined ? {} : { attemptId: row.attempt_id as AttemptId }),
      workerId: row.worker_id,
      acquiredAt,
      renewedAt,
      expiresAt,
      state,
      ownershipToken: row.ownership_token as LeaseOwnershipToken,
      version: row.version,
      ...(releasedAt === undefined ? {} : { releasedAt }),
      ...(recoveredAt === undefined ? {} : { recoveredAt }),
      ...(row.recovery_reason === null || row.recovery_reason === undefined ? {} : { recoveryReason: row.recovery_reason as LeaseRecoveryReason }),
    });
  } catch {
    return invalidRecord();
  }
}

function leaseInputError(input: LeaseAcquireInput): string | undefined {
  try {
    leaseId(input.id);
    leaseTimestamp(input.now);
    leaseDuration(input.durationMs);
    leaseWorkerId(input.workerId);
    if (typeof input.taskId !== "string" || input.taskId.trim().length === 0) return "Task ID is invalid.";
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : "Lease input is invalid.";
  }
}

function leaseOperationInput(leaseIdValue: string, token: string, expectedVersion: number, now: string): string | undefined {
  try {
    leaseId(leaseIdValue);
    leaseTimestamp(now);
    if (typeof token !== "string" || token.trim().length === 0 || !Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) return "Lease ownership token or version is invalid.";
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : "Lease operation input is invalid.";
  }
}

export class LeaseRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public acquire(input: LeaseAcquireInput): StorageResult<LeaseRecord> {
    const inputError = leaseInputError(input);
    if (inputError !== undefined) return { outcome: "invalid_record", message: inputError };
    const expiresAt = leaseExpiresAt(input.now, input.durationMs);
    const token = randomUUID() as LeaseOwnershipToken;
    return this.#store.execute(() => {
      try {
        const task = this.#store.database.prepare("SELECT state FROM runtime_tasks WHERE id = ?").get(input.taskId) as { state: string } | undefined;
        if (task === undefined) return notFound("Task was not found.");
        if (task.state !== "ready" && task.state !== "in_progress") return conflict("Task is not eligible for a Lease in its current state.");
        const taskLease = this.#store.database.prepare("SELECT id FROM runtime_leases WHERE task_id = ? AND state = 'active'").get(input.taskId);
        if (taskLease !== undefined) return conflict("Task already has an active Lease.");
        const globalLease = this.#store.database.prepare("SELECT id FROM runtime_leases WHERE state = 'active' LIMIT 1").get();
        if (globalLease !== undefined) return conflict("The single-worker Lease slot is occupied.");
        this.#store.database.prepare("INSERT INTO runtime_leases (id, task_id, attempt_id, worker_id, acquired_at, renewed_at, expires_at, state, ownership_token, version, released_at, recovered_at, recovery_reason) VALUES (?, ?, NULL, ?, ?, ?, ?, 'active', ?, 1, NULL, NULL, NULL)").run(input.id, input.taskId, leaseWorkerId(input.workerId), input.now, input.now, expiresAt, token);
        return this.get(input.id);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public get(id: string): StorageResult<LeaseRecord> {
    try { leaseId(id); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Lease ID is invalid." }; }
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_leases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("Lease was not found.") : leaseFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public getActiveByTask(taskId: string): StorageResult<LeaseRecord> {
    return this.#getActive("task_id", taskId, "No active Lease was found for the Task.");
  }

  public getActiveByWorker(workerId: string): StorageResult<LeaseRecord> {
    return this.#getActive("worker_id", workerId, "No active Lease was found for the worker.");
  }

  public listRecoverable(now: UtcTimestamp): StorageResult<readonly LeaseRecord[]> {
    try { leaseTimestamp(now); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Lease timestamp is invalid." }; }
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare("SELECT * FROM runtime_leases WHERE state = 'uncertain' OR (state = 'active' AND expires_at <= ?) ORDER BY expires_at, id").all(now) as Record<string, unknown>[];
        const values: LeaseRecord[] = [];
        for (const row of rows) { const parsed = leaseFromRow(row); if (parsed.outcome !== "success") return parsed; values.push(parsed.value); }
        return success(Object.freeze(values));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public attachAttempt(id: string, token: string, expectedVersion: number, attemptId: string, now: UtcTimestamp): StorageResult<LeaseRecord> {
    const inputError = leaseOperationInput(id, token, expectedVersion, now);
    if (inputError !== undefined || typeof attemptId !== "string" || attemptId.trim().length === 0) return { outcome: "invalid_record", message: inputError ?? "Attempt ID is invalid." };
    return this.#store.execute(() => {
      const current = this.get(id);
      if (current.outcome !== "success") return current;
      const ownership = this.#checkActive(current.value, token, expectedVersion, now);
      if (ownership !== undefined) return ownership;
      const attempt = this.#store.database.prepare("SELECT task_id, state FROM runtime_attempts WHERE id = ?").get(attemptId) as { task_id: string; state: string } | undefined;
      if (attempt === undefined) return notFound("Attempt was not found.");
      if (attempt.task_id !== current.value.taskId) return conflict("Attempt belongs to another Task.");
      if (attempt.state !== "running") return conflict("Only a running Attempt can be attached to a Lease.");
      try {
        const updated = this.#store.database.prepare("UPDATE runtime_leases SET attempt_id = ?, renewed_at = ?, version = version + 1 WHERE id = ? AND state = 'active' AND ownership_token = ? AND version = ?").run(attemptId, now, id, token, expectedVersion);
        if (updated.changes !== 1) return conflict("Lease compare-and-set failed.");
        return this.get(id);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public renew(id: string, token: string, expectedVersion: number, now: UtcTimestamp, durationMs: number): StorageResult<LeaseRecord> {
    const inputError = leaseOperationInput(id, token, expectedVersion, now);
    if (inputError !== undefined) return { outcome: "invalid_record", message: inputError };
    try { leaseDuration(durationMs); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Lease duration is invalid." }; }
    const expiresAt = leaseExpiresAt(now, durationMs);
    return this.#store.execute(() => {
      const current = this.get(id);
      if (current.outcome !== "success") return current;
      const ownership = this.#checkActive(current.value, token, expectedVersion, now);
      if (ownership !== undefined) return ownership;
      try {
        const updated = this.#store.database.prepare("UPDATE runtime_leases SET renewed_at = ?, expires_at = ?, version = version + 1 WHERE id = ? AND state = 'active' AND ownership_token = ? AND version = ?").run(now, expiresAt, id, token, expectedVersion);
        if (updated.changes !== 1) return conflict("Lease compare-and-set failed.");
        return this.get(id);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public release(id: string, token: string, expectedVersion: number, now: UtcTimestamp): StorageResult<LeaseRecord> {
    const inputError = leaseOperationInput(id, token, expectedVersion, now);
    if (inputError !== undefined) return { outcome: "invalid_record", message: inputError };
    return this.#store.execute(() => {
      const current = this.get(id);
      if (current.outcome !== "success") return current;
      const ownership = this.#checkActive(current.value, token, expectedVersion, now);
      if (ownership !== undefined) return ownership;
      try {
        const updated = this.#store.database.prepare("UPDATE runtime_leases SET state = 'released', released_at = ?, renewed_at = ?, version = version + 1 WHERE id = ? AND state = 'active' AND ownership_token = ? AND version = ?").run(now, now, id, token, expectedVersion);
        if (updated.changes !== 1) return conflict("Lease compare-and-set failed.");
        return this.get(id);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public markUncertain(id: string, token: string, expectedVersion: number, now: UtcTimestamp): StorageResult<LeaseRecord> {
    const inputError = leaseOperationInput(id, token, expectedVersion, now);
    if (inputError !== undefined) return { outcome: "invalid_record", message: inputError };
    return this.#store.execute(() => {
      const current = this.get(id);
      if (current.outcome !== "success") return current;
      const ownership = this.#checkActive(current.value, token, expectedVersion, now);
      if (ownership !== undefined) return ownership;
      try {
        const updated = this.#store.database.prepare("UPDATE runtime_leases SET state = 'uncertain', recovery_reason = 'uncertain', renewed_at = ?, version = version + 1 WHERE id = ? AND state = 'active' AND ownership_token = ? AND version = ?").run(now, id, token, expectedVersion);
        if (updated.changes !== 1) return conflict("Lease compare-and-set failed.");
        return this.get(id);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public recover(id: string, token: string, expectedVersion: number, now: UtcTimestamp): StorageResult<LeaseRecord> {
    const inputError = leaseOperationInput(id, token, expectedVersion, now);
    if (inputError !== undefined) return { outcome: "invalid_record", message: inputError };
    return this.#store.execute(() => {
      const current = this.get(id);
      if (current.outcome !== "success") return current;
      if (current.value.ownershipToken !== token || current.value.version !== expectedVersion) return conflict("Lease ownership token or version is stale.");
      const reason: LeaseRecoveryReason | undefined = current.value.state === "uncertain" ? "uncertain" : current.value.state === "active" && leaseIsExpired(current.value, now) ? "expired" : undefined;
      if (reason === undefined) return current.value.state === "active" ? conflict("Lease is still active and has not reached its expiry boundary.") : conflict("Lease is not recoverable in its current state.");
      try {
        const updated = this.#store.database.prepare("UPDATE runtime_leases SET state = 'recovered', recovered_at = ?, recovery_reason = ?, version = version + 1 WHERE id = ? AND state IN ('active', 'uncertain') AND ownership_token = ? AND version = ?").run(now, reason, id, token, expectedVersion);
        if (updated.changes !== 1) return conflict("Lease compare-and-set failed.");
        return this.get(id);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  #getActive(field: "task_id" | "worker_id", value: string, missingMessage: string): StorageResult<LeaseRecord> {
    if (typeof value !== "string" || value.trim().length === 0) return { outcome: "invalid_record", message: "Lease lookup value is invalid." };
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare(`SELECT * FROM runtime_leases WHERE ${field} = ? AND state = 'active' ORDER BY acquired_at, id LIMIT 1`).get(value) as Record<string, unknown> | undefined;
        return row === undefined ? notFound(missingMessage) : leaseFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  #checkActive(current: LeaseRecord, token: string, expectedVersion: number, now: UtcTimestamp): StorageResult<LeaseRecord> | undefined {
    if (current.state !== "active") return conflict("Lease is not active; recover or inspect its terminal outcome.");
    if (current.ownershipToken !== token || current.version !== expectedVersion) return conflict("Lease ownership token or version is stale.");
    if (leaseIsExpired(current, now)) return conflict("Lease is expired and must be recovered.");
    return undefined;
  }
}

export class ProjectionRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public get(eventId: string): StorageResult<RuntimeProjectionRecord> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_github_projections WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("GitHub projection event was not found.") : this.#fromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public prepare(input: RuntimeProjectionInput, now: string): StorageResult<RuntimeProjectionRecord> {
    return this.#store.execute(() => {
      try {
        const existing = this.#store.database.prepare("SELECT * FROM runtime_github_projections WHERE event_id = ?").get(input.eventId) as Record<string, unknown> | undefined;
        if (existing !== undefined) {
          const current = this.#fromRow(existing);
          if (current.outcome !== "success") return current;
          if (current.value.taskId !== input.taskId || current.value.attemptId !== input.attemptId || current.value.sequence !== input.sequence || current.value.eventType !== input.eventType || current.value.timestamp !== input.timestamp || current.value.summary !== input.summary || current.value.branch !== input.branch || current.value.commit !== input.commit) return conflict("Projection event identity conflicts with the stored event.");
          if (current.value.status === "pending") {
            const latest = this.#store.database.prepare("SELECT MAX(sequence) AS sequence FROM runtime_github_projections WHERE task_id = ? AND status = 'published'").get(input.taskId) as { sequence: number | null };
            if (latest.sequence !== null && latest.sequence >= input.sequence) {
              this.#store.database.prepare("UPDATE runtime_github_projections SET status = 'ignored', last_error = ?, updated_at = ? WHERE event_id = ? AND status = 'pending'").run("Out-of-order event superseded by a later published event.", now, input.eventId);
              return this.get(input.eventId);
            }
          }
          return current;
        }
        const latest = this.#store.database.prepare("SELECT MAX(sequence) AS sequence FROM runtime_github_projections WHERE task_id = ? AND status = 'published'").get(input.taskId) as { sequence: number | null };
        const status: RuntimeProjectionStatus = latest.sequence !== null && latest.sequence >= input.sequence ? "ignored" : "pending";
        this.#store.database.prepare("INSERT INTO runtime_github_projections (event_id, task_id, attempt_id, sequence, event_type, timestamp, summary, branch, commit_sha, status, comment_id, comment_url, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)").run(input.eventId, input.taskId, input.attemptId ?? null, input.sequence, input.eventType, input.timestamp, input.summary, input.branch ?? null, input.commit ?? null, status, now, now);
        return this.get(input.eventId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public markPublished(eventId: string, comment: ProjectionCommentReference, now: string): StorageResult<RuntimeProjectionRecord> {
    return this.#store.execute(() => {
      try {
        const result = this.#store.database.prepare("UPDATE runtime_github_projections SET status = 'published', comment_id = ?, comment_url = ?, last_error = NULL, updated_at = ? WHERE event_id = ? AND status = 'pending'").run(comment.id, comment.url, now, eventId);
        if (result.changes === 0) return this.get(eventId);
        return this.get(eventId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public markPending(eventId: string, message: string, now: string): StorageResult<RuntimeProjectionRecord> {
    return this.#store.execute(() => {
      try {
        const result = this.#store.database.prepare("UPDATE runtime_github_projections SET status = 'pending', last_error = ?, updated_at = ? WHERE event_id = ? AND status = 'pending'").run(message.slice(0, 500), now, eventId);
        if (result.changes === 0) return this.get(eventId);
        return this.get(eventId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public listPending(): StorageResult<readonly RuntimeProjectionRecord[]> {
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare("SELECT * FROM runtime_github_projections WHERE status = 'pending' ORDER BY task_id, sequence").all() as Record<string, unknown>[];
        const values: RuntimeProjectionRecord[] = [];
        for (const row of rows) { const parsed = this.#fromRow(row); if (parsed.outcome !== "success") return parsed; values.push(parsed.value); }
        return success(Object.freeze(values));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  #fromRow(row: Record<string, unknown>): StorageResult<RuntimeProjectionRecord> {
    if (typeof row.event_id !== "string" || typeof row.task_id !== "string" || typeof row.sequence !== "number" || typeof row.event_type !== "string" || typeof row.timestamp !== "string" || typeof row.summary !== "string" || typeof row.status !== "string" || !["pending", "published", "ignored"].includes(row.status) || typeof row.updated_at !== "string") return invalidRecord();
    return success({
      eventId: row.event_id, taskId: row.task_id, ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id as string }), sequence: row.sequence,
      eventType: row.event_type, timestamp: row.timestamp, summary: row.summary, ...(row.branch === null ? {} : { branch: row.branch as string }), ...(row.commit_sha === null ? {} : { commit: row.commit_sha as string }), status: row.status as RuntimeProjectionStatus,
      ...(row.comment_id === null ? {} : { commentId: row.comment_id as number }), ...(row.comment_url === null ? {} : { commentUrl: row.comment_url as string }), ...(row.last_error === null ? {} : { lastError: row.last_error as string }), updatedAt: row.updated_at,
    });
  }
}

export class WebhookRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public getDelivery(deliveryId: string): StorageResult<RuntimeWebhookDelivery> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_webhook_deliveries WHERE delivery_id = ?").get(deliveryId) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("Webhook delivery was not found.") : this.#deliveryFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public accept(delivery: RuntimeWebhookDelivery, intents: readonly RuntimeSyncIntentInput[]): StorageResult<RuntimeWebhookAcceptance> {
    return this.#store.execute(() => {
      try {
        const existing = this.#store.database.prepare("SELECT * FROM runtime_webhook_deliveries WHERE delivery_id = ?").get(delivery.deliveryId) as Record<string, unknown> | undefined;
        if (existing !== undefined) {
          const stored = this.#deliveryFromRow(existing);
          if (stored.outcome !== "success") return stored;
          if (stored.value.payloadDigest !== delivery.payloadDigest || stored.value.eventName !== delivery.eventName || stored.value.action !== delivery.action) return conflict("GitHub delivery ID was reused with different content.");
          return success({ duplicate: true, delivery: stored.value, intents: this.#listDeliveryIntents(delivery.deliveryId) });
        }
        this.#store.database.prepare("INSERT INTO runtime_webhook_deliveries (delivery_id, event_name, action, payload_digest, status, received_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(delivery.deliveryId, delivery.eventName, delivery.action, delivery.payloadDigest, delivery.status, delivery.receivedAt, delivery.createdAt, delivery.updatedAt);
        for (const intent of intents) {
          this.#store.database.prepare("INSERT INTO runtime_sync_intents (intent_id, delivery_id, kind, owner, repository, issue_number, issue_node_id, project_id, project_item_id, event_name, action, event_timestamp, status, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)").run(intent.intentId, intent.deliveryId, intent.kind, intent.owner ?? null, intent.repository ?? null, intent.issueNumber ?? null, intent.issueNodeId ?? null, intent.projectId ?? null, intent.projectItemId ?? null, intent.eventName, intent.action, intent.eventTimestamp, intent.eventTimestamp, intent.eventTimestamp);
        }
        const stored = this.#deliveryFromRow(this.#store.database.prepare("SELECT * FROM runtime_webhook_deliveries WHERE delivery_id = ?").get(delivery.deliveryId) as Record<string, unknown>);
        if (stored.outcome !== "success") return stored;
        return success({ duplicate: false, delivery: stored.value, intents: this.#listDeliveryIntents(delivery.deliveryId) });
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public getIntent(intentId: string): StorageResult<RuntimeSyncIntent> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_sync_intents WHERE intent_id = ?").get(intentId) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("Synchronization intent was not found.") : this.#intentFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public listPendingIntents(): StorageResult<readonly RuntimeSyncIntent[]> {
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare("SELECT * FROM runtime_sync_intents WHERE status = 'pending' ORDER BY created_at, intent_id").all() as Record<string, unknown>[];
        const values: RuntimeSyncIntent[] = [];
        for (const row of rows) { const parsed = this.#intentFromRow(row); if (parsed.outcome !== "success") return parsed; values.push(parsed.value); }
        return success(Object.freeze(values));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public markReconciled(intentId: string, updatedAt: string): StorageResult<RuntimeSyncIntent> {
    return this.#store.execute(() => {
      try {
        this.#store.database.prepare("UPDATE runtime_sync_intents SET status = 'reconciled', last_error = NULL, updated_at = ? WHERE intent_id = ? AND status = 'pending'").run(updatedAt, intentId);
        return this.getIntent(intentId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public markPending(intentId: string, message: string, updatedAt: string): StorageResult<RuntimeSyncIntent> {
    return this.#store.execute(() => {
      try {
        this.#store.database.prepare("UPDATE runtime_sync_intents SET status = 'pending', last_error = ?, updated_at = ? WHERE intent_id = ?").run(message.slice(0, 500), updatedAt, intentId);
        return this.getIntent(intentId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  #listDeliveryIntents(deliveryId: string): readonly RuntimeSyncIntent[] {
    const rows = this.#store.database.prepare("SELECT * FROM runtime_sync_intents WHERE delivery_id = ? ORDER BY intent_id").all(deliveryId) as Record<string, unknown>[];
    const values: RuntimeSyncIntent[] = [];
    for (const row of rows) { const parsed = this.#intentFromRow(row); if (parsed.outcome === "success") values.push(parsed.value); }
    return Object.freeze(values);
  }

  #deliveryFromRow(row: Record<string, unknown>): StorageResult<RuntimeWebhookDelivery> {
    if (typeof row.delivery_id !== "string" || typeof row.event_name !== "string" || typeof row.action !== "string" || typeof row.payload_digest !== "string" || !["accepted", "ignored"].includes(String(row.status)) || typeof row.received_at !== "string" || typeof row.created_at !== "string" || typeof row.updated_at !== "string") return invalidRecord();
    return success({ deliveryId: row.delivery_id, eventName: row.event_name, action: row.action, payloadDigest: row.payload_digest, status: row.status as RuntimeWebhookDeliveryStatus, receivedAt: row.received_at, createdAt: row.created_at, updatedAt: row.updated_at });
  }

  #intentFromRow(row: Record<string, unknown>): StorageResult<RuntimeSyncIntent> {
    const kinds: readonly RuntimeSyncIntentKind[] = ["issue", "issue_relationship", "project", "repository"];
    const statuses: readonly RuntimeSyncIntentStatus[] = ["pending", "reconciled"];
    if (typeof row.intent_id !== "string" || typeof row.delivery_id !== "string" || typeof row.kind !== "string" || !kinds.includes(row.kind as RuntimeSyncIntentKind) || typeof row.event_name !== "string" || typeof row.action !== "string" || typeof row.event_timestamp !== "string" || typeof row.status !== "string" || !statuses.includes(row.status as RuntimeSyncIntentStatus) || typeof row.created_at !== "string" || typeof row.updated_at !== "string") return invalidRecord();
    return success({ intentId: row.intent_id, deliveryId: row.delivery_id, kind: row.kind as RuntimeSyncIntentKind, ...(row.owner === null ? {} : { owner: row.owner as string }), ...(row.repository === null ? {} : { repository: row.repository as string }), ...(row.issue_number === null ? {} : { issueNumber: row.issue_number as number }), ...(row.issue_node_id === null ? {} : { issueNodeId: row.issue_node_id as string }), ...(row.project_id === null ? {} : { projectId: row.project_id as string }), ...(row.project_item_id === null ? {} : { projectItemId: row.project_item_id as string }), eventName: row.event_name, action: row.action, eventTimestamp: row.event_timestamp, status: row.status as RuntimeSyncIntentStatus, ...(row.last_error === null ? {} : { lastError: row.last_error as string }), createdAt: row.created_at, updatedAt: row.updated_at });
  }
}

export class RuntimeSqliteStore {
  readonly #database: DatabaseSync;
  readonly #filename: string;
  #closed = false;
  #inTransaction = false;
  readonly tasks: TaskRepository;
  readonly attempts: AttemptRepository;
  readonly checkpoints: CheckpointRepository;
  readonly leases: LeaseRepository;
  readonly projections: ProjectionRepository;
  readonly webhooks: WebhookRepository;

  private constructor(database: DatabaseSync, filename: string) {
    this.#database = database;
    this.#filename = filename;
    this.tasks = new TaskRepository(this);
    this.attempts = new AttemptRepository(this);
    this.checkpoints = new CheckpointRepository(this);
    this.leases = new LeaseRepository(this);
    this.projections = new ProjectionRepository(this);
    this.webhooks = new WebhookRepository(this);
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

  public startAttempt(taskId: string, input: StartAttemptInput, evaluatedAt: UtcTimestamp): StorageResult<StartedAttempt | RetriedTask> {
    return this.transaction(({ tasks, attempts }) => {
      const task = tasks.get(taskId);
      if (task.outcome !== "success") return task;
      const history = attempts.listByTask(taskId);
      if (history.outcome !== "success") return history;
      const started = task.value.state === "ready"
        ? startInitialAttempt(task.value, history.value, input, evaluatedAt)
        : retryTask(task.value, history.value, input, evaluatedAt);
      if (!started.ok) {
        const recoverable = started.error.code === "invalid_transition" || started.error.code === "invariant_violation";
        return { outcome: recoverable ? "conflict" as const : "invalid_record" as const, message: started.error.message };
      }
      const taskUpdate = tasks.update(started.value.task, { state: task.value.state, updatedAt: task.value.updatedAt });
      if (taskUpdate.outcome !== "success") return taskUpdate;
      const attempt = attempts.create(started.value.attempt);
      if (attempt.outcome !== "success") return attempt;
      return success(started.value);
    });
  }

  public transaction<T>(operation: (transaction: RuntimeTransaction) => StorageResult<T>): StorageResult<T> {
    if (this.#inTransaction) {
      try { return operation({ tasks: this.tasks, attempts: this.attempts, checkpoints: this.checkpoints, leases: this.leases, projections: this.projections, webhooks: this.webhooks }); }
      catch { return storageFailure(); }
    }
    try {
      this.assertOpen();
      this.#database.exec("BEGIN IMMEDIATE");
      this.#inTransaction = true;
      const result = operation({ tasks: this.tasks, attempts: this.attempts, checkpoints: this.checkpoints, leases: this.leases, projections: this.projections, webhooks: this.webhooks });
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

  public syncIssueLink(task: TaskSnapshot): StorageResult<void> {
    const reference = task.githubReference;
    try {
      if (reference?.nodeId === undefined || reference.url === undefined) {
        this.#database.prepare("DELETE FROM runtime_task_issue_links WHERE task_id = ?").run(task.id);
        return success(undefined);
      }
      const identity: CanonicalIssueIdentity = { owner: reference.owner, repository: reference.repository, issueNumber: reference.issueNumber, nodeId: reference.nodeId, url: reference.url };
      if (!validCanonicalIdentity(identity)) return { outcome: "invalid_record", message: "Canonical GitHub Issue identity is invalid." };
      this.#database.prepare("INSERT INTO runtime_task_issue_links (task_id, owner, repository, issue_number, node_id, url, linked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET owner = excluded.owner, repository = excluded.repository, issue_number = excluded.issue_number, node_id = excluded.node_id, url = excluded.url, updated_at = excluded.updated_at").run(task.id, identity.owner, identity.repository, identity.issueNumber, identity.nodeId, identity.url, task.createdAt, task.updatedAt);
      return success(undefined);
    } catch (error: unknown) { return classifyStorageError(error); }
  }

  private assertOpen(): void {
    if (this.#closed) throw new RuntimeStorageError("storage_error", "SQLite runtime storage is closed.");
  }
}
