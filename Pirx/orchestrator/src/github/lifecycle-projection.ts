import {
  RuntimeSqliteStore,
  type RuntimeProjectionInput,
  type RuntimeProjectionRecord,
  type StorageResult,
} from "../runtime/sqlite.js";
import { utcTimestamp, type UtcTimestamp } from "../runtime/task-domain.js";
import type {
  GitHubIssueMutator,
  GitHubLifecycleCommentResult,
} from "./issue-mutate.js";
import type { GitHubOperationResult } from "./outcome.js";

export const GITHUB_LIFECYCLE_EVENT_TYPES = [
  "task_accepted",
  "attempt_started",
  "attempt_result",
  "branch_prepared",
  "code_pushed",
  "blocked_human_action_required",
  "retry_cooldown",
  "task_completed",
] as const;
export type GitHubLifecycleEventType = (typeof GITHUB_LIFECYCLE_EVENT_TYPES)[number];

export interface GitHubLifecycleProjectionEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly attemptId?: string;
  readonly sequence: number;
  readonly eventType: GitHubLifecycleEventType | string;
  readonly timestamp: UtcTimestamp;
  readonly summary: string;
  readonly branch?: string;
  readonly commit?: string;
}

export type GitHubLifecycleProjectionOutcome =
  | "published"
  | "already_published"
  | "ignored"
  | "pending"
  | "missing_link"
  | "invalid_event"
  | "conflict"
  | "storage_error"
  | "provider_error";

export interface GitHubLifecycleProjectionResult {
  readonly outcome: GitHubLifecycleProjectionOutcome;
  readonly eventId: string;
  readonly taskId: string;
  readonly message: string;
  readonly providerOutcome?: GitHubOperationResult<GitHubLifecycleCommentResult>["outcome"];
  readonly projection?: RuntimeProjectionRecord;
}

export interface GitHubLifecycleProjectionOptions {
  readonly owner: string;
  readonly repository: string;
  readonly now?: () => string;
}

function result(outcome: GitHubLifecycleProjectionOutcome, eventId: string, taskId: string, message: string, extra: Partial<GitHubLifecycleProjectionResult> = {}): GitHubLifecycleProjectionResult {
  return { outcome, eventId, taskId, message, ...extra };
}
function safePart(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value) && !/bearer\s+|authorization\s*:|-----begin|(?:token|secret|password)\s*=/iu.test(value);
}
function sanitizedSummary(value: unknown): string | undefined {
  if (!safePart(value, 1_000)) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim().slice(0, 500);
  return normalized.length === 0 ? undefined : normalized;
}
function validEventType(value: unknown): value is GitHubLifecycleEventType {
  return typeof value === "string" && (GITHUB_LIFECYCLE_EVENT_TYPES as readonly string[]).includes(value);
}
function validEvent(event: GitHubLifecycleProjectionEvent): string | undefined {
  if (!safePart(event.eventId, 256) || !safePart(event.taskId, 256)) return "eventId and taskId must be bounded identifiers.";
  if (!validEventType(event.eventType)) return "Unsupported lifecycle event type is ignored explicitly.";
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) return "sequence must be a positive integer.";
  if (utcTimestamp(event.timestamp).ok === false) return "timestamp must be canonical UTC.";
  if (sanitizedSummary(event.summary) === undefined) return "summary is empty or contains unsafe content.";
  if (event.attemptId !== undefined && !safePart(event.attemptId, 256)) return "attemptId is invalid.";
  if (event.branch !== undefined && !safePart(event.branch, 512)) return "branch is invalid.";
  if (event.commit !== undefined && !safePart(event.commit, 256)) return "commit is invalid.";
  return undefined;
}
function storageOutcome(event: GitHubLifecycleProjectionEvent, stored: StorageResult<RuntimeProjectionRecord>): GitHubLifecycleProjectionResult {
  if (stored.outcome === "success") return result("pending", event.eventId, event.taskId, "Projection remains pending.", { projection: stored.value });
  if (stored.outcome === "conflict") return result("conflict", event.eventId, event.taskId, stored.message);
  return result("storage_error", event.eventId, event.taskId, stored.message);
}

export class GitHubLifecycleProjectionPublisher {
  readonly #store: RuntimeSqliteStore;
  readonly #mutator: Pick<GitHubIssueMutator, "publishLifecycleComment">;
  readonly #owner: string;
  readonly #repository: string;
  readonly #now: () => string;

