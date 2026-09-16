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
import {
  cooldownIsActive,
  missingWorkerCapabilities,
  normalizeWorkerCapabilities,
  validateTaskSelectionMetadata,
  type TaskEligibilityExplanation,
  type RunnableTaskCandidate,
  type TaskSelectionMetadata,
  type TaskSelectionMetadataInput,
  type TaskSelectionRequest,
  type TaskSelectionResult,
} from "./task-selection.js";
import {
  releaseId,
  releaseText,
  releaseTimestamp,
  validateReleaseInput,
  validateReleaseTaskInput,
  validatePullRequest,
  validateTransition,
  RELEASE_TRANSITIONS,
  type ReleaseInput,
  type ReleaseId,
  type ReleasePullRequestIdentity,
  type ReleaseRecord,
  type ReleaseRecoveryRecord,
  type ReleaseState,
  type ReleaseTaskInput,
  type ReleaseTaskRecord,
  type ReleaseTransitionInput,
} from "./release.js";
import {
  normalizeWorkspaceOwnershipInput,
  validateWorkspaceOwnershipRecord,
  workspaceOwnershipId,
  workspaceOwnershipMatches,
  workspaceOwnershipRevision,
  workspaceOwnershipTimestamp,
  type WorkspaceOwnershipInput,
  type WorkspaceOwnershipRecord,
  type WorkspaceOwnershipTransferInput,
} from "./workspace-ownership.js";
import type { CiCorrelationInput, CiCorrelationObservation, CiCorrelationRecord, CiCorrelationState } from "./ci-correlation.js";
import type { CiFailureEvidenceRecord } from "./ci-evidence.js";
import type { FeatureMergeRecord } from "./feature-merge.js";
import type { ShipmentCycleRecord, ShipmentCycleState, ShipmentOutcome } from "./shipment-coordinator.js";

export const RUNTIME_STORAGE_SCHEMA_VERSION = 20 as const;
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
  readonly selection: TaskSelectionRepository;
  readonly releases: ReleaseRepository;
  readonly projections: ProjectionRepository;
  readonly webhooks: WebhookRepository;
  readonly workspaces: WorkspaceOwnershipRepository;
  readonly pullRequests: PullRequestProvenanceRepository;
  readonly ciCorrelations: CiCorrelationRepository;
  readonly ciEvidence: CiFailureEvidenceRepository;
  readonly featureMerges: FeatureMergeRepository;
  readonly shipmentCycles: ShipmentCycleRepository;
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
  `
    CREATE TABLE IF NOT EXISTS runtime_task_selection (
      task_id TEXT PRIMARY KEY REFERENCES runtime_tasks(id) ON DELETE CASCADE,
      queue_order INTEGER CHECK (queue_order IS NULL OR queue_order > 0),
      cooldown_until TEXT,
      dependency_state TEXT NOT NULL CHECK (dependency_state IN ('known', 'unknown')),
      synchronized_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_task_blockers (
      task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE CASCADE,
      prerequisite_task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT,
      PRIMARY KEY (task_id, prerequisite_task_id),
      CHECK (task_id <> prerequisite_task_id)
    );
    CREATE INDEX IF NOT EXISTS runtime_task_selection_queue
      ON runtime_task_selection (queue_order, task_id);
    CREATE INDEX IF NOT EXISTS runtime_task_blockers_task
      ON runtime_task_blockers (task_id, prerequisite_task_id);
  `,
  `
    CREATE TABLE IF NOT EXISTS runtime_releases (
      id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      repository TEXT NOT NULL CHECK (length(trim(repository)) > 0),
      source_branch TEXT NOT NULL CHECK (length(trim(source_branch)) > 0),
      base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0),
      state TEXT NOT NULL CHECK (state IN ('collecting', 'validating', 'ready_to_merge', 'merging', 'deploying', 'production_verification', 'deployed', 'failed', 'blocked', 'human_action_required', 'rolled_back')),
      version INTEGER NOT NULL CHECK (version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      release_pr_node_id TEXT,
      release_pr_number INTEGER CHECK (release_pr_number IS NULL OR release_pr_number > 0),
      release_pr_url TEXT,
      merge_revision TEXT,
      deployment_provider_id TEXT,
      production_version TEXT,
      failure_reason TEXT,
      CHECK ((release_pr_node_id IS NULL AND release_pr_number IS NULL AND release_pr_url IS NULL) OR (release_pr_node_id IS NOT NULL AND release_pr_number IS NOT NULL AND release_pr_url IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS runtime_release_tasks (
      release_id TEXT NOT NULL REFERENCES runtime_releases(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT,
      attempt_id TEXT NOT NULL REFERENCES runtime_attempts(id) ON DELETE RESTRICT,
      selected_revision TEXT NOT NULL CHECK (length(trim(selected_revision)) > 0),
      feature_pr_node_id TEXT,
      feature_pr_number INTEGER CHECK (feature_pr_number IS NULL OR feature_pr_number > 0),
      feature_pr_url TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (release_id, task_id),
      UNIQUE (release_id, attempt_id),
      CHECK ((feature_pr_node_id IS NULL AND feature_pr_number IS NULL AND feature_pr_url IS NULL) OR (feature_pr_node_id IS NOT NULL AND feature_pr_number IS NOT NULL AND feature_pr_url IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS runtime_release_tasks_task_attempt
      ON runtime_release_tasks (task_id, attempt_id, release_id);
    CREATE INDEX IF NOT EXISTS runtime_releases_recovery
      ON runtime_releases (state, updated_at, id);
  `,
  `
    CREATE TABLE IF NOT EXISTS runtime_workspace_ownership (
      task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT,
      attempt_id TEXT PRIMARY KEY REFERENCES runtime_attempts(id) ON DELETE RESTRICT,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      repository_identity TEXT NOT NULL CHECK (length(trim(repository_identity)) > 0),
      repository_root TEXT NOT NULL CHECK (length(trim(repository_root)) > 0),
      assigned_branch TEXT NOT NULL CHECK (length(trim(assigned_branch)) > 0),
      worktree_path TEXT NOT NULL CHECK (length(trim(worktree_path)) > 0),
      expected_base_revision TEXT NOT NULL CHECK (length(trim(expected_base_revision)) BETWEEN 4 AND 64),
      current_revision TEXT NOT NULL CHECK (length(trim(current_revision)) BETWEEN 4 AND 64),
      ownership_state TEXT NOT NULL CHECK (ownership_state IN ('active', 'released')),
      acquired_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      released_at TEXT,
      ownership_token TEXT NOT NULL UNIQUE CHECK (length(trim(ownership_token)) > 0),
      version INTEGER NOT NULL CHECK (version > 0),
      CHECK ((ownership_state = 'active' AND released_at IS NULL) OR (ownership_state = 'released' AND released_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_workspace_active_worktree
      ON runtime_workspace_ownership (worktree_path) WHERE ownership_state = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_workspace_active_branch
      ON runtime_workspace_ownership (repository_identity, assigned_branch) WHERE ownership_state = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_workspace_active_task
      ON runtime_workspace_ownership (task_id) WHERE ownership_state = 'active';
    CREATE INDEX IF NOT EXISTS runtime_workspace_repository_lookup
      ON runtime_workspace_ownership (repository_identity, assigned_branch, worktree_path, ownership_state);
    CREATE INDEX IF NOT EXISTS runtime_workspace_recovery
      ON runtime_workspace_ownership (ownership_state, updated_at, attempt_id);
  `,
  "CREATE TABLE IF NOT EXISTS runtime_pull_request_provenance (task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT, attempt_id TEXT PRIMARY KEY REFERENCES runtime_attempts(id) ON DELETE RESTRICT, repository TEXT NOT NULL CHECK (length(trim(repository)) > 0), issue_number INTEGER NOT NULL CHECK (issue_number > 0), issue_node_id TEXT NOT NULL CHECK (length(trim(issue_node_id)) > 0), issue_url TEXT NOT NULL CHECK (length(trim(issue_url)) > 0), worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0), head_branch TEXT NOT NULL CHECK (length(trim(head_branch)) > 0), base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0), observed_head_sha TEXT NOT NULL CHECK (length(trim(observed_head_sha)) > 0), pull_request_node_id TEXT NOT NULL UNIQUE CHECK (length(trim(pull_request_node_id)) > 0), pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0), pull_request_url TEXT NOT NULL CHECK (length(trim(pull_request_url)) > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (task_id, attempt_id), UNIQUE (repository, pull_request_number)); CREATE INDEX IF NOT EXISTS runtime_pull_request_provenance_task_attempt ON runtime_pull_request_provenance (task_id, attempt_id); CREATE INDEX IF NOT EXISTS runtime_pull_request_provenance_pull ON runtime_pull_request_provenance (repository, pull_request_number);",
  "CREATE TABLE IF NOT EXISTS runtime_ci_correlations (task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT, attempt_id TEXT PRIMARY KEY REFERENCES runtime_attempts(id) ON DELETE RESTRICT, schema_version INTEGER NOT NULL CHECK (schema_version = 1), repository TEXT NOT NULL CHECK (length(trim(repository)) > 0), issue_number INTEGER NOT NULL CHECK (issue_number > 0), issue_node_id TEXT NOT NULL CHECK (length(trim(issue_node_id)) > 0), issue_url TEXT NOT NULL CHECK (length(trim(issue_url)) > 0), feature_pr_node_id TEXT NOT NULL CHECK (length(trim(feature_pr_node_id)) > 0), feature_pr_number INTEGER NOT NULL CHECK (feature_pr_number > 0), feature_pr_url TEXT NOT NULL CHECK (length(trim(feature_pr_url)) > 0), worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0), head_branch TEXT NOT NULL CHECK (length(trim(head_branch)) > 0), base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0), pushed_commit TEXT NOT NULL CHECK (length(trim(pushed_commit)) > 0), provider TEXT NOT NULL CHECK (length(trim(provider)) > 0), required_workflow_name TEXT NOT NULL CHECK (length(trim(required_workflow_name)) > 0), provider_run_id TEXT, provider_run_url TEXT, workflow_name TEXT, provider_pipeline_id TEXT, tested_revision TEXT, state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'failed', 'cancelled', 'timed_out', 'not_found', 'ambiguous', 'stale', 'rate_limited', 'retryable', 'permanent', 'unknown', 'unavailable')), observed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0), UNIQUE (repository, feature_pr_number), UNIQUE (provider, provider_run_id)); CREATE INDEX IF NOT EXISTS runtime_ci_correlations_task_attempt ON runtime_ci_correlations (task_id, attempt_id); CREATE INDEX IF NOT EXISTS runtime_ci_correlations_commit ON runtime_ci_correlations (repository, pushed_commit); CREATE INDEX IF NOT EXISTS runtime_ci_correlations_provider_run ON runtime_ci_correlations (provider, provider_run_id);",
  "CREATE TABLE IF NOT EXISTS runtime_ci_evidence (task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT, attempt_id TEXT PRIMARY KEY REFERENCES runtime_attempts(id) ON DELETE RESTRICT, schema_version INTEGER NOT NULL CHECK (schema_version = 1), repository TEXT NOT NULL CHECK (length(trim(repository)) > 0), issue_number INTEGER NOT NULL CHECK (issue_number > 0), feature_pr_number INTEGER NOT NULL CHECK (feature_pr_number > 0), feature_pr_url TEXT NOT NULL CHECK (length(trim(feature_pr_url)) > 0), head_branch TEXT NOT NULL CHECK (length(trim(head_branch)) > 0), pushed_commit TEXT NOT NULL CHECK (length(trim(pushed_commit)) > 0), provider TEXT NOT NULL CHECK (length(trim(provider)) > 0), provider_run_id TEXT NOT NULL CHECK (length(trim(provider_run_id)) > 0), provider_run_url TEXT NOT NULL CHECK (length(trim(provider_run_url)) > 0), workflow_name TEXT NOT NULL CHECK (length(trim(workflow_name)) > 0), conclusion TEXT NOT NULL CHECK (length(trim(conclusion)) > 0), tested_revision TEXT NOT NULL CHECK (length(trim(tested_revision)) > 0), failed_jobs_json TEXT NOT NULL, log_excerpt TEXT, redaction_count INTEGER NOT NULL CHECK (redaction_count >= 0), evidence_bytes INTEGER NOT NULL CHECK (evidence_bytes > 0), evidence_digest TEXT NOT NULL CHECK (length(trim(evidence_digest)) = 64), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0), UNIQUE (provider, provider_run_id)); CREATE INDEX IF NOT EXISTS runtime_ci_evidence_task_attempt ON runtime_ci_evidence (task_id, attempt_id); CREATE INDEX IF NOT EXISTS runtime_ci_evidence_commit ON runtime_ci_evidence (repository, pushed_commit); CREATE INDEX IF NOT EXISTS runtime_ci_evidence_provider_run ON runtime_ci_evidence (provider, provider_run_id);",
  `
    CREATE TABLE IF NOT EXISTS runtime_feature_merges (
      task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT,
      attempt_id TEXT PRIMARY KEY REFERENCES runtime_attempts(id) ON DELETE RESTRICT,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      repository TEXT NOT NULL CHECK (length(trim(repository)) > 0),
      pull_request_node_id TEXT NOT NULL UNIQUE CHECK (length(trim(pull_request_node_id)) > 0),
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      pull_request_url TEXT NOT NULL CHECK (length(trim(pull_request_url)) > 0),
      head_branch TEXT NOT NULL CHECK (length(trim(head_branch)) > 0),
      base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0),
      expected_head_sha TEXT NOT NULL CHECK (length(trim(expected_head_sha)) > 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'merged')),
      merge_sha TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      UNIQUE (repository, pull_request_number),
      CHECK ((state = 'merged' AND merge_sha IS NOT NULL) OR state = 'pending')
    );
    CREATE INDEX IF NOT EXISTS runtime_feature_merges_task_attempt ON runtime_feature_merges (task_id, attempt_id);
    CREATE INDEX IF NOT EXISTS runtime_feature_merges_repository_head ON runtime_feature_merges (repository, head_branch, expected_head_sha);
  `,
  `
    CREATE TABLE IF NOT EXISTS runtime_shipment_cycles (
      task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT,
      attempt_id TEXT PRIMARY KEY REFERENCES runtime_attempts(id) ON DELETE RESTRICT,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      event_id TEXT NOT NULL UNIQUE CHECK (length(trim(event_id)) > 0),
      correlation_id TEXT NOT NULL CHECK (length(trim(correlation_id)) > 0),
      repository TEXT NOT NULL CHECK (length(trim(repository)) > 0),
      head_branch TEXT NOT NULL CHECK (length(trim(head_branch)) > 0),
      base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0),
      expected_head_sha TEXT NOT NULL CHECK (length(trim(expected_head_sha)) > 0),
      provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
      workflow_name TEXT NOT NULL CHECK (length(trim(workflow_name)) > 0),
      state TEXT NOT NULL CHECK (state IN ('started', 'pr_correlated', 'ci_failed', 'evidence_collected', 'retry_created', 'ci_succeeded', 'recovery_success', 'blocked', 'reconciliation_required')),
      outcome TEXT,
      pull_request_number INTEGER,
      pull_request_url TEXT,
      provider_run_id TEXT,
      evidence_digest TEXT,
      successor_attempt_id TEXT,
      merge_sha TEXT,
      message TEXT NOT NULL CHECK (length(trim(message)) > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      UNIQUE (task_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS runtime_shipment_cycles_task_attempt ON runtime_shipment_cycles (task_id, attempt_id);
    CREATE INDEX IF NOT EXISTS runtime_shipment_cycles_event ON runtime_shipment_cycles (event_id);
  `,
  "CREATE TABLE IF NOT EXISTS runtime_retry_pull_request_provenance (task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT, attempt_id TEXT PRIMARY KEY REFERENCES runtime_attempts(id) ON DELETE RESTRICT, repository TEXT NOT NULL CHECK (length(trim(repository)) > 0), issue_number INTEGER NOT NULL CHECK (issue_number > 0), issue_node_id TEXT NOT NULL CHECK (length(trim(issue_node_id)) > 0), issue_url TEXT NOT NULL CHECK (length(trim(issue_url)) > 0), worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0), head_branch TEXT NOT NULL CHECK (length(trim(head_branch)) > 0), base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0), observed_head_sha TEXT NOT NULL CHECK (length(trim(observed_head_sha)) > 0), pull_request_node_id TEXT NOT NULL CHECK (length(trim(pull_request_node_id)) > 0), pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0), pull_request_url TEXT NOT NULL CHECK (length(trim(pull_request_url)) > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS runtime_retry_pull_request_task_attempt ON runtime_retry_pull_request_provenance (task_id, attempt_id); CREATE INDEX IF NOT EXISTS runtime_retry_pull_request_pull ON runtime_retry_pull_request_provenance (repository, pull_request_number);",
  "CREATE TABLE IF NOT EXISTS runtime_retry_ci_correlations (task_id TEXT NOT NULL REFERENCES runtime_tasks(id) ON DELETE RESTRICT, attempt_id TEXT PRIMARY KEY REFERENCES runtime_attempts(id) ON DELETE RESTRICT, schema_version INTEGER NOT NULL CHECK (schema_version = 1), repository TEXT NOT NULL CHECK (length(trim(repository)) > 0), issue_number INTEGER NOT NULL CHECK (issue_number > 0), issue_node_id TEXT NOT NULL CHECK (length(trim(issue_node_id)) > 0), issue_url TEXT NOT NULL CHECK (length(trim(issue_url)) > 0), feature_pr_node_id TEXT NOT NULL CHECK (length(trim(feature_pr_node_id)) > 0), feature_pr_number INTEGER NOT NULL CHECK (feature_pr_number > 0), feature_pr_url TEXT NOT NULL CHECK (length(trim(feature_pr_url)) > 0), worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0), head_branch TEXT NOT NULL CHECK (length(trim(head_branch)) > 0), base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0), pushed_commit TEXT NOT NULL CHECK (length(trim(pushed_commit)) > 0), provider TEXT NOT NULL CHECK (length(trim(provider)) > 0), required_workflow_name TEXT NOT NULL CHECK (length(trim(required_workflow_name)) > 0), provider_run_id TEXT, provider_run_url TEXT, workflow_name TEXT, provider_pipeline_id TEXT, tested_revision TEXT, state TEXT NOT NULL CHECK (state IN ('pending', 'success', 'failed', 'cancelled', 'timed_out', 'not_found', 'ambiguous', 'stale', 'rate_limited', 'retryable', 'permanent', 'unknown', 'unavailable')), observed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0)); CREATE INDEX IF NOT EXISTS runtime_retry_ci_task_attempt ON runtime_retry_ci_correlations (task_id, attempt_id); CREATE INDEX IF NOT EXISTS runtime_retry_ci_commit ON runtime_retry_ci_correlations (repository, pushed_commit); CREATE INDEX IF NOT EXISTS runtime_retry_ci_run ON runtime_retry_ci_correlations (provider, provider_run_id);",
  `ALTER TABLE runtime_attempts ADD COLUMN diagnostic_json TEXT CHECK (diagnostic_json IS NULL OR json_valid(diagnostic_json));`,
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
      ...(row.checkpoint_reference === null ? {} : { checkpointReference: row.checkpoint_reference }), ...(row.progress === null ? {} : { progress: row.progress }), ...(row.test_summary === null ? {} : { testSummary: row.test_summary }), ...(row.blocking_reason === null ? {} : { blockingReason: row.blocking_reason }), ...(row.diagnostic_json === null || row.diagnostic_json === undefined ? {} : { diagnostic: jsonParse(row.diagnostic_json) }),
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
        this.#store.database.prepare("INSERT INTO runtime_task_selection (task_id, queue_order, cooldown_until, dependency_state, synchronized_at) VALUES (?, NULL, NULL, 'unknown', ?)").run(task.id, task.updatedAt);
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
        this.#store.database.prepare(`INSERT INTO runtime_attempts (id, schema_version, task_id, predecessor_attempt_id, ordinal, worker, provider, state, result, started_at, ended_at, branch, worktree, current_commit, final_commit, checkpoint_reference, progress, test_summary, blocking_reason, diagnostic_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ).run(
          attempt.id, 1, attempt.taskId, attempt.predecessorAttemptId ?? null, attempt.ordinal, attempt.worker, attempt.provider, attempt.state, attempt.state === "terminal" ? attempt.result : null,
          attempt.startedAt, attempt.state === "terminal" ? attempt.endedAt : null, attempt.branch ?? null, attempt.worktree ?? null, attempt.currentCommit ?? null,
          attempt.state === "terminal" ? attempt.finalCommit ?? null : null, attempt.checkpointReference ?? null, attempt.progress ?? null, attempt.testSummary ?? null, attempt.state === "terminal" ? attempt.blockingReason ?? null : null, attempt.state === "terminal" && attempt.diagnostic !== undefined ? jsonValue(attempt.diagnostic) : null,
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
        const result = this.#store.database.prepare(`UPDATE runtime_attempts SET state = ?, result = ?, ended_at = ?, branch = ?, worktree = ?, current_commit = ?, final_commit = ?, checkpoint_reference = ?, progress = ?, test_summary = ?, blocking_reason = ?, diagnostic_json = ? WHERE id = ? AND state = ? AND task_id = ? AND ordinal = ? AND started_at = ? AND ((predecessor_attempt_id = ?) OR (predecessor_attempt_id IS NULL AND ? IS NULL))`).run(
          attempt.state, attempt.state === "terminal" ? attempt.result : null, attempt.state === "terminal" ? attempt.endedAt : null, attempt.branch ?? null, attempt.worktree ?? null, attempt.currentCommit ?? null,
          attempt.state === "terminal" ? attempt.finalCommit ?? null : null, attempt.checkpointReference ?? null, attempt.progress ?? null, attempt.testSummary ?? null, attempt.state === "terminal" ? attempt.blockingReason ?? null : null, attempt.state === "terminal" && attempt.diagnostic !== undefined ? jsonValue(attempt.diagnostic) : null,
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

