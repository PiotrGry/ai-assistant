import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  RuntimeSqliteStore,
  type RuntimeSyncIntent,
  type RuntimeSyncIntentInput,
  type RuntimeWebhookAcceptance,
} from "../runtime/sqlite.js";
import { utcTimestamp } from "../runtime/task-domain.js";
import type { GitHubOperationOutcome } from "./outcome.js";

export const DEFAULT_GITHUB_WEBHOOK_BODY_BYTES = 1_048_576;
export const GITHUB_WEBHOOK_EVENT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  issues: ["opened", "edited", "closed", "reopened", "labeled", "unlabeled", "assigned", "unassigned", "milestoned", "demilestoned", "transferred", "locked", "unlocked"],
  issue_dependencies: ["created", "deleted"],
  projects_v2_item: ["created", "edited", "deleted", "converted", "reordered"],
  projects_v2: ["created", "edited", "deleted", "closed", "reopened"],
  projects_v2_field: ["created", "edited", "deleted"],
  repository: ["created", "deleted", "archived", "unarchived", "renamed", "transferred", "publicized", "privatized"],
  installation: ["created", "deleted", "suspend", "unsuspend", "new_permissions_accepted"],
  installation_repositories: ["added", "removed", "renamed"],
};

export type GitHubWebhookIntakeOutcome =
  | "accepted"
  | "duplicate"
  | "ignored"
  | "missing_headers"
  | "invalid_signature"
  | "body_too_large"
  | "malformed_json"
  | "invalid_payload"
  | "storage_error";

export interface GitHubWebhookIntakeResult {
  readonly outcome: GitHubWebhookIntakeOutcome;
  readonly message: string;
  readonly deliveryId?: string;
  readonly eventName?: string;
  readonly action?: string;
  readonly intents?: readonly RuntimeSyncIntent[];
}

export type GitHubWebhookHeaders = Headers | Readonly<Record<string, string | undefined>>;
export interface GitHubWebhookHandlerOptions {
  readonly secret: string;
  readonly maxBodyBytes?: number;
  readonly now?: () => string;
}

export interface GitHubWebhookIssueTarget {
  readonly owner: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueNodeId?: string;
}
export interface GitHubWebhookProjectTarget {
  readonly projectId?: string;
  readonly projectItemId?: string;
  readonly owner?: string;
  readonly repository?: string;
  readonly issueNodeId?: string;
  readonly issueNumber?: number;
}
export interface GitHubWebhookRepositoryTarget {
  readonly owner?: string;
  readonly repository?: string;
}

export type GitHubWebhookReconciliationOutcome = "reconciled" | "no_op" | "pending" | "not_found" | "provider_error" | "rate_limited" | "unknown";
export interface GitHubWebhookReconciliationResult {
  readonly outcome: GitHubWebhookReconciliationOutcome;
  readonly message: string;
  readonly providerOutcome?: GitHubOperationOutcome;
  readonly intentId?: string;
}

export interface GitHubWebhookReconciliationAdapter {
  reconcileIssue(target: GitHubWebhookIssueTarget): Promise<GitHubWebhookReconciliationResult>;
  reconcileProject(target: GitHubWebhookProjectTarget): Promise<GitHubWebhookReconciliationResult>;
  reconcileRepository?(target: GitHubWebhookRepositoryTarget): Promise<GitHubWebhookReconciliationResult>;
}