  public constructor(store: RuntimeSqliteStore, mutator: Pick<GitHubIssueMutator, "publishLifecycleComment">, options: GitHubLifecycleProjectionOptions) {
    this.#store = store;
    this.#mutator = mutator;
    this.#owner = options.owner;
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async publish(event: GitHubLifecycleProjectionEvent): Promise<GitHubLifecycleProjectionResult> {
    const validation = validEvent(event);
    if (validation !== undefined) return result("invalid_event", event.eventId, event.taskId, validation);
    const summary = sanitizedSummary(event.summary);
    if (summary === undefined) return result("invalid_event", event.eventId, event.taskId, "summary is unsafe.");
    const input: RuntimeProjectionInput = {
      eventId: event.eventId, taskId: event.taskId, sequence: event.sequence, eventType: event.eventType, timestamp: event.timestamp, summary,
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }), ...(event.branch === undefined ? {} : { branch: event.branch }), ...(event.commit === undefined ? {} : { commit: event.commit }),
    };
    const prepared = this.#store.projections.prepare(input, this.#now());
    if (prepared.outcome !== "success") return storageOutcome(event, prepared);
    if (prepared.value.status === "published") return result("already_published", event.eventId, event.taskId, "Projection was already published.", { projection: prepared.value });
    if (prepared.value.status === "ignored") return result("ignored", event.eventId, event.taskId, "Out-of-order lifecycle event was ignored.", { projection: prepared.value });

    const task = this.#store.tasks.get(event.taskId);
    if (task.outcome !== "success") {
      const pending = this.#store.projections.markPending(event.eventId, "Task linkage is unavailable.", this.#now());
      return result("missing_link", event.eventId, event.taskId, "Task linkage is unavailable; projection remains pending.", pending.outcome === "success" ? { projection: pending.value } : {});
    }
    const reference = task.value.githubReference;
    if (reference?.nodeId === undefined || reference.url === undefined) {
      const pending = this.#store.projections.markPending(event.eventId, "Canonical GitHub Issue linkage is missing.", this.#now());
      return result("missing_link", event.eventId, event.taskId, "Canonical GitHub Issue linkage is missing; projection remains pending.", pending.outcome === "success" ? { projection: pending.value } : {});
    }
    if (reference.owner !== this.#owner || reference.repository !== this.#repository) {
      const pending = this.#store.projections.markPending(event.eventId, "Canonical GitHub Issue repository conflicts with the configured target.", this.#now());
      return result("conflict", event.eventId, event.taskId, "Canonical GitHub Issue repository conflicts with the configured target.", pending.outcome === "success" ? { projection: pending.value } : {});
    }
    const envelope = {
      eventId: event.eventId, eventType: event.eventType, taskId: event.taskId, timestamp: event.timestamp, summary,
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }), ...(event.branch === undefined ? {} : { branch: event.branch }), ...(event.commit === undefined ? {} : { commit: event.commit }),
    };
    let published: GitHubOperationResult<GitHubLifecycleCommentResult>;
    try {
      published = await this.#mutator.publishLifecycleComment({ issue: reference.issueNumber, envelope, idempotencyKey: `runtime-projection:${event.eventId}`, correlationId: `runtime-projection:${event.eventId}` });
    } catch {
      const pending = this.#store.projections.markPending(event.eventId, "GitHub projection provider failed before returning a result.", this.#now());
      return result("provider_error", event.eventId, event.taskId, "GitHub projection provider failed; projection remains pending.", pending.outcome === "success" ? { projection: pending.value } : {});
    }
    if (published.outcome !== "success") {
      const pending = this.#store.projections.markPending(event.eventId, "GitHub projection was not confirmed.", this.#now());
      return result("provider_error", event.eventId, event.taskId, "GitHub projection was not confirmed; projection remains pending.", { providerOutcome: published.outcome, ...(pending.outcome === "success" ? { projection: pending.value } : {}) });
    }
    const marked = this.#store.projections.markPublished(event.eventId, published.value.comment, this.#now());
    if (marked.outcome !== "success") return storageOutcome(event, marked);
    return result("published", event.eventId, event.taskId, "Lifecycle event was published.", { projection: marked.value });
  }

  public async reconcilePending(): Promise<readonly GitHubLifecycleProjectionResult[]> {
    const pending = this.#store.projections.listPending();
    if (pending.outcome !== "success") return [];
    const results: GitHubLifecycleProjectionResult[] = [];
    for (const event of pending.value) results.push(await this.publish({ ...event, timestamp: event.timestamp as UtcTimestamp }));
    return results;
  }
}
