import { createHash } from "node:crypto";

import type { GitHubPullRequest, GitHubPullRequestGatewayPort, GitHubPullRequestMergeResult } from "../github/pull-request.js";
import type { GitHubOperationResult } from "../github/outcome.js";
import type { GitHubRequestContext } from "../github/transport-types.js";
import type { CiRun, CiRunResult, ProviderIndependentCiGateway } from "./ci-contract.js";
import { ReleaseCorrelationService, type ReleaseCorrelationRecord, type ReleaseWorkflowIdentity } from "./release-correlation.js";
import { type ReleaseId, type ReleasePullRequestIdentity, type ReleaseRecord } from "./release.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import type { UtcTimestamp } from "./task-domain.js";

export const RELEASE_MERGE_LIMITS = Object.freeze({ checks: 32, checkName: 256, identity: 256, timeoutMs: 120_000 } as const);
export type ReleaseMergeMethod = "squash" | "merge" | "rebase";
export type ReleaseMergeOutcome = "merged" | "replayed" | "ci_failed" | "ci_pending" | "stale" | "superseded" | "policy_blocked" | "human_action_required" | "authorization_required" | "rate_limited" | "conflict" | "reconciliation_required" | "not_found" | "ambiguous" | "provider_error" | "invalid_request";

export interface ReleaseMergePolicy {
  readonly requiredChecks: readonly string[];
  readonly requiredApprovals: number;
  readonly mergeMethod: ReleaseMergeMethod;
  readonly requireMergeable?: boolean;
}

export interface ReleaseMergeRequest {
  readonly releaseId: ReleaseId;
  readonly expectedReleaseHeadSha: string;
  readonly policy: ReleaseMergePolicy;
  readonly correlationId: string;
  readonly now: UtcTimestamp;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ReleaseMergeResult {
  readonly outcome: ReleaseMergeOutcome;
  readonly releaseId: ReleaseId;
  readonly repository?: string;
  readonly pullRequest?: GitHubPullRequest;
  readonly checked: readonly string[];
  readonly mergeRevision?: string;
  readonly message: string;
}

const UNCERTAIN_CREATE_REASON = "release_pr_creation_uncertain";
type PullRequestResolution = { readonly outcome: "resolved"; readonly pullRequest: GitHubPullRequest } | { readonly outcome: "failed"; readonly result: ReleaseMergeResult };

function validText(value: unknown, maximum: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value); }
function validatePolicy(policy: ReleaseMergePolicy): string | undefined {
  if (!Array.isArray(policy.requiredChecks) || policy.requiredChecks.length === 0 || policy.requiredChecks.length > RELEASE_MERGE_LIMITS.checks || policy.requiredChecks.some((check) => !validText(check, RELEASE_MERGE_LIMITS.checkName)) || new Set(policy.requiredChecks).size !== policy.requiredChecks.length) return "Release merge checks are invalid.";
  if (!Number.isSafeInteger(policy.requiredApprovals) || policy.requiredApprovals < 0 || !["squash", "merge", "rebase"].includes(policy.mergeMethod)) return "Release merge policy is invalid.";
  return undefined;
}
function result(request: ReleaseMergeRequest, outcome: ReleaseMergeOutcome, message: string, extra: Partial<ReleaseMergeResult> = {}): ReleaseMergeResult { return { outcome, releaseId: request.releaseId, checked: [], message: message.slice(0, 512), ...extra }; }
function context(request: ReleaseMergeRequest): GitHubRequestContext { return { correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) }; }
function marker(releaseId: string): string { return "<!-- pirx-release:v1 " + createHash("sha256").update(releaseId, "utf8").digest("hex") + " -->"; }
function identity(pull: GitHubPullRequest): ReleasePullRequestIdentity { return { nodeId: "pr:" + String(pull.number), number: pull.number, url: pull.url }; }
function exactPull(pull: GitHubPullRequest, release: ReleaseRecord, head: string): boolean { return pull.headBranch === release.sourceBranch && pull.baseBranch === release.baseBranch && pull.headSha === head; }
function samePull(left: ReleasePullRequestIdentity, right: GitHubPullRequest): boolean { return left.number === right.number && left.url === right.url; }
function exactRun(value: CiRunResult, check: string, head: string, pull: number): value is CiRunResult & { readonly outcome: "success"; readonly run: CiRun } { return value.outcome === "success" && value.run !== undefined && value.run.name === check && value.run.testedRevision === head && value.run.pullRequestNumbers.includes(pull); }
function workflow(run: CiRun, check: string): ReleaseWorkflowIdentity { return { provider: run.provider, providerRunId: run.providerRunId, url: run.url, name: check, testedRevision: run.testedRevision }; }
function ciOutcome(value: CiRunResult): ReleaseMergeOutcome { if (value.outcome === "failed") return "ci_failed"; if (value.outcome === "pending" || value.outcome === "timed_out") return "ci_pending"; if (value.outcome === "rate_limited") return "rate_limited"; if (value.outcome === "stale") return "stale"; if (value.outcome === "ambiguous") return "ambiguous"; return "policy_blocked"; }
function remoteOutcome<T>(request: ReleaseMergeRequest, remote: Exclude<GitHubOperationResult<T>, { readonly outcome: "success" }>, repository?: string): ReleaseMergeResult {
  const code = remote.error.code;
  const outcome: ReleaseMergeOutcome = code === "authentication" || code === "forbidden" ? "authorization_required" : code === "rate_limited" ? "rate_limited" : code === "not_found" ? "not_found" : code === "conflict" ? "conflict" : remote.outcome === "unknown" || code === "unknown" ? "reconciliation_required" : "provider_error";
  return result(request, outcome, outcome === "reconciliation_required" ? "Release mutation outcome is uncertain and requires reconciliation." : "GitHub release operation did not complete.", repository === undefined ? {} : { repository });
}
function storageOutcome(request: ReleaseMergeRequest, value: Exclude<StorageResult<unknown>, { readonly outcome: "success" }>, repository?: string): ReleaseMergeResult { return result(request, value.outcome === "not_found" ? "not_found" : value.outcome === "conflict" ? "conflict" : "provider_error", value.message, repository === undefined ? {} : { repository }); }

