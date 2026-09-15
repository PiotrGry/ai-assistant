import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { GitHubConfig } from "./config.js";
import {
  GitHubActionsGateway,
  type GitHubActionsFailedJobReference,
  type GitHubActionsReadGateway,
  type GitHubActionsWatchRequest,
  type GitHubActionsWatchResult,
} from "./ci-watch.js";
import { failure, success, type GitHubOperationResult } from "./outcome.js";
import { executeWithGitHubRetry, type GitHubRetryPolicyOptions } from "./retry-policy.js";
import type { GitHubRequestContext, GitHubRestReadRequest, GitHubRestWriteRequest } from "./transport-types.js";
import { GitHubWriteQueue } from "./write-queue.js";

export const SHIPMENT_POC_FEATURE_BASE = "develop" as const;
export const SHIPMENT_POC_RELEASE_BASE = "main" as const;
export const SHIPMENT_POC_REPOSITORY = "PiotrGry/zdrovena-reconciliation" as const;
export const SHIPMENT_POC_FEATURE_WORKFLOW = "Develop — Fast Gate" as const;
export const SHIPMENT_POC_RELEASE_WORKFLOW = "PR Validate — develop → main" as const;

export type GitHubShipmentPocOutcome =
  | "production_approval_required"
  | "feature_ci_failed"
  | "release_ci_failed"
  | "pending_or_timeout"
  | "stale_head"
  | "not_found"
  | "ambiguous"
  | "policy_blocked"
  | "authorization_required"
  | "rate_limited"
  | "provider_error"
  | "unknown";

export interface GitHubShipmentPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly title?: string;
  readonly body?: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly merged: boolean;
  readonly mergeCommitSha?: string;
}

export interface GitHubShipmentBranchHead {
  readonly branch: string;
  readonly sha: string;
}

export interface GitHubShipmentCreatePullRequestRequest {
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly timeoutMs?: number;
}

export interface GitHubShipmentMergeResult {
  readonly merged: boolean;
  readonly sha?: string;
  readonly message?: string;
}

