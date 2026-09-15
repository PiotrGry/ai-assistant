import type { GitHubPullRequest } from "../github/pull-request.js";
import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";
import { GitHubFeaturePullRequestService, type FeaturePullRequestResult } from "../github/feature-pull-request.js";
import { CiCorrelationService, type CiCorrelationResult } from "./ci-correlation.js";
import { CiFailureEvidenceService, type CiFailureEvidenceResult } from "./ci-evidence.js";
import { CiRetryCoordinator, type CiRetryResult } from "./ci-retry.js";
import { FeatureMergeCoordinator, type FeatureMergePolicy, type FeatureMergeResult } from "./feature-merge.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import type { ProviderIndependentCiGateway } from "./ci-contract.js";
import type { GitHubPullRequestGatewayPort } from "../github/pull-request.js";

export const SHIPMENT_CYCLE_SCHEMA_VERSION = 1 as const;
export type ShipmentCycleState = "started" | "pr_correlated" | "ci_failed" | "evidence_collected" | "retry_created" | "ci_succeeded" | "recovery_success" | "blocked" | "reconciliation_required";
export type ShipmentOutcome = "recovery_success" | "retry_created" | "retry_ci_failed" | "pending_or_timeout" | "stale_or_conflicting_evidence" | "policy_blocked" | "rate_limited" | "reconciliation_required" | "worker_unavailable" | "worker_authentication_required" | "worker_quota_exhausted" | "repair_failed" | "unknown" | "invalid_request";

export interface ShipmentCycleRecord {
  readonly schemaVersion: typeof SHIPMENT_CYCLE_SCHEMA_VERSION;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly eventId: string;
  readonly correlationId: string;
  readonly repository: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly expectedHeadSha: string;
  readonly provider: string;
  readonly workflowName: string;
  readonly state: ShipmentCycleState;
  readonly outcome?: ShipmentOutcome;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
  readonly providerRunId?: string;
  readonly evidenceDigest?: string;
  readonly successorAttemptId?: AttemptId;
  readonly mergeSha?: string;
  readonly message: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly version: number;
}

export interface ShipmentCycleRequest {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly eventId: string;
  readonly correlationId: string;
  readonly repository: { readonly owner: string; readonly repository: string };
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly expectedHeadSha: string;
  readonly provider: string;
  readonly workflowName: string;
  readonly mergePolicy: FeatureMergePolicy;
  readonly now: UtcTimestamp;
  readonly failureEventId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ShipmentCycleResult {
  readonly outcome: ShipmentOutcome;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly eventId: string;
  readonly message: string;
  readonly pullRequest?: GitHubPullRequest;
  readonly providerRunId?: string;
  readonly evidenceDigest?: string;
  readonly successorAttemptId?: AttemptId;
  readonly mergeSha?: string;
}

function result(request: ShipmentCycleRequest, outcome: ShipmentOutcome, message: string, extra: Partial<ShipmentCycleResult> = {}): ShipmentCycleResult { return { outcome, taskId: request.taskId, attemptId: request.attemptId, eventId: request.eventId, message: message.slice(0, 256), ...extra }; }
function valid(request: ShipmentCycleRequest): string | undefined { const ids = [request.taskId, request.attemptId, request.eventId, request.correlationId, request.headBranch, request.baseBranch, request.expectedHeadSha, request.provider, request.workflowName]; return ids.some((value) => typeof value !== "string" || value.trim().length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) ? "Shipment identity is invalid." : undefined; }
function remoteResult(request: ShipmentCycleRequest, value: FeaturePullRequestResult): ShipmentCycleResult { const map: Record<string, ShipmentOutcome> = { authorization_required: "worker_authentication_required", rate_limited: "rate_limited", reconciliation_required: "reconciliation_required", pending: "pending_or_timeout", stale_head: "stale_or_conflicting_evidence", conflict: "policy_blocked", ambiguous: "stale_or_conflicting_evidence", not_found: "unknown", provider_error: "unknown", invalid_request: "invalid_request" }; return result(request, map[value.outcome] ?? "unknown", value.message, value.pullRequest === undefined ? {} : { pullRequest: value.pullRequest }); }
function ciOutcome(request: ShipmentCycleRequest, value: CiCorrelationResult): ShipmentCycleResult { if (value.outcome !== "observed" && value.outcome !== "replayed") return result(request, "reconciliation_required", value.message); const map: Record<string, ShipmentOutcome> = { pending: "pending_or_timeout", failed: "retry_ci_failed", cancelled: "pending_or_timeout", timed_out: "pending_or_timeout", stale: "stale_or_conflicting_evidence", ambiguous: "stale_or_conflicting_evidence", rate_limited: "rate_limited", not_found: "stale_or_conflicting_evidence", retryable: "pending_or_timeout", permanent: "policy_blocked", unknown: "reconciliation_required", unavailable: "unknown" }; return result(request, map[value.state] ?? "unknown", value.message); }

export class ShipmentCycleCoordinator {
  readonly #store: RuntimeSqliteStore;
  readonly #pullRequests: GitHubFeaturePullRequestService;
  readonly #ci: CiCorrelationService;
  readonly #evidence: CiFailureEvidenceService;
  readonly #retry: CiRetryCoordinator;
  readonly #merge: FeatureMergeCoordinator;