interface NormalizedWebhook {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action: string;
  readonly payloadDigest: string;
  readonly receivedAt: string;
  readonly intents: readonly RuntimeSyncIntentInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function stringValue(value: unknown, maxLength = 512): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function header(headers: GitHubWebhookHeaders, expected: string): string | undefined {
  if (headers instanceof Headers) return headers.get(expected) ?? undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === expected.toLowerCase());
  return key === undefined ? undefined : headers[key];
}
function bytesOf(rawBody: Uint8Array | string): Uint8Array {
  return typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : new Uint8Array(rawBody);
}
function validTimestamp(value: string | undefined, fallback: string): string {
  return value !== undefined && utcTimestamp(value).ok ? value : fallback;
}
function repositoryTarget(payload: Record<string, unknown>): { readonly owner?: string; readonly repository?: string } {
  const repository = isRecord(payload.repository) ? payload.repository : undefined;
  const fullName = stringValue(repository?.full_name, 300);
  if (fullName !== undefined) {
    const split = fullName.split("/");
    if (split.length === 2 && split[0] !== undefined && split[1] !== undefined) return { owner: split[0], repository: split[1] };
  }
  const name = stringValue(repository?.name, 100);
  const owner = isRecord(repository?.owner) ? stringValue(repository.owner.login, 100) : undefined;
  return { ...(owner === undefined ? {} : { owner }), ...(name === undefined ? {} : { repository: name }) };
}
function issueTarget(payload: Record<string, unknown>): GitHubWebhookIssueTarget | undefined {
  const issue = isRecord(payload.issue) ? payload.issue : undefined;
  const target = repositoryTarget(payload);
  const issueNumber = positiveNumber(issue?.number);
  if (target.owner === undefined || target.repository === undefined || issueNumber === undefined) return undefined;
  const issueNodeId = stringValue(issue?.node_id, 256);
  return { owner: target.owner, repository: target.repository, issueNumber, ...(issueNodeId === undefined ? {} : { issueNodeId }) };
}
function projectTarget(payload: Record<string, unknown>): GitHubWebhookProjectTarget {
  const item = isRecord(payload.projects_v2_item) ? payload.projects_v2_item : isRecord(payload.project_item) ? payload.project_item : undefined;
  const project = isRecord(payload.projects_v2) ? payload.projects_v2 : isRecord(payload.project) ? payload.project : undefined;
  const target = repositoryTarget(payload);
  const projectId = stringValue(item?.project_node_id, 256) ?? stringValue(project?.node_id, 256);
  const projectItemId = stringValue(item?.node_id, 256) ?? stringValue(item?.id, 256);
  const issueNodeId = stringValue(item?.content_node_id, 256) ?? stringValue(isRecord(payload.issue) ? payload.issue.node_id : undefined, 256);
  const issueNumber = positiveNumber(isRecord(payload.issue) ? payload.issue.number : undefined);
  return { ...(projectId === undefined ? {} : { projectId }), ...(projectItemId === undefined ? {} : { projectItemId }), ...(target.owner === undefined ? {} : { owner: target.owner }), ...(target.repository === undefined ? {} : { repository: target.repository }), ...(issueNodeId === undefined ? {} : { issueNodeId }), ...(issueNumber === undefined ? {} : { issueNumber }) };
}
function intentId(deliveryId: string, kind: string, target: unknown): string {
  return `webhook-${createHash("sha256").update(`${deliveryId}\u0000${kind}\u0000${JSON.stringify(target)}`).digest("hex")}`;
}
function intent(base: Omit<RuntimeSyncIntentInput, "intentId">): RuntimeSyncIntentInput {
  return { ...base, intentId: intentId(base.deliveryId, base.kind, { owner: base.owner, repository: base.repository, issueNumber: base.issueNumber, issueNodeId: base.issueNodeId, projectId: base.projectId, projectItemId: base.projectItemId }) };
}
function eventActions(eventName: string): readonly string[] | undefined {
  return GITHUB_WEBHOOK_EVENT_ACTIONS[eventName];
}
function normalize(eventName: string, deliveryId: string, action: string, payload: Record<string, unknown>, receivedAt: string, payloadDigest: string): GitHubWebhookIntakeResult & { readonly normalized?: NormalizedWebhook } {
  const supported = eventActions(eventName);
  if (supported === undefined || !supported.includes(action)) return { outcome: "ignored", message: "Webhook event/action is not supported; delivery acknowledged without an intent.", deliveryId, eventName, action, normalized: { deliveryId, eventName, action, payloadDigest, receivedAt, intents: [] } };
  const eventTimestamp = validTimestamp(stringValue(payload.updated_at, 100) ?? stringValue(isRecord(payload.issue) ? payload.issue.updated_at : undefined, 100) ?? stringValue(isRecord(payload.repository) ? payload.repository.updated_at : undefined, 100), receivedAt);
  const target = eventName === "issues" || eventName === "issue_dependencies" ? issueTarget(payload) : undefined;
  const project = eventName.startsWith("projects_v2") ? projectTarget(payload) : undefined;
  let intents: RuntimeSyncIntentInput[] = [];
  if (eventName === "issues") {
    if (target === undefined) return { outcome: "invalid_payload", message: "Supported Issue webhook did not contain a repository and Issue identity.", deliveryId, eventName, action };
    intents = [intent({ deliveryId, kind: "issue", owner: target.owner, repository: target.repository, issueNumber: target.issueNumber, ...(target.issueNodeId === undefined ? {} : { issueNodeId: target.issueNodeId }), eventName, action, eventTimestamp })];
  } else if (eventName === "issue_dependencies") {
    if (target === undefined) return { outcome: "invalid_payload", message: "Supported Issue relationship webhook did not contain an Issue identity.", deliveryId, eventName, action };
    intents = [intent({ deliveryId, kind: "issue_relationship", owner: target.owner, repository: target.repository, issueNumber: target.issueNumber, ...(target.issueNodeId === undefined ? {} : { issueNodeId: target.issueNodeId }), eventName, action, eventTimestamp })];
  } else if (eventName.startsWith("projects_v2")) {
    if (project?.projectId === undefined && project?.projectItemId === undefined) return { outcome: "invalid_payload", message: "Supported Project webhook did not contain a Project or item identity.", deliveryId, eventName, action };
    intents = [intent({ deliveryId, kind: "project", ...(project.owner === undefined ? {} : { owner: project.owner }), ...(project.repository === undefined ? {} : { repository: project.repository }), ...(project.issueNumber === undefined ? {} : { issueNumber: project.issueNumber }), ...(project.issueNodeId === undefined ? {} : { issueNodeId: project.issueNodeId }), ...(project.projectId === undefined ? {} : { projectId: project.projectId }), ...(project.projectItemId === undefined ? {} : { projectItemId: project.projectItemId }), eventName, action, eventTimestamp })];
  } else if (eventName === "repository" || eventName === "installation" || eventName === "installation_repositories") {
    const repository = repositoryTarget(payload);
    intents = [intent({ deliveryId, kind: "repository", ...(repository.owner === undefined ? {} : { owner: repository.owner }), ...(repository.repository === undefined ? {} : { repository: repository.repository }), eventName, action, eventTimestamp })];
  }
  return { outcome: "accepted", message: "Webhook authenticated and normalized.", deliveryId, eventName, action, normalized: { deliveryId, eventName, action, payloadDigest, receivedAt, intents } };
}

