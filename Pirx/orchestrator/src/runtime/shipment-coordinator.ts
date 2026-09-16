import type { GitHubPullRequest } from "../github/pull-request.js";
import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";
import { GitHubFeaturePullRequestService, type FeaturePullRequestResult } from "../github/feature-pull-request.js";
import { CiCorrelationService, type CiCorrelationResult } from "./ci-correlation.js";
import { CiFailureEvidenceService, type CiFailureEvidenceResult } from "./ci-evidence.js";
import { CiRetryCoordinator, RETRY_BLOCKER_EVALUATION_BEFORE_TASK_UPDATE_MESSAGE, type CiRetryResult } from "./ci-retry.js";
import { FeatureMergeCoordinator, type FeatureMergePolicy, type FeatureMergeResult } from "./feature-merge.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import type { ProviderIndependentCiGateway } from "./ci-contract.js";
import type { GitHubPullRequestGatewayPort } from "../github/pull-request.js";

export const SHIPMENT_CYCLE_SCHEMA_VERSION = 1 as const;
export type ShipmentCompletionMode = "merge" | "exact_green";
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
  readonly completionMode: ShipmentCompletionMode;
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
  readonly completionMode?: ShipmentCompletionMode;
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
    let cycle: ShipmentCycleRecord;
    if (existing.outcome === "success") {
      if (existing.value.outcome !== undefined) {
        if (existing.value.state === "blocked" && existing.value.outcome === "stale_or_conflicting_evidence" && existing.value.message === RETRY_BLOCKER_EVALUATION_BEFORE_TASK_UPDATE_MESSAGE) return this.#resumeBlockedRetry(request, existing.value);
        return this.#fromRecord(existing.value);
      }
      if (!this.#sameIdentity(existing.value, request)) return result(request, "reconciliation_required", "Stored shipment cycle identity conflicts with the resumed request.");
      cycle = existing.value;
    } else if (existing.outcome === "not_found") {
      const started = this.#store.shipmentCycles.start({ schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, eventId: request.eventId, correlationId: request.correlationId, repository: `${request.repository.owner}/${request.repository.repository}`, headBranch: request.headBranch, baseBranch: request.baseBranch, expectedHeadSha: request.expectedHeadSha, provider: request.provider, workflowName: request.workflowName, completionMode: request.completionMode ?? "merge", state: "started", message: "Shipment cycle started.", createdAt: request.now, updatedAt: request.now, version: 1 });
      if (started.outcome !== "success") return result(request, "reconciliation_required", started.message);
      cycle = started.value;
    } else return result(request, "reconciliation_required", existing.message);

    if (!["started", "pr_correlated", "ci_failed", "evidence_collected", "ci_succeeded"].includes(cycle.state)) return result(request, "reconciliation_required", "Stored shipment cycle is not safely resumable.");
    if (cycle.state !== "started" && (cycle.pullRequestNumber === undefined || cycle.pullRequestUrl === undefined)) return result(request, "reconciliation_required", "Stored shipment cycle is missing its feature pull request identity.");
    const pr = await this.#pullRequests.createOrReuse({ taskId: request.taskId, attemptId: request.attemptId, repository: request.repository, baseBranch: request.baseBranch, expectedHeadSha: request.expectedHeadSha, correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (!['created', 'reused', 'replayed', 'reconciled'].includes(pr.outcome) || pr.pullRequest === undefined) return this.#finish(request, remoteResult(request, pr), "blocked");
    if (cycle.state === "started") {
      const correlated = this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state: "pr_correlated", pullRequestNumber: pr.pullRequest.number, pullRequestUrl: pr.pullRequest.url, message: "Feature PR is durably correlated." }, request.now);
      if (correlated.outcome !== "success") return result(request, "reconciliation_required", correlated.message);
      cycle = correlated.value;
    } else if (cycle.pullRequestNumber !== pr.pullRequest.number || cycle.pullRequestUrl !== pr.pullRequest.url) return result(request, "reconciliation_required", "Stored shipment cycle PR identity no longer matches durable PR provenance.");
    const ci = await this.#ci.observe({ taskId: request.taskId, attemptId: request.attemptId, repository: `${request.repository.owner}/${request.repository.repository}`, headBranch: request.headBranch, baseBranch: request.baseBranch, featurePullRequestNumber: pr.pullRequest.number, expectedHeadSha: request.expectedHeadSha, provider: request.provider, requiredWorkflowName: request.workflowName, correlationId: request.correlationId, now: request.now, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (ci.outcome !== "observed" && ci.outcome !== "replayed") return this.#finish(request, ciOutcome(request, ci), "reconciliation_required");
    if (ci.state !== "success" && ci.state !== "failed") return this.#finish(request, ciOutcome(request, ci), "blocked");
    if (ci.state === "failed") {
      if (cycle.state !== "ci_failed" && cycle.state !== "evidence_collected") {
        const failed = this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state: "ci_failed", ...(ci.record.providerRunId === undefined ? {} : { providerRunId: ci.record.providerRunId }), message: "Exact CI failure was durably correlated." }, request.now);
        if (failed.outcome !== "success") return result(request, "reconciliation_required", failed.message);
        cycle = failed.value;
      }
      const evidence = await this.#evidence.collect({ taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, now: request.now, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
      if (evidence.outcome !== "collected" && evidence.outcome !== "partial" && evidence.outcome !== "replayed") return this.#finish(request, result(request, evidence.outcome === "rate_limited" ? "rate_limited" : evidence.outcome === "stale" || evidence.outcome === "conflict" ? "stale_or_conflicting_evidence" : "reconciliation_required", evidence.message), "blocked");
      if (cycle.state !== "evidence_collected") {
        const collected = this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state: "evidence_collected", evidenceDigest: evidence.record.evidenceDigest, message: "Bounded CI evidence was durably collected." }, request.now);
        if (collected.outcome !== "success") return result(request, "reconciliation_required", collected.message);
        cycle = collected.value;
      } else if (cycle.evidenceDigest !== evidence.record.evidenceDigest) return result(request, "reconciliation_required", "Stored shipment cycle evidence does not match durable CI evidence.");
      const history = this.#store.attempts.listByTask(request.taskId); if (history.outcome !== "success") return this.#finish(request, result(request, "reconciliation_required", history.message), "reconciliation_required");
      if ((history.value.find((item) => item.id === request.attemptId)?.ordinal ?? 1) > 1) return this.#finish(request, result(request, "retry_ci_failed", "A retry Attempt failed CI; automatic third Attempt creation is disabled."), "blocked");
      const retry = this.#retry.create({ taskId: request.taskId, attemptId: request.attemptId, failureEventId: request.failureEventId ?? request.eventId, evidenceDigest: evidence.record.evidenceDigest, now: request.now });
      if (retry.outcome !== "created" && retry.outcome !== "already_retried") return this.#finish(request, result(request, retry.outcome === "reconciliation_required" ? "reconciliation_required" : "stale_or_conflicting_evidence", retry.message), "blocked");
      return this.#finish(request, result(request, "retry_created", retry.message, { evidenceDigest: evidence.record.evidenceDigest, ...(retry.successorAttemptId === undefined ? {} : { successorAttemptId: retry.successorAttemptId }) }), "retry_created");
    }
    if (cycle.state !== "ci_succeeded") {
      const succeeded = this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state: "ci_succeeded", ...(ci.record.providerRunId === undefined ? {} : { providerRunId: ci.record.providerRunId }), message: "Exact CI success was durably correlated." }, request.now);
      if (succeeded.outcome !== "success") return result(request, "reconciliation_required", succeeded.message);
    }
    if ((request.completionMode ?? "merge") === "exact_green") {
      return this.#finish(request, result(request, "recovery_success", "Exact-current-head CI succeeded; shipment stopped before merge by policy.", { pullRequest: pr.pullRequest, ...(ci.record.providerRunId === undefined ? {} : { providerRunId: ci.record.providerRunId }) }), "recovery_success");
    }
    const merged = await this.#merge.merge({ taskId: request.taskId, attemptId: request.attemptId, policy: request.mergePolicy, correlationId: request.correlationId, now: request.now, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (merged.outcome !== "merged" && merged.outcome !== "replayed") return this.#finish(request, result(request, merged.outcome === "rate_limited" ? "rate_limited" : merged.outcome === "reconciliation_required" ? "reconciliation_required" : merged.outcome === "stale" ? "stale_or_conflicting_evidence" : merged.outcome === "authorization_required" ? "worker_authentication_required" : "policy_blocked", merged.message, merged.pullRequest === undefined ? {} : { pullRequest: merged.pullRequest }), "blocked");
    return this.#finish(request, result(request, "recovery_success", merged.message, { ...(merged.mergeSha === undefined ? {} : { mergeSha: merged.mergeSha }), ...(merged.pullRequest === undefined ? {} : { pullRequest: merged.pullRequest }), ...(ci.record.providerRunId === undefined ? {} : { providerRunId: ci.record.providerRunId }) }), "recovery_success");
  }

  #sameIdentity(record: ShipmentCycleRecord, request: ShipmentCycleRequest): boolean {
    return record.taskId === request.taskId && record.attemptId === request.attemptId && record.eventId === request.eventId && record.correlationId === request.correlationId && record.repository === `${request.repository.owner}/${request.repository.repository}` && record.headBranch === request.headBranch && record.baseBranch === request.baseBranch && record.expectedHeadSha === request.expectedHeadSha && record.provider === request.provider && record.workflowName === request.workflowName && record.completionMode === (request.completionMode ?? "merge");
  }

  async #resumeBlockedRetry(request: ShipmentCycleRequest, cycle: ShipmentCycleRecord): Promise<ShipmentCycleResult> {
    if (cycle.pullRequestNumber === undefined || cycle.pullRequestUrl === undefined || cycle.evidenceDigest === undefined) return result(request, "reconciliation_required", "Historical blocked retry is missing durable PR or evidence identity.");
    const provenance = this.#store.pullRequests.getByTaskAttempt(request.taskId, request.attemptId);
    if (provenance.outcome !== "success" || provenance.value.pullRequest.number !== cycle.pullRequestNumber || provenance.value.pullRequest.url !== cycle.pullRequestUrl) return result(request, "reconciliation_required", "Historical blocked retry cannot resume without matching durable PR provenance.");
    const pr = await this.#pullRequests.createOrReuse({ taskId: request.taskId, attemptId: request.attemptId, repository: request.repository, baseBranch: request.baseBranch, expectedHeadSha: request.expectedHeadSha, correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (!['replayed', 'reused', 'reconciled'].includes(pr.outcome) || pr.pullRequest === undefined) return result(request, "stale_or_conflicting_evidence", pr.message, pr.pullRequest === undefined ? {} : { pullRequest: pr.pullRequest });
    if (pr.pullRequest.number !== cycle.pullRequestNumber || pr.pullRequest.url !== cycle.pullRequestUrl) return result(request, "stale_or_conflicting_evidence", "Historical blocked retry PR identity no longer matches the durable cycle.", { pullRequest: pr.pullRequest });
    const ci = await this.#ci.observe({ taskId: request.taskId, attemptId: request.attemptId, repository: `${request.repository.owner}/${request.repository.repository}`, headBranch: request.headBranch, baseBranch: request.baseBranch, featurePullRequestNumber: pr.pullRequest.number, expectedHeadSha: request.expectedHeadSha, provider: request.provider, requiredWorkflowName: request.workflowName, correlationId: request.correlationId, now: request.now, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (ci.outcome !== "observed" && ci.outcome !== "replayed") return result(request, "reconciliation_required", ci.message);
    if (ci.state !== "failed") return result(request, "stale_or_conflicting_evidence", "Historical blocked retry no longer has the exact terminal failed CI correlation.");
    const evidence = await this.#evidence.collect({ taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, now: request.now, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (evidence.outcome !== "collected" && evidence.outcome !== "partial" && evidence.outcome !== "replayed") return result(request, evidence.outcome === "rate_limited" ? "rate_limited" : "stale_or_conflicting_evidence", evidence.message);
    if (evidence.record.evidenceDigest !== cycle.evidenceDigest) return result(request, "stale_or_conflicting_evidence", "Historical blocked retry evidence no longer matches the durable evidence digest.");
    const retry = this.#retry.create({ taskId: request.taskId, attemptId: request.attemptId, failureEventId: request.failureEventId ?? request.eventId, evidenceDigest: evidence.record.evidenceDigest, now: request.now });
    if (retry.outcome !== "created" && retry.outcome !== "already_retried") return result(request, retry.outcome === "blocked" ? "stale_or_conflicting_evidence" : retry.outcome === "reconciliation_required" ? "reconciliation_required" : "stale_or_conflicting_evidence", retry.message, { evidenceDigest: evidence.record.evidenceDigest });
    return result(request, "retry_created", retry.message, { evidenceDigest: evidence.record.evidenceDigest, ...(retry.successorAttemptId === undefined ? {} : { successorAttemptId: retry.successorAttemptId }) });
  }

  #finish(request: ShipmentCycleRequest, output: ShipmentCycleResult, state: ShipmentCycleState): ShipmentCycleResult { this.#store.shipmentCycles.advance(request.taskId, request.attemptId, { state, outcome: output.outcome, ...(output.successorAttemptId === undefined ? {} : { successorAttemptId: output.successorAttemptId }), ...(output.evidenceDigest === undefined ? {} : { evidenceDigest: output.evidenceDigest }), ...(output.mergeSha === undefined ? {} : { mergeSha: output.mergeSha }), ...(output.providerRunId === undefined ? {} : { providerRunId: output.providerRunId }), ...(output.pullRequest === undefined ? {} : { pullRequestNumber: output.pullRequest.number, pullRequestUrl: output.pullRequest.url }), message: output.message }, request.now); return output; }
  #fromRecord(record: ShipmentCycleRecord): ShipmentCycleResult { return { outcome: record.outcome ?? "reconciliation_required", taskId: record.taskId, attemptId: record.attemptId, eventId: record.eventId, message: record.message, ...(record.pullRequestNumber === undefined || record.pullRequestUrl === undefined ? {} : { pullRequest: { number: record.pullRequestNumber, url: record.pullRequestUrl, state: record.mergeSha === undefined ? "open" as const : "closed" as const, headBranch: record.headBranch, headSha: record.expectedHeadSha, baseBranch: record.baseBranch, merged: record.mergeSha !== undefined } }), ...(record.providerRunId === undefined ? {} : { providerRunId: record.providerRunId }), ...(record.evidenceDigest === undefined ? {} : { evidenceDigest: record.evidenceDigest }), ...(record.successorAttemptId === undefined ? {} : { successorAttemptId: record.successorAttemptId }), ...(record.mergeSha === undefined ? {} : { mergeSha: record.mergeSha }) }; }
}