export class ReleaseMergeCoordinator {
  readonly #store: RuntimeSqliteStore;
  readonly #pullRequests: GitHubPullRequestGatewayPort;
  readonly #ci: ProviderIndependentCiGateway;
  readonly #correlations: ReleaseCorrelationService;

  public constructor(store: RuntimeSqliteStore, pullRequests: GitHubPullRequestGatewayPort, ci: ProviderIndependentCiGateway) {
    this.#store = store;
    this.#pullRequests = pullRequests;
    this.#ci = ci;
    this.#correlations = new ReleaseCorrelationService(store);
  }

  public async merge(request: ReleaseMergeRequest): Promise<ReleaseMergeResult> {
    const invalidPolicy = validatePolicy(request.policy);
    if (invalidPolicy !== undefined || !validText(request.releaseId, 128) || !validText(request.expectedReleaseHeadSha, 128) || !validText(request.correlationId, RELEASE_MERGE_LIMITS.identity)) return result(request, "invalid_request", invalidPolicy ?? "Release merge request identity is invalid.");
    if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > RELEASE_MERGE_LIMITS.timeoutMs)) return result(request, "invalid_request", "Release merge timeout is outside its bound.");
    const releaseRead = this.#store.releases.get(request.releaseId);
    if (releaseRead.outcome !== "success") return storageOutcome(request, releaseRead);
    let release = releaseRead.value;
    const repository = release.repository;
    if (release.state === "collecting") return result(request, "policy_blocked", "Release membership must be immutable before release PR creation.", { repository });
    if (["failed", "blocked", "rolled_back"].includes(release.state)) return result(request, "policy_blocked", "Release state does not permit merge orchestration.", { repository });
    if (release.state === "human_action_required" && release.failureReason !== UNCERTAIN_CREATE_REASON) return result(request, "human_action_required", "Release requires a human decision before merge orchestration.", { repository });
    const members = this.#store.releases.listTasks(request.releaseId);
    if (members.outcome !== "success") return storageOutcome(request, members, repository);
    const selectedRevisions = Object.freeze(members.value.map((member) => member.selectedRevision).sort((left, right) => left.localeCompare(right)));
    if (new Set(selectedRevisions).size !== selectedRevisions.length) return result(request, "ambiguous", "Release membership contains duplicate selected revisions.", { repository });
    const currentHead = await this.#pullRequests.getBranchHead(release.sourceBranch, context(request));
    if (currentHead.outcome !== "success") return remoteOutcome(request, currentHead, repository);
    if (currentHead.value.sha !== request.expectedReleaseHeadSha) return result(request, "superseded", "Release source branch moved away from the expected head revision.", { repository });

    const storedCorrelation = this.#correlations.getByRelease(request.releaseId);
    if (storedCorrelation.outcome !== "success" && storedCorrelation.outcome !== "not_found") return storageOutcome(request, storedCorrelation, repository);
    if (storedCorrelation.outcome === "success" && storedCorrelation.value.releaseHeadRevision !== request.expectedReleaseHeadSha) return result(request, "superseded", "Durable Release correlation belongs to an older release head.", { repository });
    const pullResult = await this.#resolvePullRequest(request, release, storedCorrelation.outcome === "success" ? storedCorrelation.value : undefined);
    if (pullResult.outcome === "failed") return pullResult.result;
    const pull = pullResult.pullRequest;
    if (!exactPull(pull, release, request.expectedReleaseHeadSha)) return result(request, "stale", "Release pull request no longer matches the exact source, base, and head revision.", { repository, pullRequest: pull });

    if (["deploying", "production_verification", "deployed"].includes(release.state)) {
      if (storedCorrelation.outcome !== "success" || storedCorrelation.value.mergeRevision === undefined || !pull.merged || pull.mergeCommitSha !== storedCorrelation.value.mergeRevision) return result(request, "conflict", "Merged Release state conflicts with durable pull request evidence.", { repository, pullRequest: pull });
      return result(request, "replayed", "Replayed the exact durable Release merge.", { repository, pullRequest: pull, mergeRevision: storedCorrelation.value.mergeRevision });
    }
    if (release.state === "merging") {
      if (!pull.merged || pull.mergeCommitSha === undefined) return result(request, "reconciliation_required", "Release merge was planned but its remote outcome is still unresolved.", { repository, pullRequest: pull });
      return this.#recordMerged(request, release, pull, pull.mergeCommitSha, storedCorrelation.outcome === "success" ? storedCorrelation.value : undefined, []);
    }
    if (pull.state !== "open" || pull.merged) return result(request, "stale", "Release pull request is not open for policy evaluation.", { repository, pullRequest: pull });

    if (this.#pullRequests.listPullRequestCommitShas === undefined) return result(request, "policy_blocked", "Release membership verification is unavailable from the configured GitHub gateway.", { repository, pullRequest: pull });
    const commits = await this.#pullRequests.listPullRequestCommitShas(pull.number, context(request));
    if (commits.outcome !== "success") return remoteOutcome(request, commits, repository);
    const missingRevisions = selectedRevisions.filter((revision) => !commits.value.includes(revision));
    if (missingRevisions.length > 0) return result(request, "conflict", "Release pull request does not contain every selected ReleaseTask revision.", { repository, pullRequest: pull });

    const checked: string[] = [];
    let releaseWorkflow: ReleaseWorkflowIdentity | undefined;
    for (const check of request.policy.requiredChecks) {
      let observed: CiRunResult;
      try { observed = await this.#ci.resolvePullRequest({ pullRequestNumber: pull.number, expectedHeadSha: request.expectedReleaseHeadSha, requiredWorkflowName: check }, { correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) }); }
      catch { return result(request, "provider_error", "Required Release check could not be observed.", { repository, pullRequest: pull, checked }); }
      if (!exactRun(observed, check, request.expectedReleaseHeadSha, pull.number)) return result(request, ciOutcome(observed), "Every required Release check must report exact-current-head success.", { repository, pullRequest: pull, checked });
      releaseWorkflow ??= workflow(observed.run, check);
      checked.push(check);
    }
    if (releaseWorkflow === undefined) return result(request, "policy_blocked", "Release policy contains no observable workflow.", { repository, pullRequest: pull });

    const correlated = this.#correlations.correlate({ releaseId: request.releaseId, repository, sourceBranch: release.sourceBranch, baseBranch: release.baseBranch, releasePullRequest: identity(pull), releaseHeadRevision: request.expectedReleaseHeadSha, memberRevisions: selectedRevisions, workflow: releaseWorkflow, observedAt: request.now });
    if (correlated.outcome !== "correlated" && correlated.outcome !== "replayed") return result(request, correlated.outcome === "superseded" ? "superseded" : correlated.outcome === "ambiguous" ? "ambiguous" : correlated.outcome === "missing_evidence" ? "policy_blocked" : "conflict", correlated.message, { repository, pullRequest: pull, checked });
    if (release.state === "human_action_required") {
      const resumed = this.#store.releases.transition(request.releaseId, { to: "validating", expectedVersion: release.version, now: request.now });
      if (resumed.outcome !== "success") return storageOutcome(request, resumed, repository);
      release = resumed.value;
    }
    if (release.state === "validating") {
      const ready = this.#store.releases.transition(request.releaseId, { to: "ready_to_merge", expectedVersion: release.version, now: request.now, releasePullRequest: identity(pull) });
      if (ready.outcome !== "success") return storageOutcome(request, ready, repository);
      release = ready.value;
    }
    if (release.state !== "ready_to_merge") return result(request, "conflict", "Release did not reach the ready-to-merge state.", { repository, pullRequest: pull, checked });
    if (request.policy.requireMergeable === true && pull.mergeable !== true) return result(request, "policy_blocked", "GitHub does not report the exact Release pull request as mergeable.", { repository, pullRequest: pull, checked });
    if (request.policy.requiredApprovals > 0) {
      if (this.#pullRequests.getApprovedReviewCount === undefined) return result(request, "human_action_required", "Required Release review evidence is unavailable.", { repository, pullRequest: pull, checked });
      const approvals = await this.#pullRequests.getApprovedReviewCount(pull.number, context(request));
      if (approvals.outcome !== "success") return remoteOutcome(request, approvals, repository);
      if (approvals.value < request.policy.requiredApprovals) return result(request, "human_action_required", "Required Release approvals have not been granted.", { repository, pullRequest: pull, checked });
    }

    const headBeforeMerge = await this.#pullRequests.getBranchHead(release.sourceBranch, context(request));
    if (headBeforeMerge.outcome !== "success") return remoteOutcome(request, headBeforeMerge, repository);
    const pullBeforeMerge = await this.#pullRequests.getPullRequest(pull.number, context(request));
    if (pullBeforeMerge.outcome !== "success") return remoteOutcome(request, pullBeforeMerge, repository);
    if (headBeforeMerge.value.sha !== request.expectedReleaseHeadSha || !exactPull(pullBeforeMerge.value, release, request.expectedReleaseHeadSha) || pullBeforeMerge.value.state !== "open" || pullBeforeMerge.value.merged || (request.policy.requireMergeable === true && pullBeforeMerge.value.mergeable !== true)) return result(request, "stale", "Release head or pull request changed after checks and before merge.", { repository, pullRequest: pullBeforeMerge.value, checked });
    const merging = this.#store.releases.transition(request.releaseId, { to: "merging", expectedVersion: release.version, now: request.now, releasePullRequest: identity(pullBeforeMerge.value) });
    if (merging.outcome !== "success") return storageOutcome(request, merging, repository);
    release = merging.value;
    if (this.#pullRequests.mergePullRequest === undefined) return result(request, "provider_error", "The configured GitHub gateway has no centralized Release merge operation.", { repository, pullRequest: pullBeforeMerge.value, checked });
    let merged: GitHubOperationResult<GitHubPullRequestMergeResult>;
    try { merged = await this.#pullRequests.mergePullRequest(pull.number, request.expectedReleaseHeadSha, { idempotencyKey: "release-merge:" + request.releaseId, correlationId: request.correlationId, mergeMethod: request.policy.mergeMethod, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) }); }
    catch { return result(request, "reconciliation_required", "Release merge outcome is uncertain and must be reconciled.", { repository, pullRequest: pullBeforeMerge.value, checked }); }
    if (merged.outcome !== "success") {
      const reconciled = await this.#pullRequests.getPullRequest(pull.number, context(request));
      if (reconciled.outcome === "success" && exactPull(reconciled.value, release, request.expectedReleaseHeadSha) && reconciled.value.merged && reconciled.value.mergeCommitSha !== undefined) return this.#recordMerged(request, release, reconciled.value, reconciled.value.mergeCommitSha, correlated.record, checked);
      return remoteOutcome(request, merged, repository);
    }
    if (merged.value.sha !== undefined) return this.#recordMerged(request, release, pullBeforeMerge.value, merged.value.sha, correlated.record, checked);
    const afterMerge = await this.#pullRequests.getPullRequest(pull.number, context(request));
    if (afterMerge.outcome !== "success" || !afterMerge.value.merged || afterMerge.value.mergeCommitSha === undefined) return result(request, "reconciliation_required", "GitHub accepted the Release merge but no exact merge revision is observable yet.", { repository, pullRequest: pullBeforeMerge.value, checked });
    return this.#recordMerged(request, release, afterMerge.value, afterMerge.value.mergeCommitSha, correlated.record, checked);
  }

  async #resolvePullRequest(request: ReleaseMergeRequest, release: ReleaseRecord, correlation?: ReleaseCorrelationRecord): Promise<PullRequestResolution> {
    const repository = release.repository;
    if (correlation !== undefined) {
      const remote = await this.#pullRequests.getPullRequest(correlation.releasePullRequest.number, context(request));
      if (remote.outcome !== "success") return { outcome: "failed", result: remoteOutcome(request, remote, repository) };
      if (!samePull(correlation.releasePullRequest, remote.value)) return { outcome: "failed", result: result(request, "conflict", "Release pull request identity conflicts with durable correlation.", { repository, pullRequest: remote.value }) };
      return { outcome: "resolved", pullRequest: remote.value };
    }
    const listed = await this.#pullRequests.listPullRequests(release.sourceBranch, release.baseBranch, context(request));
    if (listed.outcome !== "success") return { outcome: "failed", result: remoteOutcome(request, listed, repository) };
    const candidates = listed.value.filter((pull) => pull.headBranch === release.sourceBranch && pull.baseBranch === release.baseBranch);
    if (candidates.length > 1) return { outcome: "failed", result: result(request, "ambiguous", "Multiple active release pull requests match the Release branches.", { repository }) };
    if (candidates.length === 1) return { outcome: "resolved", pullRequest: candidates[0]! };
    if (release.state === "human_action_required" && release.failureReason === UNCERTAIN_CREATE_REASON) return { outcome: "failed", result: result(request, "reconciliation_required", "Prior release PR creation remains uncertain; no retry was attempted.", { repository }) };
    if (release.state !== "validating") return { outcome: "failed", result: result(request, "conflict", "Release state does not permit pull request creation.", { repository }) };
    const body = marker(request.releaseId) + "\n\nPirx Release " + request.releaseId + ".\nSource: " + release.sourceBranch + " -> " + release.baseBranch + ".";
    const created = await this.#pullRequests.createPullRequest({ headBranch: release.sourceBranch, baseBranch: release.baseBranch, title: "Pirx Release " + request.releaseId, body, idempotencyKey: "release-pr:" + request.releaseId, correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) });
    if (created.outcome === "success") return { outcome: "resolved", pullRequest: created.value };
    if (created.outcome !== "unknown" && created.error.code !== "unknown") return { outcome: "failed", result: remoteOutcome(request, created, repository) };
    const reconciled = await this.#pullRequests.listPullRequests(release.sourceBranch, release.baseBranch, context(request));
    if (reconciled.outcome === "success") {
      const matching = reconciled.value.filter((pull) => pull.headBranch === release.sourceBranch && pull.baseBranch === release.baseBranch && pull.body?.includes(marker(request.releaseId)) === true);
      if (matching.length === 1) return { outcome: "resolved", pullRequest: matching[0]! };
      if (matching.length > 1) return { outcome: "failed", result: result(request, "ambiguous", "Uncertain release PR creation reconciled to multiple matching pull requests.", { repository }) };
    }
    const held = this.#store.releases.transition(request.releaseId, { to: "human_action_required", expectedVersion: release.version, now: request.now, failureReason: UNCERTAIN_CREATE_REASON });
    if (held.outcome !== "success") return { outcome: "failed", result: storageOutcome(request, held, repository) };
    return { outcome: "failed", result: result(request, "reconciliation_required", "Release PR creation is uncertain and was durably held for reconciliation.", { repository }) };
  }

  #recordMerged(request: ReleaseMergeRequest, release: ReleaseRecord, pull: GitHubPullRequest, mergeRevision: string, correlation: ReleaseCorrelationRecord | undefined, checked: readonly string[]): ReleaseMergeResult {
    const repository = release.repository;
    if (correlation === undefined || correlation.workflow === undefined) return result(request, "conflict", "Exact Release workflow correlation is missing before merge completion.", { repository, pullRequest: pull, checked });
    const correlated = this.#correlations.correlate({ releaseId: request.releaseId, repository, sourceBranch: release.sourceBranch, baseBranch: release.baseBranch, releasePullRequest: correlation.releasePullRequest, releaseHeadRevision: correlation.releaseHeadRevision, memberRevisions: correlation.memberRevisions, workflow: correlation.workflow, mergeRevision, observedAt: request.now });
    if (correlated.outcome !== "correlated" && correlated.outcome !== "replayed") return result(request, correlated.outcome === "superseded" ? "superseded" : "conflict", correlated.message, { repository, pullRequest: pull, checked });
    const current = this.#store.releases.get(request.releaseId);
    if (current.outcome !== "success") return storageOutcome(request, current, repository);
    if (["deploying", "production_verification", "deployed"].includes(current.value.state)) return result(request, "replayed", "Replayed the exact durable Release merge.", { repository, pullRequest: pull, checked, mergeRevision });
    if (current.value.state !== "merging") return result(request, "conflict", "Release state conflicts with the observed merge outcome.", { repository, pullRequest: pull, checked });
    const deploying = this.#store.releases.transition(request.releaseId, { to: "deploying", expectedVersion: current.value.version, now: request.now, releasePullRequest: correlation.releasePullRequest, mergeRevision });
    if (deploying.outcome !== "success") return storageOutcome(request, deploying, repository);
    return result(request, "merged", "Release PR merged after exact-current-head policy checks.", { repository, pullRequest: pull, checked, mergeRevision });
  }
}
