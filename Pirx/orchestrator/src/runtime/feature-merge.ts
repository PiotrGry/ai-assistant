import type { GitHubBranchHead, GitHubPullRequest, GitHubPullRequestGatewayPort, GitHubPullRequestMergeResult } from "../github/pull-request.js";
import type { GitHubOperationResult } from "../github/outcome.js";
import type { GitHubRequestContext } from "../github/transport-types.js";
import type { CiResolutionOutcome, CiRunResult, ProviderIndependentCiGateway } from "./ci-contract.js";
import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";
import type { PullRequestProvenanceRecord, RuntimeSqliteStore, StorageResult } from "./sqlite.js";

export const FEATURE_MERGE_SCHEMA_VERSION = 1 as const;
export const FEATURE_MERGE_LIMITS = Object.freeze({
  repository: 512,
  branch: 512,
  sha: 128,
  checkName: 256,
  maxChecks: 32,
  timeoutMs: 120_000,
} as const);

export type FeatureMergeOutcome = "merged" | "replayed" | "ci_failed" | "ci_pending" | "stale" | "policy_blocked" | "authorization_required" | "rate_limited" | "conflict" | "reconciliation_required" | "not_found" | "provider_error" | "invalid_request";
export type FeatureMergeState = "pending" | "merged";
export type FeatureMergeMethod = "squash" | "merge" | "rebase";

export interface FeatureMergePolicy {
  readonly headPattern: string;
  readonly baseBranch: string;
  readonly requiredChecks: readonly string[];
  readonly requiredApprovals: number;
  readonly mergeMethod: FeatureMergeMethod;
  readonly requireMergeable?: boolean;
}