  public constructor(store: RuntimeSqliteStore, github: GitHubPullRequestGatewayPort, ci: ProviderIndependentCiGateway) {
    this.#store = store; this.#pullRequests = new GitHubFeaturePullRequestService(store, github); this.#ci = new CiCorrelationService(store, ci); this.#evidence = new CiFailureEvidenceService(store, ci); this.#retry = new CiRetryCoordinator(store); this.#merge = new FeatureMergeCoordinator(store, github, ci);
  }

  public async run(request: ShipmentCycleRequest): Promise<ShipmentCycleResult> {
    const invalid = valid(request); if (invalid !== undefined || request.baseBranch !== request.mergePolicy.baseBranch || request.workflowName !== request.mergePolicy.requiredChecks[0]) return result(request, "invalid_request", invalid ?? "Shipment request and merge policy disagree.");
    const task = this.#store.tasks.get(request.taskId); const attempt = this.#store.attempts.get(request.attemptId);
    if (task.outcome !== "success" || attempt.outcome !== "success" || attempt.value.state !== "terminal" || attempt.value.taskId !== request.taskId || attempt.value.branch !== request.headBranch || attempt.value.finalCommit !== request.expectedHeadSha || attempt.value.result !== "CODE_PUSHED") return result(request, "stale_or_conflicting_evidence", "Shipment requires the exact terminal CODE_PUSHED Attempt.");
    const existing = this.#store.shipmentCycles.getByEvent(request.eventId);
    if (existing.outcome === "success") return this.#fromRecord(existing.value);
    if (existing.outcome !== "not_found") return result(request, "reconciliation_required", existing.message);
    const started = this.#store.shipmentCycles.start({ schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, eventId: request.eventId, correlationId: request.correlationId, repository: `${request.repository.owner}/${request.repository.repository}`, headBranch: request.headBranch, baseBranch: request.baseBranch, expectedHeadSha: request.expectedHeadSha, provider: request.provider, workflowName: request.workflowName, state: "started", message: "Shipment cycle started.", createdAt: request.now, updatedAt: request.now, version: 1 });
    if (started.outcome !== "success") return result(request, "reconciliation_required", started.message);
    const pr = await this.#pullRequests.createOrReuse({ taskId: request.taskId, attemptId: request.attemptId, repository: request.repository, baseBranch: request.baseBranch, expectedHeadSha: request.expectedHeadSha, correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (!['created', 'reused', 'replayed', 'reconciled'].includes(pr.outcome) || pr.pullRequest === undefined) return this.#finish(request, remoteResult(request, pr), "blocked");
    this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state: "pr_correlated", pullRequestNumber: pr.pullRequest.number, pullRequestUrl: pr.pullRequest.url, message: "Feature PR is durably correlated." }, request.now);
    const ci = await this.#ci.observe({ taskId: request.taskId, attemptId: request.attemptId, repository: `${request.repository.owner}/${request.repository.repository}`, headBranch: request.headBranch, baseBranch: request.baseBranch, featurePullRequestNumber: pr.pullRequest.number, expectedHeadSha: request.expectedHeadSha, provider: request.provider, requiredWorkflowName: request.workflowName, correlationId: request.correlationId, now: request.now, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (ci.outcome !== "observed" && ci.outcome !== "replayed") return this.#finish(request, ciOutcome(request, ci), "reconciliation_required");
    if (ci.state !== "success" && ci.state !== "failed") return this.#finish(request, ciOutcome(request, ci), "blocked");
    if (ci.state === "failed") {
      this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state: "ci_failed", ...(ci.record.providerRunId === undefined ? {} : { providerRunId: ci.record.providerRunId }), message: "Exact CI failure was durably correlated." }, request.now);
      const evidence = await this.#evidence.collect({ taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, now: request.now, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
      if (evidence.outcome !== "collected" && evidence.outcome !== "partial" && evidence.outcome !== "replayed") return this.#finish(request, result(request, evidence.outcome === "rate_limited" ? "rate_limited" : evidence.outcome === "stale" || evidence.outcome === "conflict" ? "stale_or_conflicting_evidence" : "reconciliation_required", evidence.message), "blocked");
      this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state: "evidence_collected", evidenceDigest: evidence.record.evidenceDigest, message: "Bounded CI evidence was durably collected." }, request.now);
      const history = this.#store.attempts.listByTask(request.taskId); if (history.outcome !== "success") return this.#finish(request, result(request, "reconciliation_required", history.message), "reconciliation_required");
      if ((history.value.find((item) => item.id === request.attemptId)?.ordinal ?? 1) > 1) return this.#finish(request, result(request, "retry_ci_failed", "A retry Attempt failed CI; automatic third Attempt creation is disabled."), "blocked");
      const retry = this.#retry.create({ taskId: request.taskId, attemptId: request.attemptId, failureEventId: request.failureEventId ?? request.eventId, evidenceDigest: evidence.record.evidenceDigest, now: request.now });
      if (retry.outcome !== "created" && retry.outcome !== "already_retried") return this.#finish(request, result(request, retry.outcome === "reconciliation_required" ? "reconciliation_required" : "stale_or_conflicting_evidence", retry.message), "blocked");
      return this.#finish(request, result(request, "retry_created", retry.message, { evidenceDigest: evidence.record.evidenceDigest, ...(retry.successorAttemptId === undefined ? {} : { successorAttemptId: retry.successorAttemptId }) }), "retry_created");
    }
    this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state: "ci_succeeded", ...(ci.record.providerRunId === undefined ? {} : { providerRunId: ci.record.providerRunId }), message: "Exact CI success was durably correlated." }, request.now);
    const merged = await this.#merge.merge({ taskId: request.taskId, attemptId: request.attemptId, policy: request.mergePolicy, correlationId: request.correlationId, now: request.now, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (merged.outcome !== "merged" && merged.outcome !== "replayed") return this.#finish(request, result(request, merged.outcome === "rate_limited" ? "rate_limited" : merged.outcome === "reconciliation_required" ? "reconciliation_required" : merged.outcome === "stale" ? "stale_or_conflicting_evidence" : merged.outcome === "authorization_required" ? "worker_authentication_required" : "policy_blocked", merged.message, merged.pullRequest === undefined ? {} : { pullRequest: merged.pullRequest }), "blocked");
    return this.#finish(request, result(request, "recovery_success", merged.message, { ...(merged.mergeSha === undefined ? {} : { mergeSha: merged.mergeSha }), ...(merged.pullRequest === undefined ? {} : { pullRequest: merged.pullRequest }), ...(ci.record.providerRunId === undefined ? {} : { providerRunId: ci.record.providerRunId }) }), "recovery_success");
  }

  #finish(request: ShipmentCycleRequest, output: ShipmentCycleResult, state: ShipmentCycleState): ShipmentCycleResult { this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state, outcome: output.outcome, ...(output.successorAttemptId === undefined ? {} : { successorAttemptId: output.successorAttemptId }), ...(output.evidenceDigest === undefined ? {} : { evidenceDigest: output.evidenceDigest }), ...(output.mergeSha === undefined ? {} : { mergeSha: output.mergeSha }), ...(output.providerRunId === undefined ? {} : { providerRunId: output.providerRunId }), ...(output.pullRequest === undefined ? {} : { pullRequestNumber: output.pullRequest.number, pullRequestUrl: output.pullRequest.url }), message: output.message }, request.now); return output; }
  #fromRecord(record: ShipmentCycleRecord): ShipmentCycleResult { return { outcome: record.outcome ?? "reconciliation_required", taskId: record.taskId, attemptId: record.attemptId, eventId: record.eventId, message: record.message, ...(record.pullRequestNumber === undefined || record.pullRequestUrl === undefined ? {} : { pullRequest: { number: record.pullRequestNumber, url: record.pullRequestUrl, state: "open" as const, headBranch: record.headBranch, headSha: record.expectedHeadSha, baseBranch: record.baseBranch, merged: record.state === "recovery_success" } }), ...(record.providerRunId === undefined ? {} : { providerRunId: record.providerRunId }), ...(record.evidenceDigest === undefined ? {} : { evidenceDigest: record.evidenceDigest }), ...(record.successorAttemptId === undefined ? {} : { successorAttemptId: record.successorAttemptId }), ...(record.mergeSha === undefined ? {} : { mergeSha: record.mergeSha }) }; }
}