export class TaskSelectionRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  #retryReadiness(task: TaskSnapshot): { readonly runnable: boolean; readonly reconciliationReason?: string } {
    if (task.state !== "in_progress") return { runnable: false };
    const history = this.#store.attempts.listByTask(task.id);
    if (history.outcome !== "success") return { runnable: false, reconciliationReason: `attempt_history_unavailable:${task.id}` };
    const running = history.value.filter((attempt) => attempt.state === "running");
    if (running.length === 0) return { runnable: false };
    if (running.length !== 1) return { runnable: false, reconciliationReason: `multiple_running_attempts:${task.id}` };
    const successor = running[0]!;
    if (successor.predecessorAttemptId === undefined && successor.checkpointReference === undefined) return { runnable: false };
    if (successor.predecessorAttemptId === undefined || successor.checkpointReference === undefined) return { runnable: false, reconciliationReason: `incomplete_retry_identity:${task.id}` };
    const predecessor = history.value.find((attempt) => attempt.id === successor.predecessorAttemptId);
    if (predecessor?.state !== "terminal" || predecessor.ordinal + 1 !== successor.ordinal) return { runnable: false, reconciliationReason: `invalid_retry_predecessor:${task.id}` };
    const checkpoint = this.#store.checkpoints.get(successor.checkpointReference);
    if (checkpoint.outcome !== "success") return { runnable: false, reconciliationReason: `retry_checkpoint_unavailable:${task.id}` };
    if (checkpoint.value.taskId !== task.id || checkpoint.value.previousAttemptId !== predecessor.id) return { runnable: false, reconciliationReason: `retry_checkpoint_mismatch:${task.id}` };
    const activeLease = this.#store.leases.getActiveByTask(task.id);
    if (activeLease.outcome === "success") return { runnable: false, reconciliationReason: `active_lease_requires_reconciliation:${task.id}` };
    if (activeLease.outcome !== "not_found") return { runnable: false, reconciliationReason: `lease_lookup_unavailable:${task.id}` };
    return { runnable: true };
  }

  public synchronize(input: TaskSelectionMetadataInput): StorageResult<TaskSelectionMetadata> {
    const validated = validateTaskSelectionMetadata(input);
    if (!validated.ok) return { outcome: "invalid_record", message: validated.message };
    return this.#store.execute(() => {
      try {
        const task = this.#store.database.prepare("SELECT id FROM runtime_tasks WHERE id = ?").get(input.taskId);
        if (task === undefined) return notFound("Task was not found.");
        this.#store.database.prepare("INSERT INTO runtime_task_selection (task_id, queue_order, cooldown_until, dependency_state, synchronized_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET queue_order = excluded.queue_order, cooldown_until = excluded.cooldown_until, dependency_state = excluded.dependency_state, synchronized_at = excluded.synchronized_at").run(input.taskId, input.queueOrder ?? null, input.cooldownUntil ?? null, input.dependencyState, input.synchronizedAt);
        this.#store.database.prepare("DELETE FROM runtime_task_blockers WHERE task_id = ?").run(input.taskId);
        for (const blocker of input.blockers) this.#store.database.prepare("INSERT INTO runtime_task_blockers (task_id, prerequisite_task_id) VALUES (?, ?)").run(input.taskId, blocker);
        return this.get(input.taskId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public get(taskId: string): StorageResult<TaskSelectionMetadata> {
    if (typeof taskId !== "string" || taskId.trim().length === 0) return { outcome: "invalid_record", message: "Task selection metadata lookup ID is invalid." };
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_task_selection WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
        if (row === undefined) return notFound("Task selection metadata was not found.");
        const blockers = this.#store.database.prepare("SELECT prerequisite_task_id FROM runtime_task_blockers WHERE task_id = ? ORDER BY prerequisite_task_id").all(taskId) as Array<{ prerequisite_task_id: unknown }>;
        if (typeof row.task_id !== "string" || (row.queue_order !== null && (typeof row.queue_order !== "number" || !Number.isSafeInteger(row.queue_order))) || (row.cooldown_until !== null && typeof row.cooldown_until !== "string") || typeof row.dependency_state !== "string" || typeof row.synchronized_at !== "string" || blockers.some((blocker) => typeof blocker.prerequisite_task_id !== "string")) return invalidRecord();
        const parsed = validateTaskSelectionMetadata({
          taskId: row.task_id as TaskId,
          ...(row.queue_order === null ? {} : { queueOrder: row.queue_order }),
          ...(row.cooldown_until === null ? {} : { cooldownUntil: row.cooldown_until as UtcTimestamp }),
          dependencyState: row.dependency_state as "known" | "unknown",
          synchronizedAt: row.synchronized_at as UtcTimestamp,
          blockers: blockers.map((blocker) => blocker.prerequisite_task_id as TaskId),
        });
        return parsed.ok ? success(parsed.value) : invalidRecord();
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public select(request: TaskSelectionRequest): TaskSelectionResult {
    if (!Number.isFinite(Date.parse(request.evaluatedAt)) || new Date(request.evaluatedAt).toISOString() !== request.evaluatedAt) return { outcome: "reconciliation_required", reasons: ["invalid_evaluation_time"], explanations: [] };
    const capabilities = normalizeWorkerCapabilities(request.worker.capabilities);
    if (!capabilities.ok) return { outcome: "reconciliation_required", reasons: ["invalid_worker_capabilities"], explanations: [] };
    const tasks = this.#store.tasks.list();
    if (tasks.outcome !== "success") return { outcome: "reconciliation_required", reasons: ["task_projection_unavailable"], explanations: [] };
    const explanations: TaskEligibilityExplanation[] = [];
    const reconciliationReasons: string[] = [];
    const metadataByTask = new Map<string, TaskSelectionMetadata>();
    const retryRunnable = new Set<string>();
    const runnable = tasks.value.filter((task) => {
      if (task.state === "ready") return true;
      const retry = this.#retryReadiness(task);
      if (retry.reconciliationReason !== undefined) reconciliationReasons.push(retry.reconciliationReason);
      if (retry.runnable) retryRunnable.add(task.id);
      return retry.runnable;
    });
    for (const task of runnable) {
      const metadata = this.get(task.id);
      if (metadata.outcome !== "success") {
        reconciliationReasons.push(`missing_selection_metadata:${task.id}`);
        continue;
      }
      metadataByTask.set(task.id, metadata.value);
      if (metadata.value.queueOrder !== undefined && metadata.value.dependencyState !== "known") reconciliationReasons.push(`unknown_dependency_state:${task.id}`);
    }
    const queueOrders = new Map<number, string[]>();
    for (const metadata of metadataByTask.values()) {
      if (metadata.queueOrder === undefined) continue;
      const values = queueOrders.get(metadata.queueOrder) ?? [];
      values.push(metadata.taskId);
      queueOrders.set(metadata.queueOrder, values);
    }
    for (const [order, ids] of queueOrders) if (ids.length > 1) reconciliationReasons.push(`duplicate_queue_order:${order}`);
    for (const task of tasks.value) {
      const metadata = metadataByTask.get(task.id);
      if (task.state !== "ready" && !retryRunnable.has(task.id)) {
        explanations.push({ taskId: task.id, eligible: false, reasonCode: "NOT_READY", priority: task.priority, ...(metadata?.queueOrder === undefined ? {} : { queueOrder: metadata.queueOrder }), missingCapabilities: [], blockers: metadata?.blockers ?? [] });
      }
    }
    if (reconciliationReasons.length > 0) return { outcome: "reconciliation_required", reasons: Object.freeze([...new Set(reconciliationReasons)].sort()), explanations: Object.freeze(explanations) };
    const eligible: RunnableTaskCandidate[] = [];
    for (const task of runnable) {
      const metadata = metadataByTask.get(task.id);
      if (metadata === undefined) continue;
      if (metadata.queueOrder === undefined) {
        explanations.push({ taskId: task.id, eligible: false, reasonCode: "NOT_QUEUED", priority: task.priority, missingCapabilities: [], blockers: metadata.blockers });
        continue;
      }
      const missingBlocker = metadata.blockers.find((blocker) => !tasks.value.some((candidate) => candidate.id === blocker));
      if (missingBlocker !== undefined) {
        reconciliationReasons.push(`unknown_blocker:${task.id}:${missingBlocker}`);
        continue;
      }
      const unfinished = metadata.blockers.filter((blocker) => tasks.value.some((candidate) => candidate.id === blocker && candidate.state !== "completed"));
      const missing = missingWorkerCapabilities(task, capabilities.value);
      const activeCooldown = cooldownIsActive(metadata.cooldownUntil, request.evaluatedAt) ? metadata.cooldownUntil : undefined;
      const reasonCode = unfinished.length > 0 ? "BLOCKED_BY_PREREQUISITE" : activeCooldown !== undefined ? "COOLDOWN_ACTIVE" : missing.length > 0 ? "MISSING_CAPABILITY" : "ELIGIBLE";
      const explanation: TaskEligibilityExplanation = { taskId: task.id, eligible: reasonCode === "ELIGIBLE", reasonCode, priority: task.priority, queueOrder: metadata.queueOrder, missingCapabilities: missing, blockers: metadata.blockers, ...(activeCooldown === undefined ? {} : { activeCooldown }) };
      explanations.push(explanation);
      if (explanation.eligible) eligible.push({ task, explanation });
    }
    if (reconciliationReasons.length > 0) return { outcome: "reconciliation_required", reasons: Object.freeze([...new Set(reconciliationReasons)].sort()), explanations: Object.freeze(explanations) };
    eligible.sort((left, right) => (left.explanation.queueOrder ?? Number.MAX_SAFE_INTEGER) - (right.explanation.queueOrder ?? Number.MAX_SAFE_INTEGER) || left.task.id.localeCompare(right.task.id));
    return eligible[0] === undefined ? { outcome: "no_runnable_task", explanations: Object.freeze(explanations) } : { outcome: "selected", candidate: eligible[0], explanations: Object.freeze(explanations) };
  }
}

function releasePullRequestFromRow(row: Record<string, unknown>, prefix: "release_pr" | "feature_pr"): ReleasePullRequestIdentity | undefined {
  const node = row[`${prefix}_node_id`];
  const number = row[`${prefix}_number`];
  const url = row[`${prefix}_url`];
  if (node === null || node === undefined) return undefined;
  if (typeof node !== "string" || typeof number !== "number" || typeof url !== "string") throw new Error("Release pull request identity is invalid.");
  return validatePullRequest({ nodeId: node, number, url });
}

function releaseFromRow(row: Record<string, unknown>): StorageResult<ReleaseRecord> {
  try {
    if (typeof row.id !== "string" || typeof row.schema_version !== "number" || typeof row.repository !== "string" || typeof row.source_branch !== "string" || typeof row.base_branch !== "string" || typeof row.state !== "string" || !RELEASE_TRANSITIONS[row.state as ReleaseState] || typeof row.version !== "number" || typeof row.created_at !== "string" || typeof row.updated_at !== "string") return invalidRecord();
    if (row.schema_version !== 1 || !Number.isSafeInteger(row.version) || row.version <= 0) return invalidRecord();
    const state = row.state as ReleaseState;
    releaseId(row.id);
    const releasePullRequest = releasePullRequestFromRow(row, "release_pr");
    return success({
      schemaVersion: 1,
      id: row.id as ReleaseId,
      repository: releaseText(row.repository, "repository"),
      sourceBranch: releaseText(row.source_branch, "source branch"),
      baseBranch: releaseText(row.base_branch, "base branch"),
      state,
      version: row.version,
      createdAt: releaseTimestamp(row.created_at),
      updatedAt: releaseTimestamp(row.updated_at),
      ...(releasePullRequest === undefined ? {} : { releasePullRequest }),
      ...(row.merge_revision === null ? {} : { mergeRevision: releaseText(String(row.merge_revision), "merge revision") }),
      ...(row.deployment_provider_id === null ? {} : { deploymentProviderId: releaseText(String(row.deployment_provider_id), "deployment provider ID") }),
      ...(row.production_version === null ? {} : { productionVersion: releaseText(String(row.production_version), "production version") }),
      ...(row.failure_reason === null ? {} : { failureReason: releaseText(String(row.failure_reason), "failure reason", 1_000) }),
    });
  } catch {
    return invalidRecord();
  }
}

function releaseTaskFromRow(row: Record<string, unknown>): StorageResult<ReleaseTaskRecord> {
  try {
    if (typeof row.release_id !== "string" || typeof row.task_id !== "string" || typeof row.attempt_id !== "string" || typeof row.selected_revision !== "string" || typeof row.created_at !== "string") return invalidRecord();
    const featurePullRequest = releasePullRequestFromRow(row, "feature_pr");
    const value: ReleaseTaskRecord = { releaseId: releaseId(row.release_id), taskId: row.task_id as TaskId, attemptId: row.attempt_id as AttemptId, selectedRevision: releaseText(row.selected_revision, "selected revision", 256), ...(featurePullRequest === undefined ? {} : { featurePullRequest }), createdAt: releaseTimestamp(row.created_at) };
    validateReleaseTaskInput(value);
    return success(value);
  } catch {
    return invalidRecord();
  }
}

export class ReleaseRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public create(input: ReleaseInput): StorageResult<ReleaseRecord> {
    try { validateReleaseInput(input); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Release input is invalid." }; }
    return this.#store.execute(() => {
      try {
        const existing = this.#store.database.prepare("SELECT * FROM runtime_releases WHERE id = ?").get(input.id) as Record<string, unknown> | undefined;
        if (existing !== undefined) {
          const current = releaseFromRow(existing);
          if (current.outcome !== "success") return current;
          return current.value.repository === input.repository && current.value.sourceBranch === input.sourceBranch && current.value.baseBranch === input.baseBranch && current.value.createdAt === input.createdAt ? current : conflict("Release ID conflicts with different immutable identity.");
        }
        this.#store.database.prepare("INSERT INTO runtime_releases (id, schema_version, repository, source_branch, base_branch, state, version, created_at, updated_at, release_pr_node_id, release_pr_number, release_pr_url, merge_revision, deployment_provider_id, production_version, failure_reason) VALUES (?, 1, ?, ?, ?, 'collecting', 1, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)").run(input.id, releaseText(input.repository, "repository"), releaseText(input.sourceBranch, "source branch"), releaseText(input.baseBranch, "base branch"), input.createdAt, input.createdAt);
        return this.get(input.id);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public get(id: string): StorageResult<ReleaseRecord> {
    try { releaseId(id); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Release ID is invalid." }; }
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_releases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("Release was not found.") : releaseFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public listTasks(releaseIdValue: string): StorageResult<readonly ReleaseTaskRecord[]> {
    return this.#listMembership("release_id", releaseIdValue, "No ReleaseTask membership was found for the Release.");
  }

  public listByTaskAttempt(taskId: string, attemptId: string): StorageResult<readonly ReleaseTaskRecord[]> {
    return this.#listMembership("task_id = ? AND attempt_id", taskId, "No ReleaseTask membership was found for the Task/Attempt pair.", attemptId);
  }

  public addTask(input: ReleaseTaskInput): StorageResult<ReleaseTaskRecord> {
    try { validateReleaseTaskInput(input); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "ReleaseTask input is invalid." }; }
    return this.#store.execute(() => {
      try {
        const release = this.get(input.releaseId);
        if (release.outcome !== "success") return release;
        const task = this.#store.tasks.get(input.taskId);
        if (task.outcome !== "success") return task;
        const attempt = this.#store.attempts.get(input.attemptId);
        if (attempt.outcome !== "success") return attempt;
        if (attempt.value.taskId !== input.taskId) return conflict("ReleaseTask Attempt belongs to another Task.");
        if (attempt.value.state !== "terminal" || attempt.value.result !== "CODE_PUSHED" || attempt.value.finalCommit !== input.selectedRevision) return conflict("ReleaseTask must select the terminal CODE_PUSHED Attempt revision.");
        const existing = this.#store.database.prepare("SELECT * FROM runtime_release_tasks WHERE release_id = ? AND task_id = ?").get(input.releaseId, input.taskId) as Record<string, unknown> | undefined;
        if (existing !== undefined) {
          const current = releaseTaskFromRow(existing);
          if (current.outcome !== "success") return current;
          return JSON.stringify(current.value) === JSON.stringify(input) ? current : conflict("ReleaseTask membership conflicts with an existing selection.");
        }
        if (release.value.state !== "collecting") return conflict("ReleaseTask membership is immutable after validation starts.");
        const feature = input.featurePullRequest;
        this.#store.database.prepare("INSERT INTO runtime_release_tasks (release_id, task_id, attempt_id, selected_revision, feature_pr_node_id, feature_pr_number, feature_pr_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(input.releaseId, input.taskId, input.attemptId, input.selectedRevision, feature?.nodeId ?? null, feature?.number ?? null, feature?.url ?? null, input.createdAt);
        return this.getTask(input.releaseId, input.taskId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public getTask(releaseIdValue: string, taskId: string): StorageResult<ReleaseTaskRecord> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_release_tasks WHERE release_id = ? AND task_id = ?").get(releaseIdValue, taskId) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("ReleaseTask membership was not found.") : releaseTaskFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public transition(id: string, input: ReleaseTransitionInput): StorageResult<ReleaseRecord> {
    try { validateTransition(input); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Release transition is invalid." }; }
    return this.#store.execute(() => {
      const current = this.get(id);
      if (current.outcome !== "success") return current;
      const requiresReason = input.to === "failed" || input.to === "blocked" || input.to === "human_action_required" || input.to === "rolled_back";
      if (requiresReason && input.failureReason === undefined) return { outcome: "invalid_record", message: "Failure, block, human-action, and rollback transitions require a reason." };
      if (Date.parse(input.now) < Date.parse(current.value.updatedAt)) return { outcome: "invalid_record", message: "Release transition time cannot move backwards." };
      const pullRequest = input.releasePullRequest ?? current.value.releasePullRequest;
      const mergeRevision = input.mergeRevision ?? current.value.mergeRevision;
      const deploymentProviderId = input.deploymentProviderId ?? current.value.deploymentProviderId;
      const productionVersion = input.productionVersion ?? current.value.productionVersion;
      const failureReason = input.failureReason ?? (requiresReason ? current.value.failureReason : undefined);
      if (current.value.state === input.to) {
        const samePullRequest = input.releasePullRequest === undefined || (current.value.releasePullRequest?.nodeId === input.releasePullRequest.nodeId && current.value.releasePullRequest.number === input.releasePullRequest.number && current.value.releasePullRequest.url === input.releasePullRequest.url);
        const sameEvidence = samePullRequest && (input.mergeRevision === undefined || current.value.mergeRevision === input.mergeRevision) && (input.deploymentProviderId === undefined || current.value.deploymentProviderId === input.deploymentProviderId) && (input.productionVersion === undefined || current.value.productionVersion === input.productionVersion) && (!requiresReason || current.value.failureReason === input.failureReason);
        const replayVersion = input.expectedVersion === current.value.version || input.expectedVersion === current.value.version - 1;
        return sameEvidence && replayVersion && input.now === current.value.updatedAt ? current : conflict("Release transition replay conflicts with durable state.");
      }
      if (current.value.version !== input.expectedVersion) return conflict("Release compare-and-set failed.");
      if (!RELEASE_TRANSITIONS[current.value.state].includes(input.to)) return conflict(`Release cannot transition from ${current.value.state} to ${input.to}.`);
      if ((input.to === "merging" || input.to === "deploying" || input.to === "production_verification" || input.to === "deployed") && pullRequest === undefined) return { outcome: "invalid_record", message: `${input.to} requires a release pull request.` };
      if ((input.to === "deploying" || input.to === "production_verification" || input.to === "deployed") && mergeRevision === undefined) return { outcome: "invalid_record", message: `${input.to} requires a merge revision.` };
      if ((input.to === "production_verification" || input.to === "deployed") && deploymentProviderId === undefined) return { outcome: "invalid_record", message: `${input.to} requires a deployment provider ID.` };
      if (input.to === "deployed" && productionVersion === undefined) return { outcome: "invalid_record", message: "deployed requires a production version." };
      try {
        const updated = this.#store.database.prepare("UPDATE runtime_releases SET state = ?, version = version + 1, updated_at = ?, release_pr_node_id = ?, release_pr_number = ?, release_pr_url = ?, merge_revision = ?, deployment_provider_id = ?, production_version = ?, failure_reason = ? WHERE id = ? AND state = ? AND version = ?").run(input.to, input.now, pullRequest?.nodeId ?? null, pullRequest?.number ?? null, pullRequest?.url ?? null, mergeRevision ?? null, deploymentProviderId ?? null, productionVersion ?? null, failureReason ?? null, id, current.value.state, input.expectedVersion);
        if (updated.changes !== 1) return conflict("Release compare-and-set failed.");
        return this.get(id);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public listRecoverable(): StorageResult<readonly ReleaseRecoveryRecord[]> {
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare("SELECT id, state, version, updated_at FROM runtime_releases WHERE state IN ('validating', 'ready_to_merge', 'merging', 'deploying', 'production_verification') ORDER BY updated_at, id").all() as Array<{ id: string; state: string; version: number; updated_at: string }>;
        return success(Object.freeze(rows.map((row) => ({ releaseId: releaseId(row.id), state: row.state as ReleaseState, version: row.version, updatedAt: releaseTimestamp(row.updated_at) }))));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public recover(id: string, expectedVersion: number, now: UtcTimestamp, reason: string): StorageResult<ReleaseRecord> {
    return this.transition(id, { to: "human_action_required", expectedVersion, now, failureReason: reason });
  }

  #listMembership(field: "release_id" | "task_id = ? AND attempt_id", value: string, missingMessage: string, secondValue?: string): StorageResult<readonly ReleaseTaskRecord[]> {
    if (typeof value !== "string" || value.trim().length === 0) return { outcome: "invalid_record", message: "Release lookup value is invalid." };
    return this.#store.execute(() => {
      try {
        const query = field === "release_id" ? "SELECT * FROM runtime_release_tasks WHERE release_id = ? ORDER BY task_id" : "SELECT * FROM runtime_release_tasks WHERE task_id = ? AND attempt_id = ? ORDER BY release_id";
        const rows = this.#store.database.prepare(query).all(...(secondValue === undefined ? [value] : [value, secondValue])) as Record<string, unknown>[];
        const values: ReleaseTaskRecord[] = [];
        for (const row of rows) { const parsed = releaseTaskFromRow(row); if (parsed.outcome !== "success") return parsed; values.push(parsed.value); }
        return values.length === 0 ? notFound(missingMessage) : success(Object.freeze(values));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
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

function workspaceOwnershipFromRow(row: Record<string, unknown>): StorageResult<WorkspaceOwnershipRecord> {
  try {
    if (typeof row.task_id !== "string" || typeof row.attempt_id !== "string" || typeof row.schema_version !== "number" || typeof row.repository_identity !== "string" || typeof row.repository_root !== "string" || typeof row.assigned_branch !== "string" || typeof row.worktree_path !== "string" || typeof row.expected_base_revision !== "string" || typeof row.current_revision !== "string" || typeof row.ownership_state !== "string" || typeof row.acquired_at !== "string" || typeof row.updated_at !== "string" || typeof row.ownership_token !== "string" || typeof row.version !== "number") return invalidRecord();
    const record: WorkspaceOwnershipRecord = {
      schemaVersion: row.schema_version as 1,
      taskId: row.task_id as TaskId,
      attemptId: row.attempt_id as AttemptId,
      repository: row.repository_identity,
      repositoryRoot: row.repository_root,
      assignedBranch: row.assigned_branch,
      worktreePath: row.worktree_path,
      expectedBaseRevision: row.expected_base_revision,
      currentRevision: row.current_revision,
      state: row.ownership_state as WorkspaceOwnershipRecord["state"],
      acquiredAt: row.acquired_at as UtcTimestamp,
      updatedAt: row.updated_at as UtcTimestamp,
      ownershipToken: row.ownership_token,
      version: row.version,
      ...(row.released_at === null ? {} : { releasedAt: row.released_at as UtcTimestamp }),
    };
    return validateWorkspaceOwnershipRecord(record) ? success(Object.freeze(record)) : invalidRecord();
  } catch {
    return invalidRecord();
  }
}

function workspaceInputError(input: WorkspaceOwnershipInput): WorkspaceOwnershipInput | StorageResult<WorkspaceOwnershipRecord> {
  try { return normalizeWorkspaceOwnershipInput(input); }
  catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Workspace ownership input is invalid." }; }
}

export class WorkspaceOwnershipRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public claim(input: WorkspaceOwnershipInput): StorageResult<WorkspaceOwnershipRecord> {
    const normalized = workspaceInputError(input);
    if (!("taskId" in normalized)) return normalized;
    return this.#store.execute(() => {
      try {
        const attempt = this.#store.database.prepare("SELECT task_id, state FROM runtime_attempts WHERE id = ?").get(normalized.attemptId) as { task_id: string; state: string } | undefined;
        if (attempt === undefined) return notFound("Attempt was not found.");
        if (attempt.task_id !== normalized.taskId) return conflict("Attempt belongs to another Task.");
        if (attempt.state !== "running") return conflict("Only a running Attempt can own an active workspace.");
        const existing = this.#store.database.prepare("SELECT * FROM runtime_workspace_ownership WHERE attempt_id = ?").get(normalized.attemptId) as Record<string, unknown> | undefined;
        if (existing !== undefined) {
          const parsed = workspaceOwnershipFromRow(existing);
          if (parsed.outcome !== "success") return parsed;
          if (parsed.value.state === "active" && workspaceOwnershipMatches(parsed.value, normalized)) return success(parsed.value);
          return conflict("The Attempt already has an incompatible or released workspace ownership record.");
        }
        const token = randomUUID();
        this.#store.database.prepare("INSERT INTO runtime_workspace_ownership (task_id, attempt_id, schema_version, repository_identity, repository_root, assigned_branch, worktree_path, expected_base_revision, current_revision, ownership_state, acquired_at, updated_at, released_at, ownership_token, version) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, 1)").run(
          normalized.taskId, normalized.attemptId, normalized.repository, normalized.repositoryRoot, normalized.assignedBranch, normalized.worktreePath, normalized.expectedBaseRevision, normalized.expectedBaseRevision, normalized.acquiredAt, normalized.acquiredAt, token,
        );
        const created = this.#store.database.prepare("SELECT * FROM runtime_workspace_ownership WHERE attempt_id = ?").get(normalized.attemptId) as Record<string, unknown> | undefined;
        return created === undefined ? storageFailure() : workspaceOwnershipFromRow(created);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public getByTask(taskId: string): StorageResult<WorkspaceOwnershipRecord> { return this.#get("task_id = ? AND ownership_state = 'active'", taskId, "No active workspace was found for the Task."); }
  public getByAttempt(attemptId: string): StorageResult<WorkspaceOwnershipRecord> { return this.#get("attempt_id = ?", attemptId, "No workspace ownership was found for the Attempt."); }
  public getByTaskAttempt(taskId: string, attemptId: string): StorageResult<WorkspaceOwnershipRecord> {
    try { workspaceOwnershipId(taskId, "Task ID"); workspaceOwnershipId(attemptId, "Attempt ID"); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Workspace lookup identity is invalid." }; }
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_workspace_ownership WHERE task_id = ? AND attempt_id = ?").get(taskId, attemptId) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("No workspace ownership was found for the Task and Attempt.") : workspaceOwnershipFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public transfer(input: WorkspaceOwnershipTransferInput): StorageResult<WorkspaceOwnershipRecord> {
    try {
      workspaceOwnershipId(input.taskId, "Task ID");
      workspaceOwnershipId(input.fromAttemptId, "Source Attempt ID");
      workspaceOwnershipId(input.toAttemptId, "Target Attempt ID");
      workspaceOwnershipTimestamp(input.transferredAt, "Transfer timestamp");
      if (input.fromAttemptId === input.toAttemptId) throw new Error("Source and target Attempt must differ.");
    } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Workspace transfer is invalid." }; }
    return this.#store.execute(() => {
      try {
        const source = this.#store.database.prepare("SELECT * FROM runtime_workspace_ownership WHERE task_id = ? AND attempt_id = ? AND ownership_state = 'active'").get(input.taskId, input.fromAttemptId) as Record<string, unknown> | undefined;
        if (source === undefined) return notFound("No active predecessor workspace was found.");
        const sourceValue = workspaceOwnershipFromRow(source);
        if (sourceValue.outcome !== "success") return sourceValue;
        const target = this.#store.database.prepare("SELECT task_id, state, predecessor_attempt_id FROM runtime_attempts WHERE id = ?").get(input.toAttemptId) as { task_id: string; state: string; predecessor_attempt_id: string | null } | undefined;
        if (target === undefined) return notFound("Retry Attempt was not found.");
        if (target.task_id !== input.taskId || target.state !== "running" || target.predecessor_attempt_id !== input.fromAttemptId) return conflict("Workspace transfer target is not the exact running successor Attempt.");
        const updated = this.#store.database.prepare("UPDATE runtime_workspace_ownership SET attempt_id = ?, updated_at = ?, version = version + 1 WHERE task_id = ? AND attempt_id = ? AND ownership_state = 'active' AND version = ?").run(input.toAttemptId, input.transferredAt, input.taskId, input.fromAttemptId, sourceValue.value.version);
        if (updated.changes !== 1) return conflict("Workspace ownership transfer compare-and-set failed.");
        return this.#readAttempt(input.toAttemptId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public getByRepository(repository: string, assignedBranch: string, worktreePath: string): StorageResult<WorkspaceOwnershipRecord> {
    let normalizedPath: string;
    try { normalizedPath = normalizeWorkspaceOwnershipInput({ taskId: "lookup-task" as TaskId, attemptId: "lookup-attempt" as AttemptId, repository, repositoryRoot: "/lookup/repository", assignedBranch, worktreePath, expectedBaseRevision: "0000", acquiredAt: "2026-01-01T00:00:00.000Z" as UtcTimestamp }).worktreePath; } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Workspace lookup is invalid." }; }
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_workspace_ownership WHERE repository_identity = ? AND assigned_branch = ? AND worktree_path = ? ORDER BY version DESC LIMIT 1").get(repository, assignedBranch, normalizedPath) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("No workspace ownership was found for the repository, branch, and worktree.") : workspaceOwnershipFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public updateCurrentRevision(attemptId: string, token: string, expectedVersion: number, revision: string, updatedAt: UtcTimestamp): StorageResult<WorkspaceOwnershipRecord> {
    try { workspaceOwnershipId(attemptId, "Attempt ID"); workspaceOwnershipRevision(revision, "Current revision"); workspaceOwnershipTimestamp(updatedAt, "Updated timestamp"); if (typeof token !== "string" || token.length === 0 || !Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) throw new Error("Workspace ownership token or version is invalid."); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Workspace update is invalid." }; }
    return this.#store.execute(() => {
      try {
        const updated = this.#store.database.prepare("UPDATE runtime_workspace_ownership SET current_revision = ?, updated_at = ?, version = version + 1 WHERE attempt_id = ? AND ownership_state = 'active' AND ownership_token = ? AND version = ?").run(revision.toLowerCase(), updatedAt, attemptId, token, expectedVersion);
        if (updated.changes !== 1) return this.#casFailure(attemptId);
        return this.#readAttempt(attemptId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public release(attemptId: string, token: string, expectedVersion: number, releasedAt: UtcTimestamp): StorageResult<WorkspaceOwnershipRecord> {
    try { workspaceOwnershipId(attemptId, "Attempt ID"); workspaceOwnershipTimestamp(releasedAt, "Released timestamp"); if (typeof token !== "string" || token.length === 0 || !Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) throw new Error("Workspace ownership token or version is invalid."); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Workspace release is invalid." }; }
    return this.#store.execute(() => {
      try {
        const updated = this.#store.database.prepare("UPDATE runtime_workspace_ownership SET ownership_state = 'released', released_at = ?, updated_at = ?, version = version + 1 WHERE attempt_id = ? AND ownership_state = 'active' AND ownership_token = ? AND version = ?").run(releasedAt, releasedAt, attemptId, token, expectedVersion);
        if (updated.changes !== 1) return this.#casFailure(attemptId);
        return this.#readAttempt(attemptId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  public listRecoverable(): StorageResult<readonly WorkspaceOwnershipRecord[]> {
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare("SELECT * FROM runtime_workspace_ownership WHERE ownership_state = 'active' ORDER BY updated_at, attempt_id").all() as Record<string, unknown>[];
        const values: WorkspaceOwnershipRecord[] = [];
        for (const row of rows) { const parsed = workspaceOwnershipFromRow(row); if (parsed.outcome !== "success") return parsed; values.push(parsed.value); }
        return success(Object.freeze(values));
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  #readAttempt(attemptId: string): StorageResult<WorkspaceOwnershipRecord> {
    const row = this.#store.database.prepare("SELECT * FROM runtime_workspace_ownership WHERE attempt_id = ?").get(attemptId) as Record<string, unknown> | undefined;
    return row === undefined ? notFound("Workspace ownership was not found.") : workspaceOwnershipFromRow(row);
  }

  #casFailure(attemptId: string): StorageResult<WorkspaceOwnershipRecord> {
    const current = this.#readAttempt(attemptId);
    return current.outcome === "not_found" ? current : conflict("Workspace ownership compare-and-set failed.");
  }

  #get(predicate: string, value: string, missing: string): StorageResult<WorkspaceOwnershipRecord> {
    try { workspaceOwnershipId(value); } catch (error: unknown) { return { outcome: "invalid_record", message: error instanceof Error ? error.message : "Workspace lookup identity is invalid." }; }
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare(`SELECT * FROM runtime_workspace_ownership WHERE ${predicate} ORDER BY updated_at DESC, attempt_id LIMIT 1`).get(value) as Record<string, unknown> | undefined;
        return row === undefined ? notFound(missing) : workspaceOwnershipFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
}

export interface PullRequestProvenanceInput {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueNodeId: string;
  readonly issueUrl: string;
  readonly workerId: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly observedHeadSha: string;
  readonly pullRequest: ReleasePullRequestIdentity;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}
export interface PullRequestProvenanceRecord extends PullRequestProvenanceInput {}

function provenanceFromRow(row: Record<string, unknown>): StorageResult<PullRequestProvenanceRecord> {
  try {
    if (typeof row.task_id !== "string" || typeof row.attempt_id !== "string" || typeof row.repository !== "string" || typeof row.issue_number !== "number" || typeof row.issue_node_id !== "string" || typeof row.issue_url !== "string" || typeof row.worker_id !== "string" || typeof row.head_branch !== "string" || typeof row.base_branch !== "string" || typeof row.observed_head_sha !== "string" || typeof row.pull_request_node_id !== "string" || typeof row.pull_request_number !== "number" || typeof row.pull_request_url !== "string" || typeof row.created_at !== "string" || typeof row.updated_at !== "string") return invalidRecord();
    const pullRequest = validatePullRequest({ nodeId: row.pull_request_node_id, number: row.pull_request_number, url: row.pull_request_url });
    if (row.issue_number <= 0 || !utcTimestamp(row.created_at).ok || !utcTimestamp(row.updated_at).ok) return invalidRecord();
    return success({ taskId: row.task_id as TaskId, attemptId: row.attempt_id as AttemptId, repository: row.repository, issueNumber: row.issue_number, issueNodeId: row.issue_node_id, issueUrl: row.issue_url, workerId: row.worker_id, headBranch: row.head_branch, baseBranch: row.base_branch, observedHeadSha: row.observed_head_sha, pullRequest, createdAt: row.created_at as UtcTimestamp, updatedAt: row.updated_at as UtcTimestamp });
  } catch { return invalidRecord(); }
}

export class PullRequestProvenanceRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public getByTaskAttempt(taskId: string, attemptId: string): StorageResult<PullRequestProvenanceRecord> { return this.#get("task_id = ? AND attempt_id = ?", taskId, attemptId); }
  public getByPullRequest(repository: string, number: number): StorageResult<PullRequestProvenanceRecord> { return this.#get("repository = ? AND pull_request_number = ?", repository, number); }
  public save(input: PullRequestProvenanceInput): StorageResult<PullRequestProvenanceRecord> {
    try {
      validatePullRequest(input.pullRequest);
      if (input.repository.trim().length === 0 || input.workerId.trim().length === 0 || input.headBranch.trim().length === 0 || input.baseBranch.trim().length === 0 || input.observedHeadSha.trim().length === 0 || input.issueNodeId.trim().length === 0 || input.issueUrl.trim().length === 0 || !Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0 || !utcTimestamp(input.createdAt).ok || !utcTimestamp(input.updatedAt).ok) return invalidRecord();
    } catch { return invalidRecord(); }
    return this.#store.execute(() => {
      const task = this.#store.tasks.get(input.taskId);
      const attempt = this.#store.attempts.get(input.attemptId);
      if (task.outcome !== "success") return { outcome: task.outcome, message: task.message };
      if (attempt.outcome !== "success") return { outcome: attempt.outcome, message: attempt.message };
      const reference = task.value.githubReference;
      const taskRepository = reference === undefined ? undefined : reference.owner + "/" + reference.repository;
      if (attempt.value.taskId !== input.taskId || attempt.value.state !== "terminal" || attempt.value.result !== "CODE_PUSHED" || attempt.value.worker !== input.workerId || attempt.value.branch !== input.headBranch || attempt.value.finalCommit !== input.observedHeadSha || reference === undefined || taskRepository !== input.repository || reference.issueNumber !== input.issueNumber || reference.nodeId !== input.issueNodeId || reference.url !== input.issueUrl) return conflict("Pull request provenance does not match the terminal Attempt and linked GitHub Issue.");
      const existing = this.getByTaskAttempt(input.taskId, input.attemptId);
      if (existing.outcome === "success") return JSON.stringify(existing.value) === JSON.stringify(input) ? existing : conflict("Pull request provenance conflicts with the stored relationship.");
      if (existing.outcome !== "not_found") return existing;
      const prior = this.getByPullRequest(input.repository, input.pullRequest.number);
      if (prior.outcome === "success") {
        if (prior.value.taskId !== input.taskId || prior.value.repository !== input.repository || prior.value.headBranch !== input.headBranch || prior.value.baseBranch !== input.baseBranch || JSON.stringify(prior.value.pullRequest) !== JSON.stringify(input.pullRequest)) return conflict("Pull request is already durably linked to incompatible provenance.");
        try {
          this.#store.database.prepare("INSERT INTO runtime_retry_pull_request_provenance (task_id, attempt_id, repository, issue_number, issue_node_id, issue_url, worker_id, head_branch, base_branch, observed_head_sha, pull_request_node_id, pull_request_number, pull_request_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.taskId, input.attemptId, input.repository, input.issueNumber, input.issueNodeId, input.issueUrl, input.workerId, input.headBranch, input.baseBranch, input.observedHeadSha, input.pullRequest.nodeId, input.pullRequest.number, input.pullRequest.url, input.createdAt, input.updatedAt);
          return this.getByTaskAttempt(input.taskId, input.attemptId);
        } catch (error: unknown) { return classifyStorageError(error); }
      }
      if (prior.outcome !== "not_found") return prior;
      try {
        this.#store.database.prepare("INSERT INTO runtime_pull_request_provenance (task_id, attempt_id, repository, issue_number, issue_node_id, issue_url, worker_id, head_branch, base_branch, observed_head_sha, pull_request_node_id, pull_request_number, pull_request_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.taskId, input.attemptId, input.repository, input.issueNumber, input.issueNodeId, input.issueUrl, input.workerId, input.headBranch, input.baseBranch, input.observedHeadSha, input.pullRequest.nodeId, input.pullRequest.number, input.pullRequest.url, input.createdAt, input.updatedAt);
        return this.getByTaskAttempt(input.taskId, input.attemptId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  #get(where: string, ...parameters: readonly (string | number)[]): StorageResult<PullRequestProvenanceRecord> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM (SELECT * FROM runtime_pull_request_provenance UNION ALL SELECT * FROM runtime_retry_pull_request_provenance) WHERE " + where + " LIMIT 1").get(...parameters) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("Pull request provenance was not found.") : provenanceFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
}

function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : typeof value === "string" && value.length > 0 ? value : undefined;
}

function ciCorrelationFromRow(row: Record<string, unknown>): StorageResult<CiCorrelationRecord> {
  try {
    const required = ["task_id", "attempt_id", "repository", "issue_node_id", "issue_url", "feature_pr_node_id", "feature_pr_url", "worker_id", "head_branch", "base_branch", "pushed_commit", "provider", "required_workflow_name", "state", "created_at", "updated_at"];
    if (required.some((key) => typeof row[key] !== "string" || (row[key] as string).trim().length === 0) || typeof row.issue_number !== "number" || typeof row.feature_pr_number !== "number" || typeof row.version !== "number" || row.schema_version !== 1 || !Number.isSafeInteger(row.issue_number) || !Number.isSafeInteger(row.feature_pr_number) || !Number.isSafeInteger(row.version) || row.issue_number <= 0 || row.feature_pr_number <= 0 || row.version <= 0 || !utcTimestamp(row.created_at as string).ok || !utcTimestamp(row.updated_at as string).ok) return invalidRecord();
    const states: ReadonlySet<string> = new Set(["pending", "success", "failed", "cancelled", "timed_out", "not_found", "ambiguous", "stale", "rate_limited", "retryable", "permanent", "unknown", "unavailable"]);
    if (!states.has(row.state as string)) return invalidRecord();
    const observedAt = optionalText(row.observed_at);
    const providerRunId = optionalText(row.provider_run_id);
    const providerRunUrl = optionalText(row.provider_run_url);
    const workflowName = optionalText(row.workflow_name);
    const providerPipelineId = optionalText(row.provider_pipeline_id);
    const testedRevision = optionalText(row.tested_revision);
    const optionalColumns = [row.provider_run_id, row.provider_run_url, row.workflow_name, row.provider_pipeline_id, row.tested_revision];
    if (optionalColumns.some((value) => value !== null && (typeof value !== "string" || value.trim().length === 0)) || (providerRunUrl !== undefined && !/^https:\/\//u.test(providerRunUrl))) return invalidRecord();
    if (observedAt !== undefined && !utcTimestamp(observedAt).ok) return invalidRecord();
    return success({
      schemaVersion: 1,
      taskId: row.task_id as CiCorrelationRecord["taskId"],
      attemptId: row.attempt_id as CiCorrelationRecord["attemptId"],
      repository: row.repository as string,
      issueNumber: row.issue_number as number,
      issueNodeId: row.issue_node_id as string,
      issueUrl: row.issue_url as string,
      featurePullRequest: { nodeId: row.feature_pr_node_id as string, number: row.feature_pr_number as number, url: row.feature_pr_url as string },
      workerId: row.worker_id as string,
      headBranch: row.head_branch as string,
      baseBranch: row.base_branch as string,
      pushedCommit: row.pushed_commit as string,
      provider: row.provider as string,
      requiredWorkflowName: row.required_workflow_name as string,
      ...(providerRunId === undefined ? {} : { providerRunId }),
      ...(providerRunUrl === undefined ? {} : { providerRunUrl }),
      ...(workflowName === undefined ? {} : { workflowName }),
      ...(providerPipelineId === undefined ? {} : { providerPipelineId }),
      ...(testedRevision === undefined ? {} : { testedRevision }),
      state: row.state as CiCorrelationState,
      ...(observedAt === undefined ? {} : { observedAt: observedAt as UtcTimestamp }),
      createdAt: row.created_at as CiCorrelationRecord["createdAt"],
      updatedAt: row.updated_at as CiCorrelationRecord["updatedAt"],
      version: row.version as number,
    });
  } catch { return invalidRecord(); }
}

export class CiCorrelationRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public getByTaskAttempt(taskId: string, attemptId: string): StorageResult<CiCorrelationRecord> { return this.#get("task_id = ? AND attempt_id = ?", taskId, attemptId); }
  public getByPullRequest(repository: string, number: number): StorageResult<CiCorrelationRecord> { return this.#get("repository = ? AND feature_pr_number = ?", repository, number); }
  public getByCommit(repository: string, commit: string): StorageResult<CiCorrelationRecord> { return this.#get("repository = ? AND pushed_commit = ?", repository, commit); }
  public getByProviderRun(provider: string, providerRunId: string): StorageResult<CiCorrelationRecord> { return this.#get("provider = ? AND provider_run_id = ?", provider, providerRunId); }

  public start(input: CiCorrelationInput): StorageResult<CiCorrelationRecord> {
    try {
      validatePullRequest(input.featurePullRequest);
      if (input.taskId.trim().length === 0 || input.attemptId.trim().length === 0 || input.repository.trim().length === 0 || input.issueNodeId.trim().length === 0 || input.issueUrl.trim().length === 0 || input.workerId.trim().length === 0 || input.headBranch.trim().length === 0 || input.baseBranch.trim().length === 0 || input.pushedCommit.trim().length === 0 || input.provider.trim().length === 0 || input.requiredWorkflowName.trim().length === 0 || !Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0 || !utcTimestamp(input.createdAt).ok || !utcTimestamp(input.updatedAt).ok) return invalidRecord();
    } catch { return invalidRecord(); }
    return this.#store.execute(() => {
      const provenance = this.#store.pullRequests.getByTaskAttempt(input.taskId, input.attemptId);
      if (provenance.outcome !== "success") return provenance.outcome === "not_found" ? conflict("CI correlation requires feature pull request provenance.") : provenance;
      const attempt = this.#store.attempts.get(input.attemptId);
      if (attempt.outcome !== "success") return attempt.outcome === "not_found" ? conflict("CI correlation requires a durable Attempt.") : attempt;
      // Attempt.provider identifies the worker that produced the revision. The correlation
      // provider identifies the CI system that observes it; they are intentionally independent.
      if (provenance.value.repository !== input.repository || provenance.value.issueNumber !== input.issueNumber || provenance.value.issueNodeId !== input.issueNodeId || provenance.value.issueUrl !== input.issueUrl || provenance.value.workerId !== input.workerId || provenance.value.headBranch !== input.headBranch || provenance.value.baseBranch !== input.baseBranch || provenance.value.observedHeadSha !== input.pushedCommit || JSON.stringify(provenance.value.pullRequest) !== JSON.stringify(input.featurePullRequest)) return conflict("CI correlation does not match feature pull request provenance.");
      const existing = this.getByTaskAttempt(input.taskId, input.attemptId);
      if (existing.outcome === "success") {
        const stored = existing.value;
        const sameIdentity = stored.taskId === input.taskId && stored.attemptId === input.attemptId && stored.repository === input.repository && stored.issueNumber === input.issueNumber && stored.issueNodeId === input.issueNodeId && stored.issueUrl === input.issueUrl && JSON.stringify(stored.featurePullRequest) === JSON.stringify(input.featurePullRequest) && stored.workerId === input.workerId && stored.headBranch === input.headBranch && stored.baseBranch === input.baseBranch && stored.pushedCommit === input.pushedCommit && stored.provider === input.provider && stored.requiredWorkflowName === input.requiredWorkflowName;
        return sameIdentity ? existing : conflict("CI correlation conflicts with the stored relationship.");
      }
      if (existing.outcome !== "not_found") return existing;
      try {
        this.#store.database.prepare("INSERT INTO runtime_ci_correlations (task_id, attempt_id, schema_version, repository, issue_number, issue_node_id, issue_url, feature_pr_node_id, feature_pr_number, feature_pr_url, worker_id, head_branch, base_branch, pushed_commit, provider, required_workflow_name, state, created_at, updated_at, version) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)").run(input.taskId, input.attemptId, input.repository, input.issueNumber, input.issueNodeId, input.issueUrl, input.featurePullRequest.nodeId, input.featurePullRequest.number, input.featurePullRequest.url, input.workerId, input.headBranch, input.baseBranch, input.pushedCommit, input.provider, input.requiredWorkflowName, input.createdAt, input.updatedAt);
        return this.getByTaskAttempt(input.taskId, input.attemptId);
      } catch (error: unknown) {
        const prior = this.getByPullRequest(input.repository, input.featurePullRequest.number);
        if (prior.outcome !== "success" || prior.value.taskId !== input.taskId || prior.value.featurePullRequest.number !== input.featurePullRequest.number) return classifyStorageError(error);
        try {
          this.#store.database.prepare("INSERT INTO runtime_retry_ci_correlations (task_id, attempt_id, schema_version, repository, issue_number, issue_node_id, issue_url, feature_pr_node_id, feature_pr_number, feature_pr_url, worker_id, head_branch, base_branch, pushed_commit, provider, required_workflow_name, state, created_at, updated_at, version) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)").run(input.taskId, input.attemptId, input.repository, input.issueNumber, input.issueNodeId, input.issueUrl, input.featurePullRequest.nodeId, input.featurePullRequest.number, input.featurePullRequest.url, input.workerId, input.headBranch, input.baseBranch, input.pushedCommit, input.provider, input.requiredWorkflowName, input.createdAt, input.updatedAt);
          return this.getByTaskAttempt(input.taskId, input.attemptId);
        } catch (retryError: unknown) { return classifyStorageError(retryError); }
      }
    });
  }

  public recordObservation(taskId: string, attemptId: string, observation: CiCorrelationObservation): StorageResult<CiCorrelationRecord> {
    if (!utcTimestamp(observation.observedAt).ok) return invalidRecord();
    return this.#store.execute(() => {
      const existing = this.getByTaskAttempt(taskId, attemptId);
      if (existing.outcome !== "success") return existing;
      const current = existing.value;
      const run = observation.run;
      if (current.state !== "pending") return JSON.stringify({ state: observation.state, run }) === JSON.stringify({ state: current.state, run: current.providerRunId === undefined ? undefined : { providerRunId: current.providerRunId } }) ? existing : conflict("CI correlation is already terminal and cannot be rewritten.");
      try {
        const table = this.#store.database.prepare("SELECT 1 AS found FROM runtime_ci_correlations WHERE task_id = ? AND attempt_id = ?").get(current.taskId, current.attemptId) === undefined ? "runtime_retry_ci_correlations" : "runtime_ci_correlations";
        this.#store.database.prepare(`UPDATE ${table} SET provider_run_id = ?, provider_run_url = ?, workflow_name = ?, provider_pipeline_id = ?, tested_revision = ?, state = ?, observed_at = ?, updated_at = ?, version = version + 1 WHERE task_id = ? AND attempt_id = ? AND version = ? AND state = 'pending'`).run(run?.providerRunId ?? null, run?.url ?? null, run?.name ?? null, run?.pipeline?.providerPipelineId ?? null, run?.testedRevision ?? null, observation.state, observation.observedAt, observation.observedAt, current.taskId, current.attemptId, current.version);
        return this.getByTaskAttempt(taskId, attemptId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }

  #get(where: string, ...parameters: readonly (string | number)[]): StorageResult<CiCorrelationRecord> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM (SELECT * FROM runtime_ci_correlations UNION ALL SELECT * FROM runtime_retry_ci_correlations) WHERE " + where + " LIMIT 1").get(...parameters) as Record<string, unknown> | undefined;
        return row === undefined ? notFound("CI correlation was not found.") : ciCorrelationFromRow(row);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
}

function ciEvidenceFromRow(row: Record<string, unknown>): StorageResult<CiFailureEvidenceRecord> {
  try {
    const strings = ["task_id", "attempt_id", "repository", "feature_pr_url", "head_branch", "pushed_commit", "provider", "provider_run_id", "provider_run_url", "workflow_name", "conclusion", "tested_revision", "evidence_digest", "created_at", "updated_at"];
    if (strings.some((key) => typeof row[key] !== "string" || (row[key] as string).trim().length === 0) || row.schema_version !== 1 || typeof row.issue_number !== "number" || typeof row.feature_pr_number !== "number" || typeof row.redaction_count !== "number" || typeof row.evidence_bytes !== "number" || typeof row.version !== "number" || !Number.isSafeInteger(row.issue_number) || !Number.isSafeInteger(row.feature_pr_number) || !Number.isSafeInteger(row.redaction_count) || !Number.isSafeInteger(row.evidence_bytes) || !Number.isSafeInteger(row.version) || row.issue_number <= 0 || row.feature_pr_number <= 0 || row.redaction_count < 0 || row.evidence_bytes <= 0 || row.version <= 0 || !/^\p{Hex_Digit}{64}$/u.test(row.evidence_digest as string) || !utcTimestamp(row.created_at as string).ok || !utcTimestamp(row.updated_at as string).ok) return invalidRecord();
    const parsed = jsonParse(row.failed_jobs_json);
    if (!Array.isArray(parsed)) return invalidRecord();
    const failedJobs = parsed as CiFailureEvidenceRecord["failedJobs"];
    const logExcerpt = optionalText(row.log_excerpt);
    return success({ schemaVersion: 1, taskId: row.task_id as CiFailureEvidenceRecord["taskId"], attemptId: row.attempt_id as CiFailureEvidenceRecord["attemptId"], repository: row.repository as string, issueNumber: row.issue_number as number, featurePullRequestNumber: row.feature_pr_number as number, featurePullRequestUrl: row.feature_pr_url as string, headBranch: row.head_branch as string, pushedCommit: row.pushed_commit as string, provider: row.provider as string, providerRunId: row.provider_run_id as string, providerRunUrl: row.provider_run_url as string, workflowName: row.workflow_name as string, conclusion: row.conclusion as CiFailureEvidenceRecord["conclusion"], testedRevision: row.tested_revision as string, failedJobs, ...(logExcerpt === undefined ? {} : { logExcerpt }), redactionCount: row.redaction_count as number, evidenceBytes: row.evidence_bytes as number, evidenceDigest: row.evidence_digest as string, createdAt: row.created_at as CiFailureEvidenceRecord["createdAt"], updatedAt: row.updated_at as CiFailureEvidenceRecord["updatedAt"], version: row.version as number });
  } catch { return invalidRecord(); }
}

export class CiFailureEvidenceRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }
  public getByTaskAttempt(taskId: string, attemptId: string): StorageResult<CiFailureEvidenceRecord> { return this.#get("task_id = ? AND attempt_id = ?", taskId, attemptId); }
  public getByProviderRun(provider: string, providerRunId: string): StorageResult<CiFailureEvidenceRecord> { return this.#get("provider = ? AND provider_run_id = ?", provider, providerRunId); }
  public save(record: CiFailureEvidenceRecord): StorageResult<CiFailureEvidenceRecord> {
    if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.redactionCount) || record.redactionCount < 0 || !Number.isSafeInteger(record.evidenceBytes) || record.evidenceBytes <= 0 || !/^\p{Hex_Digit}{64}$/u.test(record.evidenceDigest) || !utcTimestamp(record.createdAt).ok || !utcTimestamp(record.updatedAt).ok) return invalidRecord();
    return this.#store.execute(() => {
      const correlation = this.#store.ciCorrelations.getByTaskAttempt(record.taskId, record.attemptId);
      if (correlation.outcome !== "success" || correlation.value.state !== "failed" || correlation.value.repository !== record.repository || correlation.value.pushedCommit !== record.pushedCommit || correlation.value.provider !== record.provider || correlation.value.providerRunId !== record.providerRunId || correlation.value.testedRevision !== record.testedRevision || correlation.value.featurePullRequest.number !== record.featurePullRequestNumber) return conflict("CI failure evidence does not match the durable failed CI correlation.");
      const existing = this.getByTaskAttempt(record.taskId, record.attemptId);
      if (existing.outcome === "success") return existing.value.evidenceDigest === record.evidenceDigest ? existing : conflict("CI failure evidence conflicts with the stored record.");
      if (existing.outcome !== "not_found") return existing;
      try {
        this.#store.database.prepare("INSERT INTO runtime_ci_evidence (task_id, attempt_id, schema_version, repository, issue_number, feature_pr_number, feature_pr_url, head_branch, pushed_commit, provider, provider_run_id, provider_run_url, workflow_name, conclusion, tested_revision, failed_jobs_json, log_excerpt, redaction_count, evidence_bytes, evidence_digest, created_at, updated_at, version) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(record.taskId, record.attemptId, record.repository, record.issueNumber, record.featurePullRequestNumber, record.featurePullRequestUrl, record.headBranch, record.pushedCommit, record.provider, record.providerRunId, record.providerRunUrl, record.workflowName, record.conclusion, record.testedRevision, jsonValue(record.failedJobs), record.logExcerpt ?? null, record.redactionCount, record.evidenceBytes, record.evidenceDigest, record.createdAt, record.updatedAt);
        return this.getByTaskAttempt(record.taskId, record.attemptId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
  #get(where: string, ...parameters: readonly (string | number)[]): StorageResult<CiFailureEvidenceRecord> {
    return this.#store.execute(() => {
      try { const row = this.#store.database.prepare("SELECT * FROM runtime_ci_evidence WHERE " + where).get(...parameters) as Record<string, unknown> | undefined; return row === undefined ? notFound("CI failure evidence was not found.") : ciEvidenceFromRow(row); } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
}

function featureMergeFromRow(row: Record<string, unknown>): StorageResult<FeatureMergeRecord> {
  try {
    const strings = ["task_id", "attempt_id", "repository", "pull_request_node_id", "pull_request_url", "head_branch", "base_branch", "expected_head_sha", "state", "created_at", "updated_at"];
    if (strings.some((key) => typeof row[key] !== "string" || (row[key] as string).trim().length === 0) || row.schema_version !== 1 || typeof row.pull_request_number !== "number" || typeof row.version !== "number" || !Number.isSafeInteger(row.pull_request_number) || !Number.isSafeInteger(row.version) || row.pull_request_number <= 0 || row.version <= 0 || !["pending", "merged"].includes(row.state as string) || !utcTimestamp(row.created_at as string).ok || !utcTimestamp(row.updated_at as string).ok) return invalidRecord();
    const mergeSha = optionalText(row.merge_sha);
    if (row.merge_sha !== null && mergeSha === undefined) return invalidRecord();
    if (row.state === "merged" && mergeSha === undefined) return invalidRecord();
    return success({ schemaVersion: 1, taskId: row.task_id as TaskId, attemptId: row.attempt_id as AttemptId, repository: row.repository as string, pullRequestNodeId: row.pull_request_node_id as string, pullRequestNumber: row.pull_request_number as number, pullRequestUrl: row.pull_request_url as string, headBranch: row.head_branch as string, baseBranch: row.base_branch as string, expectedHeadSha: row.expected_head_sha as string, state: row.state as FeatureMergeRecord["state"], ...(mergeSha === undefined ? {} : { mergeSha }), createdAt: row.created_at as UtcTimestamp, updatedAt: row.updated_at as UtcTimestamp, version: row.version as number });
  } catch { return invalidRecord(); }
}

export class FeatureMergeRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }
  public getByTaskAttempt(taskId: string, attemptId: string): StorageResult<FeatureMergeRecord> { return this.#get("task_id = ? AND attempt_id = ?", taskId, attemptId); }
  public getByPullRequest(repository: string, number: number): StorageResult<FeatureMergeRecord> { return this.#get("repository = ? AND pull_request_number = ?", repository, number); }
  public start(record: FeatureMergeRecord): StorageResult<FeatureMergeRecord> {
    if (record.schemaVersion !== 1 || record.state !== "pending" || record.taskId.trim().length === 0 || record.attemptId.trim().length === 0 || record.repository.trim().length === 0 || record.pullRequestNodeId.trim().length === 0 || record.pullRequestUrl.trim().length === 0 || record.headBranch.trim().length === 0 || record.baseBranch.trim().length === 0 || record.expectedHeadSha.trim().length === 0 || !Number.isSafeInteger(record.pullRequestNumber) || record.pullRequestNumber <= 0 || record.mergeSha !== undefined || record.version !== 1 || !utcTimestamp(record.createdAt).ok || !utcTimestamp(record.updatedAt).ok) return invalidRecord();
    return this.#store.execute(() => {
      const task = this.#store.tasks.get(record.taskId); const attempt = this.#store.attempts.get(record.attemptId);
      if (task.outcome !== "success") return task;
      if (attempt.outcome !== "success") return attempt;
      if (attempt.value.taskId !== record.taskId) return conflict("Feature merge Attempt does not belong to the Task.");
      const existing = this.getByTaskAttempt(record.taskId, record.attemptId);
      if (existing.outcome === "success") return JSON.stringify(existing.value) === JSON.stringify(record) ? existing : conflict("Feature merge ledger conflicts with the stored identity.");
      if (existing.outcome !== "not_found") return existing;
      const byPull = this.getByPullRequest(record.repository, record.pullRequestNumber);
      if (byPull.outcome === "success") return JSON.stringify(byPull.value) === JSON.stringify(record) ? byPull : conflict("Feature merge ledger already owns this pull request.");
      if (byPull.outcome !== "not_found") return byPull;
      try {
        this.#store.database.prepare("INSERT INTO runtime_feature_merges (task_id, attempt_id, schema_version, repository, pull_request_node_id, pull_request_number, pull_request_url, head_branch, base_branch, expected_head_sha, state, merge_sha, created_at, updated_at, version) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, 1)").run(record.taskId, record.attemptId, record.repository, record.pullRequestNodeId, record.pullRequestNumber, record.pullRequestUrl, record.headBranch, record.baseBranch, record.expectedHeadSha, record.createdAt, record.updatedAt);
        return this.getByTaskAttempt(record.taskId, record.attemptId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
  public markMerged(taskId: string, attemptId: string, mergeSha: string, updatedAt: UtcTimestamp): StorageResult<FeatureMergeRecord> {
    if (mergeSha.trim().length === 0 || !utcTimestamp(updatedAt).ok) return invalidRecord();
    return this.#store.execute(() => {
      const current = this.getByTaskAttempt(taskId, attemptId);
      if (current.outcome !== "success") return current;
      if (current.value.state === "merged") return current.value.mergeSha === mergeSha ? current : conflict("Feature merge already has a different merge revision.");
      try {
        this.#store.database.prepare("UPDATE runtime_feature_merges SET state = 'merged', merge_sha = ?, updated_at = ?, version = version + 1 WHERE task_id = ? AND attempt_id = ? AND version = ? AND state = 'pending'").run(mergeSha, updatedAt, taskId, attemptId, current.value.version);
        return this.getByTaskAttempt(taskId, attemptId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
  #get(where: string, ...parameters: readonly (string | number)[]): StorageResult<FeatureMergeRecord> {
    return this.#store.execute(() => {
      try { const row = this.#store.database.prepare("SELECT * FROM runtime_feature_merges WHERE " + where).get(...parameters) as Record<string, unknown> | undefined; return row === undefined ? notFound("Feature merge ledger was not found.") : featureMergeFromRow(row); } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
}

function shipmentCycleFromRow(row: Record<string, unknown>): StorageResult<ShipmentCycleRecord> {
  try {
    const strings = ["task_id", "attempt_id", "event_id", "correlation_id", "repository", "head_branch", "base_branch", "expected_head_sha", "provider", "workflow_name", "state", "message", "created_at", "updated_at"];
    const states: ReadonlySet<string> = new Set(["started", "pr_correlated", "ci_failed", "evidence_collected", "retry_created", "ci_succeeded", "recovery_success", "blocked", "reconciliation_required"]);
    const outcomes: ReadonlySet<string> = new Set(["recovery_success", "retry_created", "retry_ci_failed", "pending_or_timeout", "stale_or_conflicting_evidence", "policy_blocked", "rate_limited", "reconciliation_required", "worker_unavailable", "worker_authentication_required", "worker_quota_exhausted", "repair_failed", "unknown", "invalid_request"]);
    if (strings.some((key) => typeof row[key] !== "string" || (row[key] as string).trim().length === 0) || row.schema_version !== 1 || !states.has(row.state as string) || (row.outcome !== null && !outcomes.has(row.outcome as string)) || typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version <= 0 || !utcTimestamp(row.created_at as string).ok || !utcTimestamp(row.updated_at as string).ok) return invalidRecord();
    const optionalNumber = (value: unknown): number | undefined => value === null ? undefined : typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
    const optional = (value: unknown): string | undefined => value === null ? undefined : typeof value === "string" && value.trim().length > 0 ? value : undefined;
    const pullRequestNumber = optionalNumber(row.pull_request_number);
    if (row.pull_request_number !== null && pullRequestNumber === undefined) return invalidRecord();
    return success({ schemaVersion: 1, taskId: row.task_id as TaskId, attemptId: row.attempt_id as AttemptId, eventId: row.event_id as string, correlationId: row.correlation_id as string, repository: row.repository as string, headBranch: row.head_branch as string, baseBranch: row.base_branch as string, expectedHeadSha: row.expected_head_sha as string, provider: row.provider as string, workflowName: row.workflow_name as string, state: row.state as ShipmentCycleState, ...(row.outcome === null ? {} : { outcome: row.outcome as ShipmentOutcome }), ...(pullRequestNumber === undefined ? {} : { pullRequestNumber }), ...(optional(row.pull_request_url) === undefined ? {} : { pullRequestUrl: optional(row.pull_request_url)! }), ...(optional(row.provider_run_id) === undefined ? {} : { providerRunId: optional(row.provider_run_id)! }), ...(optional(row.evidence_digest) === undefined ? {} : { evidenceDigest: optional(row.evidence_digest)! }), ...(optional(row.successor_attempt_id) === undefined ? {} : { successorAttemptId: optional(row.successor_attempt_id) as AttemptId }), ...(optional(row.merge_sha) === undefined ? {} : { mergeSha: optional(row.merge_sha)! }), message: row.message as string, createdAt: row.created_at as UtcTimestamp, updatedAt: row.updated_at as UtcTimestamp, version: row.version as number });
  } catch { return invalidRecord(); }
}

export type ShipmentCyclePatch = Partial<Pick<ShipmentCycleRecord, "state" | "outcome" | "pullRequestNumber" | "pullRequestUrl" | "providerRunId" | "evidenceDigest" | "successorAttemptId" | "mergeSha" | "message">>;

export class ShipmentCycleRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }
  public getByEvent(eventId: string): StorageResult<ShipmentCycleRecord> { return this.#get("event_id = ?", eventId); }
  public getByTaskAttempt(taskId: string, attemptId: string): StorageResult<ShipmentCycleRecord> { return this.#get("task_id = ? AND attempt_id = ?", taskId, attemptId); }
  public start(record: ShipmentCycleRecord): StorageResult<ShipmentCycleRecord> {
    if (record.schemaVersion !== 1 || record.state !== "started" || record.outcome !== undefined || record.taskId.trim().length === 0 || record.attemptId.trim().length === 0 || record.eventId.trim().length === 0 || record.correlationId.trim().length === 0 || record.repository.trim().length === 0 || record.headBranch.trim().length === 0 || record.baseBranch.trim().length === 0 || record.expectedHeadSha.trim().length === 0 || record.provider.trim().length === 0 || record.workflowName.trim().length === 0 || record.message.trim().length === 0 || record.version !== 1 || !utcTimestamp(record.createdAt).ok || !utcTimestamp(record.updatedAt).ok) return invalidRecord();
    return this.#store.execute(() => {
      const task = this.#store.tasks.get(record.taskId); const attempt = this.#store.attempts.get(record.attemptId);
      if (task.outcome !== "success") return task;
      if (attempt.outcome !== "success") return attempt;
      if (attempt.value.taskId !== record.taskId) return conflict("Shipment cycle Attempt does not belong to the Task.");
      const existingEvent = this.getByEvent(record.eventId);
      if (existingEvent.outcome === "success") return JSON.stringify(existingEvent.value) === JSON.stringify(record) ? existingEvent : conflict("Shipment event already has a different durable identity.");
      if (existingEvent.outcome !== "not_found") return existingEvent;
      const existingAttempt = this.getByTaskAttempt(record.taskId, record.attemptId);
      if (existingAttempt.outcome === "success") return conflict("Attempt already belongs to another shipment event.");
      if (existingAttempt.outcome !== "not_found") return existingAttempt;
      try {
        this.#store.database.prepare("INSERT INTO runtime_shipment_cycles (task_id, attempt_id, schema_version, event_id, correlation_id, repository, head_branch, base_branch, expected_head_sha, provider, workflow_name, state, outcome, pull_request_number, pull_request_url, provider_run_id, evidence_digest, successor_attempt_id, merge_sha, message, created_at, updated_at, version) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'started', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 1)").run(record.taskId, record.attemptId, record.eventId, record.correlationId, record.repository, record.headBranch, record.baseBranch, record.expectedHeadSha, record.provider, record.workflowName, record.message, record.createdAt, record.updatedAt);
        return this.getByTaskAttempt(record.taskId, record.attemptId);
      } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
  public advance(taskId: string, attemptId: string, patch: ShipmentCyclePatch, updatedAt: UtcTimestamp): StorageResult<ShipmentCycleRecord> {
    if (!utcTimestamp(updatedAt).ok || patch.state === undefined || patch.message === undefined || patch.message.trim().length === 0) return invalidRecord();
    return this.#store.execute(() => {
      const current = this.getByTaskAttempt(taskId, attemptId); if (current.outcome !== "success") return current;
      const values: Array<string | number | null> = []; const assignments: string[] = [];
      const fields: Array<[keyof ShipmentCyclePatch, string]> = [["state", "state"], ["outcome", "outcome"], ["pullRequestNumber", "pull_request_number"], ["pullRequestUrl", "pull_request_url"], ["providerRunId", "provider_run_id"], ["evidenceDigest", "evidence_digest"], ["successorAttemptId", "successor_attempt_id"], ["mergeSha", "merge_sha"], ["message", "message"]];
      for (const [key, column] of fields) { const value = patch[key]; if (value !== undefined) { assignments.push(`${column} = ?`); values.push(value as string | number); } }
      assignments.push("updated_at = ?", "version = version + 1"); values.push(updatedAt, taskId, attemptId, current.value.version);
      try { this.#store.database.prepare(`UPDATE runtime_shipment_cycles SET ${assignments.join(", ")} WHERE task_id = ? AND attempt_id = ? AND version = ?`).run(...values); return this.getByTaskAttempt(taskId, attemptId); } catch (error: unknown) { return classifyStorageError(error); }
    });
  }
  #get(where: string, ...parameters: readonly (string | number)[]): StorageResult<ShipmentCycleRecord> { return this.#store.execute(() => { try { const row = this.#store.database.prepare("SELECT * FROM runtime_shipment_cycles WHERE " + where).get(...parameters) as Record<string, unknown> | undefined; return row === undefined ? notFound("Shipment cycle was not found.") : shipmentCycleFromRow(row); } catch (error: unknown) { return classifyStorageError(error); } }); }
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
  readonly selection: TaskSelectionRepository;
  readonly releases: ReleaseRepository;
  readonly projections: ProjectionRepository;
  readonly webhooks: WebhookRepository;
  readonly workspaces: WorkspaceOwnershipRepository;
  readonly pullRequests: PullRequestProvenanceRepository;
  readonly ciCorrelations: CiCorrelationRepository;
  readonly ciEvidence: CiFailureEvidenceRepository;
  readonly featureMerges: FeatureMergeRepository;
  readonly shipmentCycles: ShipmentCycleRepository;

  private constructor(database: DatabaseSync, filename: string) {
    this.#database = database;
    this.#filename = filename;
    this.tasks = new TaskRepository(this);
    this.attempts = new AttemptRepository(this);
    this.checkpoints = new CheckpointRepository(this);
    this.leases = new LeaseRepository(this);
    this.selection = new TaskSelectionRepository(this);
    this.releases = new ReleaseRepository(this);
    this.projections = new ProjectionRepository(this);
    this.webhooks = new WebhookRepository(this);
    this.workspaces = new WorkspaceOwnershipRepository(this);
    this.pullRequests = new PullRequestProvenanceRepository(this);
    this.ciCorrelations = new CiCorrelationRepository(this);
    this.ciEvidence = new CiFailureEvidenceRepository(this);
    this.featureMerges = new FeatureMergeRepository(this);
    this.shipmentCycles = new ShipmentCycleRepository(this);
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
      try { return operation({ tasks: this.tasks, attempts: this.attempts, checkpoints: this.checkpoints, leases: this.leases, selection: this.selection, releases: this.releases, projections: this.projections, webhooks: this.webhooks, workspaces: this.workspaces, pullRequests: this.pullRequests, ciCorrelations: this.ciCorrelations, ciEvidence: this.ciEvidence, featureMerges: this.featureMerges, shipmentCycles: this.shipmentCycles }); }
      catch { return storageFailure(); }
    }
    try {
      this.assertOpen();
      this.#database.exec("BEGIN IMMEDIATE");
      this.#inTransaction = true;
      const result = operation({ tasks: this.tasks, attempts: this.attempts, checkpoints: this.checkpoints, leases: this.leases, selection: this.selection, releases: this.releases, projections: this.projections, webhooks: this.webhooks, workspaces: this.workspaces, pullRequests: this.pullRequests, ciCorrelations: this.ciCorrelations, ciEvidence: this.ciEvidence, featureMerges: this.featureMerges, shipmentCycles: this.shipmentCycles });
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