export class GitHubWebhookHandler {
  readonly #store: RuntimeSqliteStore;
  readonly #secret: Uint8Array;
  readonly #maxBodyBytes: number;
  readonly #now: () => string;

  public constructor(store: RuntimeSqliteStore, options: GitHubWebhookHandlerOptions) {
    if (options.secret.trim().length === 0) throw new Error("GitHub webhook secret is required outside the repository.");
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_GITHUB_WEBHOOK_BODY_BYTES;
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0 || maxBodyBytes > 10_485_760) throw new RangeError("GitHub webhook body limit must be between 1 and 10485760 bytes.");
    this.#store = store;
    this.#secret = new TextEncoder().encode(options.secret);
    this.#maxBodyBytes = maxBodyBytes;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public handle(rawBody: Uint8Array | string, headers: GitHubWebhookHeaders): GitHubWebhookIntakeResult {
    const bytes = bytesOf(rawBody);
    const eventName = header(headers, "x-github-event");
    const deliveryId = header(headers, "x-github-delivery");
    const signature = header(headers, "x-hub-signature-256");
    if (eventName === undefined || deliveryId === undefined || signature === undefined) return { outcome: "missing_headers", message: "GitHub webhook requires event, delivery, and signature headers." };
    if (bytes.byteLength > this.#maxBodyBytes) return { outcome: "body_too_large", message: "GitHub webhook body exceeds the configured byte limit.", deliveryId, eventName };
    if (!/^sha256=[0-9a-f]{64}$/u.test(signature)) return { outcome: "invalid_signature", message: "GitHub webhook signature format is invalid.", deliveryId, eventName };
    const expected = createHmac("sha256", this.#secret).update(bytes).digest();
    const supplied = Buffer.from(signature.slice("sha256=".length), "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return { outcome: "invalid_signature", message: "GitHub webhook signature is invalid.", deliveryId, eventName };
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return { outcome: "malformed_json", message: "GitHub webhook body is not valid UTF-8 JSON.", deliveryId, eventName };
    }
    if (!isRecord(payload)) return { outcome: "malformed_json", message: "GitHub webhook JSON must be an object.", deliveryId, eventName };
    const action = stringValue(payload.action, 100) ?? "none";
    const receivedAt = this.#now();
    if (!utcTimestamp(receivedAt).ok) return { outcome: "storage_error", message: "Webhook clock did not provide a canonical UTC timestamp.", deliveryId, eventName, action };
    const normalized = normalize(eventName, deliveryId, action, payload, receivedAt, createHash("sha256").update(bytes).digest("hex"));
    if (normalized.normalized === undefined) return normalized;
    const delivery = { deliveryId, eventName, action, payloadDigest: normalized.normalized.payloadDigest, status: normalized.outcome === "accepted" ? "accepted" as const : "ignored" as const, receivedAt, createdAt: receivedAt, updatedAt: receivedAt };
    const stored = this.#store.webhooks.accept(delivery, normalized.normalized.intents);
    if (stored.outcome !== "success") return { outcome: "storage_error", message: stored.message, deliveryId, eventName, action };
    return this.#resultFromAcceptance(normalized.outcome === "accepted" ? "accepted" : "ignored", stored.value, eventName, action);
  }

  #resultFromAcceptance(outcome: "accepted" | "ignored", acceptance: RuntimeWebhookAcceptance, eventName: string, action: string): GitHubWebhookIntakeResult {
    return { outcome: acceptance.duplicate ? "duplicate" : outcome, message: acceptance.duplicate ? "Webhook delivery was already accepted; no duplicate intent was created." : outcome === "accepted" ? "Webhook delivery and synchronization intent were durably accepted." : "Webhook event was durably acknowledged as ignored.", deliveryId: acceptance.delivery.deliveryId, eventName, action, intents: acceptance.intents };
  }
}