export interface GitHubShipmentPocGatewayPort extends GitHubActionsReadGateway {
  getBranchHead(branch: string, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubShipmentBranchHead>>;
  listPullRequests(
    headBranch: string,
    baseBranch: string,
    context: GitHubRequestContext,
  ): Promise<GitHubOperationResult<readonly GitHubShipmentPullRequest[]>>;
  getPullRequest(number: number, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubShipmentPullRequest>>;
  createPullRequest(request: GitHubShipmentCreatePullRequestRequest): Promise<GitHubOperationResult<GitHubShipmentPullRequest>>;
  mergePullRequest(
    number: number,
    expectedHeadSha: string,
    request: { readonly idempotencyKey: string; readonly correlationId: string; readonly timeoutMs?: number },
  ): Promise<GitHubOperationResult<GitHubShipmentMergeResult>>;
}

export interface GitHubShipmentPocRecord {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly owner: string;
  readonly repository: string;
  readonly featureBase: typeof SHIPMENT_POC_FEATURE_BASE;
  readonly releaseBase: typeof SHIPMENT_POC_RELEASE_BASE;
  readonly headBranch: string;
  readonly expectedHeadSha: string;
  readonly featurePullRequestNumber?: number;
  readonly featurePullRequestUrl?: string;
  readonly featureHeadSha?: string;
  readonly featureRunId?: number;
  readonly featureConclusion?: string;
  readonly featureMergeSha?: string;
  readonly developHeadSha?: string;
  readonly releasePullRequestNumber?: number;
  readonly releasePullRequestUrl?: string;
  readonly releaseHeadSha?: string;
  readonly releaseRunId?: number;
  readonly releaseConclusion?: string;
  readonly outcome?: GitHubShipmentPocOutcome;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly terminalAt?: string;
  readonly updatedAt: string;
}

export interface GitHubShipmentPocStore {
  get(eventId: string): Promise<GitHubShipmentPocRecord | undefined>;
  save(record: GitHubShipmentPocRecord): Promise<void>;
}

export class InMemoryGitHubShipmentPocStore implements GitHubShipmentPocStore {
  readonly #records = new Map<string, GitHubShipmentPocRecord>();

  async get(eventId: string): Promise<GitHubShipmentPocRecord | undefined> {
    return this.#records.get(eventId);
  }

  async save(record: GitHubShipmentPocRecord): Promise<void> {
    this.#records.set(record.eventId, record);
  }
}

/** A small 0600 JSON ledger. It contains only bounded GitHub identities and conclusions. */
export class FileGitHubShipmentPocStore implements GitHubShipmentPocStore {
  readonly #filename: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(filename: string) {
    if (filename.trim().length === 0) throw new RangeError("Shipment POC state filename is required.");
    this.#filename = filename;
  }

  async get(eventId: string): Promise<GitHubShipmentPocRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.#filename, "utf8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.records)) return undefined;
      const record = parsed.records[eventId];
      return isRecord(record) ? (record as unknown as GitHubShipmentPocRecord) : undefined;
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async save(record: GitHubShipmentPocRecord): Promise<void> {
    const write = this.#writeChain.then(async () => {
      let records: Record<string, GitHubShipmentPocRecord> = {};
      try {
        const parsed = JSON.parse(await readFile(this.#filename, "utf8")) as unknown;
        if (isRecord(parsed) && isRecord(parsed.records)) records = parsed.records as unknown as Record<string, GitHubShipmentPocRecord>;
      } catch (error: unknown) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      records[record.eventId] = record;
      await mkdir(dirname(this.#filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.#filename}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, records }), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#filename);
      await chmod(this.#filename, 0o600);
    });
    this.#writeChain = write.catch(() => undefined);
    await write;
  }
}

interface RestRefPayload { readonly object?: unknown; }
interface RestPullRequestPayload {
  readonly number?: unknown;
  readonly html_url?: unknown;
  readonly state?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly head?: unknown;
  readonly base?: unknown;
  readonly merged?: unknown;
  readonly merge_commit_sha?: unknown;
}
interface RestMergePayload { readonly merged?: unknown; readonly sha?: unknown; readonly message?: unknown; }

const DEFAULT_RETRY: GitHubRetryPolicyOptions = { maxAttempts: 2, maxTotalDelayMs: 5_000, baseDelayMs: 250, maxDelayMs: 2_000, jitterRatio: 0 };

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isNodeError(value: unknown, code: string): boolean { return isRecord(value) && value.code === code; }
function text(value: unknown, max = 512): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined; }
function url(value: unknown): string | undefined { const candidate = text(value, 512); return candidate !== undefined && /^https:\/\//u.test(candidate) ? candidate : undefined; }
function positive(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
function sha(value: unknown): string | undefined { const candidate = text(value, 128); return candidate !== undefined && /^[A-Za-z0-9._-]+$/u.test(candidate) ? candidate : undefined; }
function repositoryPath(config: GitHubConfig): string { return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`; }
function malformed<T>(correlationId: string): GitHubOperationResult<T> { return failure("permanent_error", "malformed_response", "GitHub returned malformed shipment data.", correlationId, "not_accepted"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function marker(eventId: string): string { return `<!-- pirx-shipment-poc:v1 event=${digest(eventId)} -->`; }

function mapPullRequest(value: unknown): GitHubShipmentPullRequest | undefined {
  if (!isRecord(value)) return undefined;
  const number = positive(value.number);
  const pullUrl = url(value.html_url);
  const state = value.state === "open" || value.state === "closed" ? value.state : undefined;
  const head = isRecord(value.head) ? value.head : undefined;
  const base = isRecord(value.base) ? value.base : undefined;
  const headBranch = text(head?.ref, 256);
  const headSha = sha(head?.sha);
  const baseBranch = text(base?.ref, 256);
  if (number === undefined || pullUrl === undefined || state === undefined || headBranch === undefined || headSha === undefined || baseBranch === undefined) return undefined;
  const body = value.body === null ? undefined : text(value.body, 65_536);
  const title = text(value.title, 512);
  const mergeCommitSha = sha(value.merge_commit_sha);
  return {
    number,
    url: pullUrl,
    state,
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
    headBranch,
    headSha,
    baseBranch,
    merged: value.merged === true,
    ...(mergeCommitSha === undefined ? {} : { mergeCommitSha }),
  };
}

function contextOf(correlationId: string, context: GitHubRequestContext): GitHubRequestContext { return { correlationId, ...(context.signal === undefined ? {} : { signal: context.signal }), ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }) }; }

export class GitHubShipmentPocGateway implements GitHubShipmentPocGatewayPort {
  readonly #transport: GitHubShipmentPocTransport;
  readonly #config: GitHubConfig;
  readonly #queue: GitHubWriteQueue;
  readonly #retryPolicy: GitHubRetryPolicyOptions;
  readonly #actions: GitHubActionsReadGateway;

  constructor(transport: GitHubShipmentPocTransport, config: GitHubConfig, queue = new GitHubWriteQueue(), options: { readonly retryPolicy?: GitHubRetryPolicyOptions } = {}) {
    this.#transport = transport;
    this.#config = config;
    this.#queue = queue;
    this.#retryPolicy = { ...DEFAULT_RETRY, ...options.retryPolicy };
    this.#actions = new GitHubActionsGateway(transport, config, { retryPolicy: this.#retryPolicy });
  }

  getWorkflowRun(runId: number, context: GitHubRequestContext) { return this.#actions.getWorkflowRun(runId, context); }
  listWorkflowRunsForPullRequest(pullRequestNumber: number, context: GitHubRequestContext) { return this.#actions.listWorkflowRunsForPullRequest(pullRequestNumber, context); }
  listWorkflowRunJobs(runId: number, context: GitHubRequestContext) { return this.#actions.listWorkflowRunJobs(runId, context); }

  async getBranchHead(branch: string, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubShipmentBranchHead>> {
    const result = await this.#read<RestRefPayload>({ method: "GET", path: `${repositoryPath(this.#config)}/git/ref/heads/${encodeURIComponent(branch)}` }, context);
    if (result.outcome !== "success") return result;
    const object = isRecord(result.value.object) ? result.value.object : undefined;
    const value = sha(object?.sha);
    return value === undefined ? malformed(result.correlationId) : { ...result, value: { branch, sha: value } };
  }

  async listPullRequests(headBranch: string, baseBranch: string, context: GitHubRequestContext): Promise<GitHubOperationResult<readonly GitHubShipmentPullRequest[]>> {
    const result = await this.#read<unknown[]>({ method: "GET", path: `${repositoryPath(this.#config)}/pulls`, query: { head: `${this.#config.owner}:${headBranch}`, base: baseBranch, state: "open", per_page: 100 } }, context);
    if (result.outcome !== "success") return result;
    if (!Array.isArray(result.value)) return malformed(result.correlationId);
    const mapped = result.value.map(mapPullRequest);
    return mapped.some((item) => item === undefined) ? malformed(result.correlationId) : { ...result, value: mapped as GitHubShipmentPullRequest[] };
  }

  async getPullRequest(number: number, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubShipmentPullRequest>> {
    const result = await this.#read<RestPullRequestPayload>({ method: "GET", path: `${repositoryPath(this.#config)}/pulls/${number}` }, context);
    if (result.outcome !== "success") return result;
    const pull = mapPullRequest(result.value);
    return pull === undefined ? malformed(result.correlationId) : { ...result, value: pull };
  }

  async createPullRequest(request: GitHubShipmentCreatePullRequestRequest): Promise<GitHubOperationResult<GitHubShipmentPullRequest>> {
    const correlationId = request.correlationId || randomUUID();
    const payload = { title: request.title, head: request.headBranch, base: request.baseBranch, body: request.body };
    const result = await this.#queue.submit<RestPullRequestPayload>({
      operationKind: "shipment_poc_create_pull_request",
      idempotencyKey: request.idempotencyKey,
      target: `repository:${this.#config.owner}/${this.#config.repository}`,
      correlationId,
      payloadIdentity: digest(JSON.stringify(payload)),
      timeoutMs: request.timeoutMs ?? this.#config.timeoutMs,
      idempotent: true,
      execute: (context) => this.#transport.restWrite<RestPullRequestPayload>({ method: "POST", path: `${repositoryPath(this.#config)}/pulls`, body: payload }, context),
    });
    if (result.outcome !== "success") return result as GitHubOperationResult<GitHubShipmentPullRequest>;
    const pull = mapPullRequest(result.value);
    return pull === undefined ? failure("unknown", "malformed_response", "GitHub accepted the PR but returned no usable identity.", result.correlationId, "unknown") : { ...result, value: pull };
  }

  async mergePullRequest(number: number, expectedHeadSha: string, request: { readonly idempotencyKey: string; readonly correlationId: string; readonly timeoutMs?: number }): Promise<GitHubOperationResult<GitHubShipmentMergeResult>> {
    const result = await this.#queue.submit<RestMergePayload>({
      operationKind: "shipment_poc_merge_feature_pull_request",
      idempotencyKey: request.idempotencyKey,
      target: `pull:${this.#config.owner}/${this.#config.repository}#${number}`,
      correlationId: request.correlationId,
      payloadIdentity: expectedHeadSha,
      timeoutMs: request.timeoutMs ?? this.#config.timeoutMs,
      idempotent: true,
      execute: (context) => this.#transport.restWrite<RestMergePayload>({ method: "PUT", path: `${repositoryPath(this.#config)}/pulls/${number}/merge`, body: { sha: expectedHeadSha, merge_method: "squash" } }, context),
    });
    if (result.outcome !== "success") return result as GitHubOperationResult<GitHubShipmentMergeResult>;
    if (result.value.merged !== true) return failure("permanent_error", "conflict", text(result.value.message, 256) ?? "GitHub did not merge the feature PR.", result.correlationId, "not_accepted", result.response);
    const mergedSha = sha(result.value.sha);
    const mergeMessage = text(result.value.message, 256);
    return { ...result, value: { merged: true, ...(mergedSha === undefined ? {} : { sha: mergedSha }), ...(mergeMessage === undefined ? {} : { message: mergeMessage }) } };
  }

  async close(): Promise<void> { await this.#queue.close({ drain: true }); }

  async #read<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    const decision = await executeWithGitHubRetry<T>({ operation: "read", correlationId: context.correlationId, ...(context.signal === undefined ? {} : { signal: context.signal }), execute: ({ signal }) => this.#transport.restRead<T>(request, contextOf(context.correlationId, { ...context, ...(signal === undefined ? {} : { signal }) })) }, this.#retryPolicy);
    return decision.finalOutcome;
  }
}

export interface GitHubShipmentPocTransport {
  restRead<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
  restWrite<T>(request: GitHubRestWriteRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>>;
}

export interface GitHubShipmentPocWatcher {
  watch(request: GitHubActionsWatchRequest): Promise<GitHubActionsWatchResult>;
}

export interface GitHubShipmentPocRequest {
  readonly eventId: string;
  readonly headBranch: string;
  readonly expectedHeadSha: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxFailedJobs?: number;
  readonly maxFailedSteps?: number;
  readonly correlationId?: string;
  readonly signal?: AbortSignal;
}

export interface GitHubShipmentPocEvidence {
  readonly featurePullRequest?: { readonly number: number; readonly url: string; readonly headSha: string; readonly runId?: number; readonly conclusion?: string; readonly failedJobs?: readonly GitHubActionsFailedJobReference[]; readonly failedJobsErrorCode?: string };
  readonly releasePullRequest?: { readonly number: number; readonly url: string; readonly headSha: string; readonly runId?: number; readonly conclusion?: string; readonly failedJobs?: readonly GitHubActionsFailedJobReference[]; readonly failedJobsErrorCode?: string };
  readonly developHeadSha?: string;
  readonly mergeSha?: string;
}

export interface GitHubShipmentPocResult {
  readonly outcome: GitHubShipmentPocOutcome;
  readonly repository: typeof SHIPMENT_POC_REPOSITORY;
  readonly featureBase: typeof SHIPMENT_POC_FEATURE_BASE;
  readonly releaseBase: typeof SHIPMENT_POC_RELEASE_BASE;
  readonly eventId: string;
  readonly headBranch: string;
  readonly expectedHeadSha: string;
  readonly correlationId: string;
  readonly message: string;
  readonly errorCode?: string;
  readonly evidence: GitHubShipmentPocEvidence;
  readonly replayed: boolean;
  readonly updatedAt: string;
}

function validRequest(request: GitHubShipmentPocRequest): string | undefined {
  if (!/^pirx\/poc-[A-Za-z0-9._/-]{1,120}$/u.test(request.headBranch)) return "Only a dedicated pirx/poc-* branch is allowed.";
  if (!/^[A-Za-z0-9._-]{4,128}$/u.test(request.expectedHeadSha)) return "expectedHeadSha is invalid.";
  if (request.eventId.trim().length === 0 || request.eventId.length > 256 || /[\u0000-\u001f\u007f]/u.test(request.eventId)) return "eventId is invalid.";
  const timeout = request.timeoutMs ?? 60_000;
  const poll = request.pollIntervalMs ?? 2_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 300_000 || !Number.isSafeInteger(poll) || poll <= 0 || poll > 60_000) return "Watch settings exceed the bounded limits.";
  return undefined;
}

function resultFromFailure(request: GitHubShipmentPocRequest, correlationId: string, result: Exclude<GitHubOperationResult<unknown>, { outcome: "success" }>, evidence: GitHubShipmentPocEvidence, replayed: boolean): GitHubShipmentPocResult {
  const outcome: GitHubShipmentPocOutcome = result.outcome === "rate_limited" || result.error.code === "rate_limited" ? "rate_limited" : result.outcome === "unknown" ? "unknown" : result.error.code === "not_found" ? "not_found" : result.error.code === "conflict" ? "ambiguous" : result.error.code === "timeout" || result.error.code === "cancelled" ? "pending_or_timeout" : "provider_error";
  return { outcome, repository: SHIPMENT_POC_REPOSITORY, featureBase: SHIPMENT_POC_FEATURE_BASE, releaseBase: SHIPMENT_POC_RELEASE_BASE, eventId: request.eventId, headBranch: request.headBranch, expectedHeadSha: request.expectedHeadSha, correlationId, message: result.error.message, errorCode: result.error.code, evidence, replayed, updatedAt: new Date().toISOString() };
}

function resultFromWatch(request: GitHubShipmentPocRequest, watch: GitHubActionsWatchResult, phase: "feature" | "release", evidence: GitHubShipmentPocEvidence, replayed: boolean): GitHubShipmentPocResult | undefined {
  if (watch.outcome === "success") return undefined;
  const outcome: GitHubShipmentPocOutcome = watch.outcome === "failed" ? phase === "feature" ? "feature_ci_failed" : "release_ci_failed" : watch.outcome === "timeout" || watch.outcome === "cancelled" ? "pending_or_timeout" : watch.outcome === "not_found" ? "not_found" : watch.outcome === "ambiguous" ? "ambiguous" : watch.outcome === "rate_limited" ? "rate_limited" : "provider_error";
  const item = phase === "feature" ? evidence.featurePullRequest : evidence.releasePullRequest;
  const phaseEvidence = item === undefined ? {} : { [phase === "feature" ? "featurePullRequest" : "releasePullRequest"]: { ...item, ...(watch.workflowRunId === undefined ? {} : { runId: watch.workflowRunId }), ...(watch.outcome === "failed" ? { conclusion: watch.conclusion, ...(watch.failedJobs === undefined ? {} : { failedJobs: watch.failedJobs }), ...(watch.failedJobsErrorCode === undefined ? {} : { failedJobsErrorCode: watch.failedJobsErrorCode }) } : {}) } };
  const message = watch.outcome === "failed"
    ? `GitHub Actions ${phase} CI concluded ${watch.conclusion}.`
    : `GitHub Actions ${phase} watch ended with ${watch.outcome}.`;
  return { outcome, repository: SHIPMENT_POC_REPOSITORY, featureBase: SHIPMENT_POC_FEATURE_BASE, releaseBase: SHIPMENT_POC_RELEASE_BASE, eventId: request.eventId, headBranch: request.headBranch, expectedHeadSha: request.expectedHeadSha, correlationId: request.correlationId?.trim() || watch.workflowRunId?.toString() || randomUUID(), message, errorCode: "errorCode" in watch ? watch.errorCode : watch.outcome, evidence: { ...evidence, ...phaseEvidence }, replayed, updatedAt: new Date().toISOString() };
}

function watchRequest(
  pullRequestNumber: number,
  expectedHeadSha: string,
  request: GitHubShipmentPocRequest,
  correlationId: string,
  requiredWorkflowName: string,
): GitHubActionsWatchRequest {
  return {
    pullRequestNumber,
    expectedHeadSha,
    requiredWorkflowName,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.pollIntervalMs === undefined ? {} : { pollIntervalMs: request.pollIntervalMs }),
    ...(request.maxFailedJobs === undefined ? {} : { maxFailedJobs: request.maxFailedJobs }),
    ...(request.maxFailedSteps === undefined ? {} : { maxFailedSteps: request.maxFailedSteps }),
    correlationId,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  };
}

function pullEvidence(pull: GitHubShipmentPullRequest): { number: number; url: string; headSha: string } { return { number: pull.number, url: pull.url, headSha: pull.headSha }; }

export class GitHubShipmentPoc {
  readonly #gateway: GitHubShipmentPocGatewayPort;
  readonly #watcher: GitHubShipmentPocWatcher;
  readonly #store: GitHubShipmentPocStore;
  readonly #config: GitHubConfig;

  constructor(gateway: GitHubShipmentPocGatewayPort, watcher: GitHubShipmentPocWatcher, store: GitHubShipmentPocStore = new InMemoryGitHubShipmentPocStore(), config: GitHubConfig = { token: "", owner: "PiotrGry", repository: "zdrovena-reconciliation", apiUrl: "https://api.github.com", timeoutMs: 10_000 }) {
    this.#gateway = gateway;
    this.#watcher = watcher;
    this.#store = store;
    this.#config = config;
  }

  async execute(request: GitHubShipmentPocRequest): Promise<GitHubShipmentPocResult> {
    const correlationId = request.correlationId?.trim() || randomUUID();
    const invalidRequest = validRequest(request);
    if (invalidRequest !== undefined) return this.#result(request, correlationId, "policy_blocked", invalidRequest, "invalid_request", {}, false);
    if (this.#config.owner !== "PiotrGry" || this.#config.repository !== "zdrovena-reconciliation") return this.#result(request, correlationId, "policy_blocked", "Shipment POC target is fixed to PiotrGry/zdrovena-reconciliation.", "target_not_allowed", {}, false);
    const existing = await this.#store.get(request.eventId);
    const replayed = existing !== undefined;
    if (existing !== undefined && (existing.headBranch !== request.headBranch || existing.expectedHeadSha !== request.expectedHeadSha)) return this.#result(request, correlationId, "policy_blocked", "eventId is already bound to a different branch or revision.", "event_conflict", {}, true);
    if (existing !== undefined && (existing.owner !== this.#config.owner || existing.repository !== this.#config.repository || existing.featureBase !== SHIPMENT_POC_FEATURE_BASE || existing.releaseBase !== SHIPMENT_POC_RELEASE_BASE)) return this.#result(request, correlationId, "policy_blocked", "Persisted shipment record does not match the fixed target policy.", "target_not_allowed", {}, true);
    let evidence: GitHubShipmentPocEvidence = {};
    let persisted = existing;
    const save = async (patch: Partial<GitHubShipmentPocRecord>): Promise<void> => {
      const now = new Date().toISOString();
      persisted = { schemaVersion: 1, eventId: request.eventId, owner: this.#config.owner, repository: this.#config.repository, featureBase: SHIPMENT_POC_FEATURE_BASE, releaseBase: SHIPMENT_POC_RELEASE_BASE, headBranch: request.headBranch, expectedHeadSha: request.expectedHeadSha, correlationId, createdAt: persisted?.createdAt ?? now, ...persisted, ...patch, ...(patch.outcome === undefined ? {} : { terminalAt: now }), updatedAt: now };
      await this.#store.save(persisted);
    };
    await save({});
    const context = (): GitHubRequestContext => ({ correlationId, ...(request.signal === undefined ? {} : { signal: request.signal }), timeoutMs: this.#config.timeoutMs });

    const branch = await this.#gateway.getBranchHead(request.headBranch, context());
    if (branch.outcome !== "success") return this.#finish(request, correlationId, resultFromFailure(request, correlationId, branch, evidence, replayed), save);
    if (branch.value.sha !== request.expectedHeadSha) return this.#finish(request, correlationId, this.#result(request, correlationId, "stale_head", "Dedicated branch head does not match the CODE_PUSHED revision.", "stale_head", evidence, replayed), save);

    const feature = await this.#findOrCreatePull({
      eventId: request.eventId,
      headBranch: request.headBranch,
      baseBranch: SHIPMENT_POC_FEATURE_BASE,
      expectedHeadSha: request.expectedHeadSha,
      ...(existing?.featurePullRequestNumber === undefined ? {} : { knownNumber: existing.featurePullRequestNumber }),
      correlationId,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (feature.outcome !== "success") return this.#finish(request, correlationId, resultFromFailure(request, correlationId, feature, evidence, replayed), save);
    evidence = { ...evidence, featurePullRequest: pullEvidence(feature.value) };
    await save({ featurePullRequestNumber: feature.value.number, featurePullRequestUrl: feature.value.url, featureHeadSha: feature.value.headSha });
    if (feature.value.headSha !== request.expectedHeadSha) return this.#finish(request, correlationId, this.#result(request, correlationId, "stale_head", "Feature PR head changed before CI observation.", "stale_head", evidence, replayed), save);

    if (!feature.value.merged) {
      const watch = await this.#watcher.watch(watchRequest(feature.value.number, request.expectedHeadSha, request, correlationId, SHIPMENT_POC_FEATURE_WORKFLOW));
      const failed = resultFromWatch(request, watch, "feature", evidence, replayed);
      if (failed !== undefined) {
        const runId = watch.workflowRunId;
        const conclusion = watch.outcome === "failed" ? watch.conclusion : undefined;
        return this.#finish(request, correlationId, failed, save, { ...(runId === undefined ? {} : { featureRunId: runId }), ...(conclusion === undefined ? {} : { featureConclusion: conclusion }) });
      }
      if (watch.outcome !== "success" || watch.testedRevision !== request.expectedHeadSha) return this.#finish(request, correlationId, this.#result(request, correlationId, "unknown", "Feature CI did not provide exact successful evidence.", "ci_evidence", evidence, replayed), save);
      const featureRunId = watch.workflowRunId;
      const featureConclusion = watch.conclusion;
      evidence = { ...evidence, featurePullRequest: { ...evidence.featurePullRequest!, ...(featureRunId === undefined ? {} : { runId: featureRunId }), ...(featureConclusion === undefined ? {} : { conclusion: featureConclusion }) } };
      await save({ ...(featureRunId === undefined ? {} : { featureRunId }), ...(featureConclusion === undefined ? {} : { featureConclusion }) });
      const beforeMerge = await this.#gateway.getPullRequest(feature.value.number, context());
      if (beforeMerge.outcome !== "success") return this.#finish(request, correlationId, resultFromFailure(request, correlationId, beforeMerge, evidence, replayed), save);
      if (beforeMerge.value.state !== "open" || beforeMerge.value.merged || beforeMerge.value.headSha !== request.expectedHeadSha || beforeMerge.value.baseBranch !== SHIPMENT_POC_FEATURE_BASE) return this.#finish(request, correlationId, this.#result(request, correlationId, "stale_head", "Feature PR changed after CI and before merge.", "stale_head", evidence, replayed), save);
      const merge = await this.#gateway.mergePullRequest(feature.value.number, request.expectedHeadSha, { idempotencyKey: `shipment:${request.eventId}:feature-merge`, correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) });
      if (merge.outcome !== "success") {
        const reconciled = await this.#gateway.getPullRequest(feature.value.number, context());
        if (reconciled.outcome === "success" && reconciled.value.merged && reconciled.value.mergeCommitSha !== undefined) evidence = { ...evidence, mergeSha: reconciled.value.mergeCommitSha };
        else return this.#finish(request, correlationId, resultFromFailure(request, correlationId, merge, evidence, replayed), save);
      } else if (merge.value.sha !== undefined) evidence = { ...evidence, mergeSha: merge.value.sha };
    }

    const mergedFeature = await this.#gateway.getPullRequest(feature.value.number, context());
    if (mergedFeature.outcome !== "success") return this.#finish(request, correlationId, resultFromFailure(request, correlationId, mergedFeature, evidence, replayed), save);
    if (!mergedFeature.value.merged || mergedFeature.value.headSha !== request.expectedHeadSha) return this.#finish(request, correlationId, this.#result(request, correlationId, "stale_head", "Feature PR merge could not be verified at the expected head.", "merge_verification", evidence, replayed), save);
    const develop = await this.#gateway.getBranchHead(SHIPMENT_POC_FEATURE_BASE, context());
    if (develop.outcome !== "success") return this.#finish(request, correlationId, resultFromFailure(request, correlationId, develop, evidence, replayed), save);
    const mergeSha = evidence.mergeSha ?? mergedFeature.value.mergeCommitSha;
    evidence = { ...evidence, developHeadSha: develop.value.sha, ...(mergeSha === undefined ? {} : { mergeSha }) };
    await save({ developHeadSha: develop.value.sha, ...(mergeSha === undefined ? {} : { featureMergeSha: mergeSha }) });

    const currentDevelop = await this.#gateway.getBranchHead(SHIPMENT_POC_FEATURE_BASE, context());
    if (currentDevelop.outcome !== "success") return this.#finish(request, correlationId, resultFromFailure(request, correlationId, currentDevelop, evidence, replayed), save);
    if (currentDevelop.value.sha !== develop.value.sha) return this.#finish(request, correlationId, this.#result(request, correlationId, "stale_head", "develop changed before release CI observation.", "stale_head", evidence, replayed), save);
    const release = await this.#findOrCreatePull({
      eventId: request.eventId,
      headBranch: SHIPMENT_POC_FEATURE_BASE,
      baseBranch: SHIPMENT_POC_RELEASE_BASE,
      expectedHeadSha: develop.value.sha,
      ...(existing?.releasePullRequestNumber === undefined ? {} : { knownNumber: existing.releasePullRequestNumber }),
      correlationId,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (release.outcome !== "success") return this.#finish(request, correlationId, resultFromFailure(request, correlationId, release, evidence, replayed), save);
    evidence = { ...evidence, releasePullRequest: pullEvidence(release.value) };
    await save({ releasePullRequestNumber: release.value.number, releasePullRequestUrl: release.value.url, releaseHeadSha: release.value.headSha });
    if (release.value.state !== "open" || release.value.merged) return this.#finish(request, correlationId, this.#result(request, correlationId, "policy_blocked", "Release PR must remain open; merging the release PR is forbidden in this POC.", "release_merge_forbidden", evidence, replayed), save);
    if (release.value.headBranch !== SHIPMENT_POC_FEATURE_BASE || release.value.baseBranch !== SHIPMENT_POC_RELEASE_BASE || release.value.headSha !== develop.value.sha) return this.#finish(request, correlationId, this.#result(request, correlationId, "stale_head", "Release PR does not point from develop at the current develop head to main.", "stale_head", evidence, replayed), save);
    const releaseDevelop = await this.#gateway.getBranchHead(SHIPMENT_POC_FEATURE_BASE, context());
    if (releaseDevelop.outcome !== "success") return this.#finish(request, correlationId, resultFromFailure(request, correlationId, releaseDevelop, evidence, replayed), save);
    if (releaseDevelop.value.sha !== develop.value.sha) return this.#finish(request, correlationId, this.#result(request, correlationId, "stale_head", "develop changed before release CI completed its identity checks.", "stale_head", evidence, replayed), save);
    const releaseWatch = await this.#watcher.watch(watchRequest(release.value.number, develop.value.sha, request, correlationId, SHIPMENT_POC_RELEASE_WORKFLOW));
    const releaseFailed = resultFromWatch(request, releaseWatch, "release", evidence, replayed);
    if (releaseFailed !== undefined) {
      const runId = releaseWatch.workflowRunId;
      const conclusion = releaseWatch.outcome === "failed" ? releaseWatch.conclusion : undefined;
      return this.#finish(request, correlationId, releaseFailed, save, { ...(runId === undefined ? {} : { releaseRunId: runId }), ...(conclusion === undefined ? {} : { releaseConclusion: conclusion }) });
    }
    if (releaseWatch.outcome !== "success" || releaseWatch.testedRevision !== develop.value.sha) return this.#finish(request, correlationId, this.#result(request, correlationId, "unknown", "Release CI did not provide exact successful evidence.", "ci_evidence", evidence, replayed), save);
    const releaseRunId = releaseWatch.workflowRunId;
    const releaseConclusion = releaseWatch.conclusion;
    evidence = { ...evidence, releasePullRequest: { ...evidence.releasePullRequest!, ...(releaseRunId === undefined ? {} : { runId: releaseRunId }), ...(releaseConclusion === undefined ? {} : { conclusion: releaseConclusion }) } };
    const final = this.#result(request, correlationId, "production_approval_required", "Release CI is green. Production approval is required; main was not merged and production was not deployed.", undefined, evidence, replayed);
    await save({ ...(releaseRunId === undefined ? {} : { releaseRunId }), ...(releaseConclusion === undefined ? {} : { releaseConclusion }), outcome: final.outcome });
    return final;
  }

  async #findOrCreatePull(input: { readonly eventId: string; readonly headBranch: string; readonly baseBranch: string; readonly expectedHeadSha: string; readonly knownNumber?: number; readonly correlationId: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<GitHubOperationResult<GitHubShipmentPullRequest>> {
    const context: GitHubRequestContext = { correlationId: input.correlationId, ...(input.signal === undefined ? {} : { signal: input.signal }), timeoutMs: this.#config.timeoutMs };
    if (input.knownNumber !== undefined) {
      const known = await this.#gateway.getPullRequest(input.knownNumber, context);
      if (known.outcome === "success") {
        if (known.value.headBranch !== input.headBranch || known.value.baseBranch !== input.baseBranch) return failure("permanent_error", "conflict", "The recorded shipment PR does not match the required head and base branches.", input.correlationId, "not_accepted");
        if (known.value.state === "open" || known.value.merged) return known;
        return failure("permanent_error", "conflict", "The recorded shipment PR is closed without a verified merge.", input.correlationId, "not_accepted");
      }
      if (known.error.code !== "not_found") return known;
    }
    const listed = await this.#gateway.listPullRequests(input.headBranch, input.baseBranch, context);
    if (listed.outcome !== "success") return listed;
    const expectedMarker = marker(input.eventId);
    const marked = listed.value.filter((pull) => pull.body?.includes(expectedMarker) === true);
    const candidates = marked.length > 0 ? marked : listed.value;
    if (candidates.length > 1) return failure("permanent_error", "conflict", "Multiple open PRs match the controlled shipment target.", input.correlationId, "not_accepted");
    if (candidates.length === 1) {
      const pull = candidates[0]!;
      if (marked.length === 0 && input.knownNumber === undefined) return failure("permanent_error", "conflict", "An unmarked PR already exists for the dedicated shipment branch.", input.correlationId, "not_accepted");
      return success(pull, input.correlationId);
    }
    const created = await this.#gateway.createPullRequest({ headBranch: input.headBranch, baseBranch: input.baseBranch, title: input.baseBranch === SHIPMENT_POC_FEATURE_BASE ? "Pirx controlled shipment POC" : "Pirx controlled release-readiness POC", body: `${input.baseBranch === SHIPMENT_POC_FEATURE_BASE ? "Controlled feature shipment" : "Controlled release readiness"}.\n\n${expectedMarker}`, idempotencyKey: `shipment:${input.eventId}:${input.baseBranch}-pr`, correlationId: input.correlationId, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
    if (created.outcome !== "unknown") return created;
    const reconciled = await this.#gateway.listPullRequests(input.headBranch, input.baseBranch, context);
    if (reconciled.outcome === "success") {
      const exact = reconciled.value.filter((pull) => pull.body?.includes(expectedMarker) === true);
      if (exact.length === 1) return success(exact[0]!, input.correlationId);
      if (exact.length > 1) return failure("permanent_error", "conflict", "Unknown PR creation reconciled to multiple matching PRs.", input.correlationId, "not_accepted");
    }
    return created;
  }

  async #finish(request: GitHubShipmentPocRequest, correlationId: string, result: GitHubShipmentPocResult, save: (patch: Partial<GitHubShipmentPocRecord>) => Promise<void>, patch: Partial<GitHubShipmentPocRecord> = {}): Promise<GitHubShipmentPocResult> { await save({ ...patch, outcome: result.outcome }); return result; }
  #result(request: GitHubShipmentPocRequest, correlationId: string, outcome: GitHubShipmentPocOutcome, message: string, errorCode: string | undefined, evidence: GitHubShipmentPocEvidence, replayed: boolean): GitHubShipmentPocResult { return { outcome, repository: SHIPMENT_POC_REPOSITORY, featureBase: SHIPMENT_POC_FEATURE_BASE, releaseBase: SHIPMENT_POC_RELEASE_BASE, eventId: request.eventId, headBranch: request.headBranch, expectedHeadSha: request.expectedHeadSha, correlationId, message, ...(errorCode === undefined ? {} : { errorCode }), evidence, replayed, updatedAt: new Date().toISOString() }; }
}