export interface FeatureMergeRequest {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly policy: FeatureMergePolicy;
  readonly correlationId: string;
  readonly now: UtcTimestamp;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface FeatureMergeRecord {
  readonly schemaVersion: typeof FEATURE_MERGE_SCHEMA_VERSION;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repository: string;
  readonly pullRequestNodeId: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly expectedHeadSha: string;
  readonly state: FeatureMergeState;
  readonly mergeSha?: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly version: number;
}

export interface FeatureMergeResult {
  readonly outcome: FeatureMergeOutcome;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repository?: string;
  readonly pullRequest?: GitHubPullRequest;
  readonly mergeSha?: string;
  readonly checked: readonly string[];
  readonly message: string;
}

function output(request: FeatureMergeRequest, outcome: FeatureMergeOutcome, message: string, extra: Partial<FeatureMergeResult> = {}): FeatureMergeResult { return { outcome, taskId: request.taskId, attemptId: request.attemptId, checked: [], message: message.slice(0, 256), ...extra }; }
function context(request: FeatureMergeRequest): GitHubRequestContext { return { correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) }; }
function remoteOutcome<T>(request: FeatureMergeRequest, remote: Exclude<GitHubOperationResult<T>, { outcome: "success" }>, repository?: string): FeatureMergeResult {
  const code = remote.error.code;
  const outcome: FeatureMergeOutcome = code === "authentication" || code === "forbidden" ? "authorization_required" : code === "rate_limited" ? "rate_limited" : code === "not_found" ? "not_found" : remote.outcome === "unknown" || code === "unknown" ? "reconciliation_required" : code === "conflict" ? "conflict" : "provider_error";
  return output(request, outcome, outcome === "authorization_required" ? "GitHub authorization is required." : outcome === "rate_limited" ? "GitHub rate limit blocked feature merge." : outcome === "reconciliation_required" ? "Feature merge result is uncertain and requires reconciliation." : "Feature merge provider operation failed.", repository === undefined ? {} : { repository });
}
function validPolicy(policy: FeatureMergePolicy): string | undefined {
  if (!validText(policy.headPattern, 512) || !validText(policy.baseBranch, FEATURE_MERGE_LIMITS.branch) || !validBranch(policy.baseBranch) || !Array.isArray(policy.requiredChecks) || policy.requiredChecks.length === 0 || policy.requiredChecks.length > FEATURE_MERGE_LIMITS.maxChecks || policy.requiredChecks.some((check) => !validText(check, FEATURE_MERGE_LIMITS.checkName)) || !Number.isSafeInteger(policy.requiredApprovals) || policy.requiredApprovals < 0 || !["squash", "merge", "rebase"].includes(policy.mergeMethod)) return "Feature merge policy is invalid.";
  try { new RegExp(policy.headPattern, "u"); } catch { return "Feature merge head pattern is invalid."; }
  return undefined;
}
function validText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function validBranch(value: string): boolean { return !value.startsWith("-") && !value.includes("..") && !/[~^:?*[\\\s]/u.test(value) && !value.endsWith("/") && !value.endsWith("."); }
function exactPull(pull: GitHubPullRequest, provenance: PullRequestProvenanceRecord): boolean { return pull.number === provenance.pullRequest.number && pull.url === provenance.pullRequest.url && pull.headBranch === provenance.headBranch && pull.baseBranch === provenance.baseBranch && pull.headSha === provenance.observedHeadSha; }
function exactRun(result: CiRunResult, check: string, expectedSha: string, pullNumber: number): boolean { return result.outcome === "success" && result.run !== undefined && result.run.name === check && result.run.testedRevision === expectedSha && result.run.pullRequestNumbers.includes(pullNumber); }
function checkOutcome(result: CiRunResult): FeatureMergeOutcome | undefined { if (result.outcome === "failed") return "ci_failed"; if (["pending", "timed_out"].includes(result.outcome)) return "ci_pending"; if (result.outcome === "rate_limited") return "rate_limited"; if (["cancelled", "not_found", "ambiguous", "stale", "retryable", "permanent", "unknown", "unavailable"].includes(result.outcome)) return "policy_blocked"; return undefined; }

export class FeatureMergeCoordinator {
  readonly #store: RuntimeSqliteStore;
  readonly #pullRequests: GitHubPullRequestGatewayPort;
  readonly #ci: ProviderIndependentCiGateway;

  public constructor(store: RuntimeSqliteStore, pullRequests: GitHubPullRequestGatewayPort, ci: ProviderIndependentCiGateway) { this.#store = store; this.#pullRequests = pullRequests; this.#ci = ci; }

  public async merge(request: FeatureMergeRequest): Promise<FeatureMergeResult> {
    const invalid = validPolicy(request.policy);
    if (invalid !== undefined || !validText(request.correlationId, 256) || !validText(request.taskId, 128) || !validText(request.attemptId, 128)) return output(request, "invalid_request", invalid ?? "Feature merge request identity is invalid.");
    if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > FEATURE_MERGE_LIMITS.timeoutMs)) return output(request, "invalid_request", "Feature merge timeout is outside its bound.");
    const provenance = this.#store.pullRequests.getByTaskAttempt(request.taskId, request.attemptId);
    const correlation = this.#store.ciCorrelations.getByTaskAttempt(request.taskId, request.attemptId);
    const task = this.#store.tasks.get(request.taskId); const attempt = this.#store.attempts.get(request.attemptId);
    if (provenance.outcome !== "success" || correlation.outcome !== "success" || task.outcome !== "success" || attempt.outcome !== "success") return output(request, "not_found", "Feature merge requires durable Task, Attempt, PR provenance, and CI correlation.");
    const record = provenance.value;
    const repository = record.repository;
    if (correlation.value.state !== "success" || correlation.value.pushedCommit !== record.observedHeadSha || correlation.value.testedRevision !== record.observedHeadSha || correlation.value.featurePullRequest.number !== record.pullRequest.number || attempt.value.taskId !== request.taskId || attempt.value.state !== "terminal" || attempt.value.result !== "CODE_PUSHED" || attempt.value.branch !== record.headBranch || attempt.value.finalCommit !== record.observedHeadSha || record.baseBranch !== request.policy.baseBranch || !new RegExp(request.policy.headPattern, "u").test(record.headBranch)) return output(request, "conflict", "Task, Attempt, provenance, CI correlation, head pattern, or base branch does not match the merge policy.", { repository });
    const stored = this.#store.featureMerges.getByTaskAttempt(request.taskId, request.attemptId);
    if (stored.outcome !== "not_found" && stored.outcome !== "success") return remoteStorage(request, stored, repository);
    if (stored.outcome === "success" && (stored.value.repository !== repository || stored.value.expectedHeadSha !== record.observedHeadSha || stored.value.pullRequestNumber !== record.pullRequest.number || stored.value.baseBranch !== request.policy.baseBranch)) return output(request, "conflict", "Durable feature merge identity conflicts with current provenance.", { repository });
    const remote = await this.#pullRequests.getPullRequest(record.pullRequest.number, context(request));
    if (remote.outcome !== "success") return remoteOutcome(request, remote, repository);
    if (!exactPull(remote.value, record)) return output(request, "stale", "Feature PR no longer matches the exact durable provenance.", { repository, pullRequest: remote.value });
    if (remote.value.merged) {
      const merged = this.#store.featureMerges.markMerged(request.taskId, request.attemptId, mergedSha(remote.value) ?? remote.value.headSha, request.now);
      if (merged.outcome !== "success") return remoteStorage(request, merged, repository);
      return output(request, stored.outcome === "success" ? "replayed" : "merged", "Feature PR was already merged at the exact correlated head.", { repository, pullRequest: remote.value, mergeSha: mergedSha(remote.value) ?? remote.value.headSha });
    }
    if (stored.outcome === "success" && stored.value.state === "pending") return output(request, "reconciliation_required", "A previous feature merge mutation is unresolved and must be reconciled before retry.", { repository, pullRequest: remote.value });
    if (stored.outcome === "success" && stored.value.state === "merged") return output(request, "reconciliation_required", "Durable merge state conflicts with the currently open remote pull request.", { repository, pullRequest: remote.value });
    if (remote.value.state !== "open" || (request.policy.requireMergeable === true && remote.value.mergeable !== true)) return output(request, "policy_blocked", "Feature PR is not open and policy-complete for merge.", { repository, pullRequest: remote.value });
    const checked: string[] = [];
    for (const check of request.policy.requiredChecks) {
      let ciResult: CiRunResult;
      try { ciResult = await this.#ci.resolvePullRequest({ pullRequestNumber: record.pullRequest.number, expectedHeadSha: record.observedHeadSha, requiredWorkflowName: check }, { correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) }); } catch { return output(request, "provider_error", "Required CI check could not be observed.", { repository }); }
      const failed = checkOutcome(ciResult);
      if (failed !== undefined || !exactRun(ciResult, check, record.observedHeadSha, record.pullRequest.number)) return output(request, failed ?? "policy_blocked", "Every required check must report exact-current-head success.", { repository, checked });
      checked.push(check);
    }
    if (request.policy.requiredApprovals > 0) {
      if (this.#pullRequests.getApprovedReviewCount === undefined) return output(request, "policy_blocked", "Required review approval evidence is unavailable.", { repository });
      const approvals = await this.#pullRequests.getApprovedReviewCount(record.pullRequest.number, context(request));
      if (approvals.outcome !== "success") return remoteOutcome(request, approvals, repository);
      if (approvals.value < request.policy.requiredApprovals) return output(request, "policy_blocked", "Required review approval count was not reached.", { repository, checked });
    }
    const head = await this.#pullRequests.getBranchHead(record.headBranch, context(request));
    if (head.outcome !== "success") return remoteOutcome(request, head, repository);
    if (head.value.sha !== record.observedHeadSha) return output(request, "stale", "Feature branch head changed before merge.", { repository, checked });
    const beforeMerge = await this.#pullRequests.getPullRequest(record.pullRequest.number, context(request));
    if (beforeMerge.outcome !== "success") return remoteOutcome(request, beforeMerge, repository);
    if (!exactPull(beforeMerge.value, record) || beforeMerge.value.state !== "open" || beforeMerge.value.merged || (request.policy.requireMergeable === true && beforeMerge.value.mergeable !== true)) return output(request, "stale", "Feature PR changed after CI and before merge.", { repository, pullRequest: beforeMerge.value, checked });
    const planned = this.#store.featureMerges.start({ schemaVersion: FEATURE_MERGE_SCHEMA_VERSION, taskId: request.taskId, attemptId: request.attemptId, repository, pullRequestNodeId: record.pullRequest.nodeId, pullRequestNumber: record.pullRequest.number, pullRequestUrl: record.pullRequest.url, headBranch: record.headBranch, baseBranch: record.baseBranch, expectedHeadSha: record.observedHeadSha, state: "pending", createdAt: request.now, updatedAt: request.now, version: 1 });
    if (planned.outcome !== "success") return remoteStorage(request, planned, repository);
    if (this.#pullRequests.mergePullRequest === undefined) return output(request, "provider_error", "The configured GitHub gateway has no centralized feature merge operation.", { repository });
    let merged: GitHubOperationResult<GitHubPullRequestMergeResult>;
    try { merged = await this.#pullRequests.mergePullRequest(record.pullRequest.number, record.observedHeadSha, { idempotencyKey: `feature-merge:${request.taskId}:${request.attemptId}`, correlationId: request.correlationId, mergeMethod: request.policy.mergeMethod, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) }); } catch { return output(request, "reconciliation_required", "Feature merge outcome is uncertain and must be reconciled.", { repository, checked }); }
    if (merged.outcome !== "success") {
      const reconciled = await this.#pullRequests.getPullRequest(record.pullRequest.number, context(request));
      if (reconciled.outcome === "success" && reconciled.value.merged && exactPull(reconciled.value, record)) {
        const saved = this.#store.featureMerges.markMerged(request.taskId, request.attemptId, mergedSha(reconciled.value) ?? record.observedHeadSha, request.now);
        const reconciledSha = mergedSha(reconciled.value);
        return saved.outcome === "success" ? output(request, "replayed", "Uncertain merge was reconciled to the exact merged PR.", { repository, pullRequest: reconciled.value, checked, ...(reconciledSha === undefined ? {} : { mergeSha: reconciledSha }) }) : remoteStorage(request, saved, repository);
      }
      return remoteOutcome(request, merged, repository);
    }
    const saved = this.#store.featureMerges.markMerged(request.taskId, request.attemptId, merged.value.sha ?? record.observedHeadSha, request.now);
    if (saved.outcome !== "success") return remoteStorage(request, saved, repository);
    return output(request, "merged", "Feature PR merged after exact-current-head policy checks.", { repository, pullRequest: beforeMerge.value, checked, ...(merged.value.sha === undefined ? {} : { mergeSha: merged.value.sha }) });
  }
}

function mergedSha(pull: GitHubPullRequest): string | undefined { return pull.mergeCommitSha; }
function remoteStorage(request: FeatureMergeRequest, stored: Exclude<StorageResult<unknown>, { outcome: "success" }>, repository: string): FeatureMergeResult { return output(request, stored.outcome === "conflict" ? "conflict" : "provider_error", stored.message, { repository }); }