export class GitHubWebhookReconciliationService {
  readonly #store: RuntimeSqliteStore;
  readonly #adapter: GitHubWebhookReconciliationAdapter;
  readonly #now: () => string;

  public constructor(store: RuntimeSqliteStore, adapter: GitHubWebhookReconciliationAdapter, options: { readonly now?: () => string } = {}) {
    this.#store = store;
    this.#adapter = adapter;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public async startup(): Promise<readonly GitHubWebhookReconciliationResult[]> {
    const pending = this.#store.webhooks.listPendingIntents();
    if (pending.outcome !== "success") return [{ outcome: "provider_error", message: pending.message }];
    const results: GitHubWebhookReconciliationResult[] = [];
    for (const intent of pending.value) results.push(await this.#reconcileIntent(intent));
    return results;
  }

  public async reconcileIssue(target: GitHubWebhookIssueTarget): Promise<GitHubWebhookReconciliationResult> {
    return this.#adapter.reconcileIssue(target);
  }

  public async reconcileProject(target: GitHubWebhookProjectTarget): Promise<GitHubWebhookReconciliationResult> {
    return this.#adapter.reconcileProject(target);
  }

  public async afterUnknownWrite(target: GitHubWebhookIssueTarget | GitHubWebhookProjectTarget): Promise<GitHubWebhookReconciliationResult> {
    return "issueNumber" in target && target.issueNumber !== undefined && target.owner !== undefined && target.repository !== undefined
      ? this.#adapter.reconcileIssue({ owner: target.owner, repository: target.repository, issueNumber: target.issueNumber, ...(target.issueNodeId === undefined ? {} : { issueNodeId: target.issueNodeId }) })
      : this.#adapter.reconcileProject(target);
  }

  public async reconcileIntent(intentId: string): Promise<GitHubWebhookReconciliationResult> {
    const stored = this.#store.webhooks.getIntent(intentId);
    if (stored.outcome !== "success") return { outcome: "not_found", message: stored.message, intentId };
    return this.#reconcileIntent(stored.value);
  }

  async #reconcileIntent(intent: RuntimeSyncIntent): Promise<GitHubWebhookReconciliationResult> {
    let result: GitHubWebhookReconciliationResult;
    if (intent.kind === "issue" || intent.kind === "issue_relationship") {
      if (intent.owner === undefined || intent.repository === undefined || intent.issueNumber === undefined) return { outcome: "not_found", message: "Issue intent has no complete target.", intentId: intent.intentId };
      result = await this.#adapter.reconcileIssue({ owner: intent.owner, repository: intent.repository, issueNumber: intent.issueNumber, ...(intent.issueNodeId === undefined ? {} : { issueNodeId: intent.issueNodeId }) });
    } else if (intent.kind === "project") {
      result = await this.#adapter.reconcileProject({ ...(intent.projectId === undefined ? {} : { projectId: intent.projectId }), ...(intent.projectItemId === undefined ? {} : { projectItemId: intent.projectItemId }), ...(intent.owner === undefined ? {} : { owner: intent.owner }), ...(intent.repository === undefined ? {} : { repository: intent.repository }), ...(intent.issueNodeId === undefined ? {} : { issueNodeId: intent.issueNodeId }), ...(intent.issueNumber === undefined ? {} : { issueNumber: intent.issueNumber }) });
    } else if (this.#adapter.reconcileRepository !== undefined) {
      result = await this.#adapter.reconcileRepository({ ...(intent.owner === undefined ? {} : { owner: intent.owner }), ...(intent.repository === undefined ? {} : { repository: intent.repository }) });
    } else {
      result = { outcome: "not_found", message: "No repository reconciliation adapter is configured." };
    }
    const terminal = result.outcome === "reconciled" || result.outcome === "no_op";
    const stored = terminal ? this.#store.webhooks.markReconciled(intent.intentId, this.#now()) : this.#store.webhooks.markPending(intent.intentId, result.message, this.#now());
    if (stored.outcome !== "success") return { outcome: "provider_error", message: stored.message, intentId: intent.intentId };
    return { ...result, intentId: intent.intentId };
  }
}
