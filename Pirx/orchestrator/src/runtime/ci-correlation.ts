import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";
import type { ReleasePullRequestIdentity } from "./release.js";
import type { CiResolutionOutcome, CiRun, CiRunByPullRequestQuery, CiRunQueryContext, CiRunResult, ProviderIndependentCiGateway } from "./ci-contract.js";
import type { PullRequestProvenanceRecord, RuntimeSqliteStore, StorageResult } from "./sqlite.js";

export const CI_CORRELATION_SCHEMA_VERSION = 1 as const;
export type CiCorrelationState = Exclude<CiResolutionOutcome, "pending"> | "pending";

/**
 * States where the CI run may still finish: Pirx's bounded poll ended, the
 * provider was briefly unavailable, or the run was cancelled and can be re-run.
 * They are re-observed on every delivery cycle instead of being final.
 */
export const CI_REOBSERVABLE_STATES: readonly CiCorrelationState[] = Object.freeze(["pending", "timed_out", "retryable", "rate_limited", "unavailable", "cancelled"]);
export function isReobservableCiState(state: CiCorrelationState): boolean { return CI_REOBSERVABLE_STATES.includes(state); }

/** GitHub can take minutes to register a run for a new head; until then "no run" is not evidence. */
export const CI_RUN_REGISTRATION_GRACE_MS = 30 * 60_000;

export interface CiCorrelationInput {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueNodeId: string;
  readonly issueUrl: string;
  readonly featurePullRequest: ReleasePullRequestIdentity;
  readonly workerId: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly pushedCommit: string;
  /** Provider of the CI system observing the pushed revision, not the worker provider on Attempt. */
  readonly provider: string;
  readonly requiredWorkflowName: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
}

export interface CiCorrelationRecord extends CiCorrelationInput {
  readonly schemaVersion: typeof CI_CORRELATION_SCHEMA_VERSION;
  readonly providerRunId?: string;
  readonly providerRunUrl?: string;
  readonly workflowName?: string;
  readonly providerPipelineId?: string;
  readonly testedRevision?: string;
  readonly state: CiCorrelationState;
  readonly observedAt?: UtcTimestamp;
  readonly version: number;
}

export interface CiCorrelationObservation {
  readonly state: CiCorrelationState;
  readonly run?: CiRun;
  readonly observedAt: UtcTimestamp;
}

export interface CiCorrelationRequest {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repository: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly featurePullRequestNumber: number;
  readonly expectedHeadSha: string;
  readonly provider: string;
  readonly requiredWorkflowName: string;
  readonly correlationId: string;
  readonly now: UtcTimestamp;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxFailedJobs?: number;
  readonly maxFailedSteps?: number;
  readonly signal?: AbortSignal;
}

export type CiCorrelationResult =
  | { readonly outcome: "observed" | "replayed"; readonly state: CiCorrelationState; readonly record: CiCorrelationRecord; readonly ci?: CiRunResult; readonly message: string }
  | { readonly outcome: "conflict" | "storage_error"; readonly message: string };

function failure(message: string, outcome: "conflict" | "storage_error" = "conflict"): CiCorrelationResult { return { outcome, message }; }
function correlationInput(provenance: PullRequestProvenanceRecord, request: CiCorrelationRequest): CiCorrelationInput {
  return {
    taskId: request.taskId,
    attemptId: request.attemptId,
    repository: request.repository,
    issueNumber: provenance.issueNumber,
    issueNodeId: provenance.issueNodeId,
    issueUrl: provenance.issueUrl,
    featurePullRequest: provenance.pullRequest,
    workerId: provenance.workerId,
    headBranch: request.headBranch,
    baseBranch: request.baseBranch,
    pushedCommit: request.expectedHeadSha,
    provider: request.provider,
    requiredWorkflowName: request.requiredWorkflowName,
    createdAt: request.now,
    updatedAt: request.now,
  };
}

function laterTimestamp(left: UtcTimestamp, right: UtcTimestamp): UtcTimestamp { return Date.parse(right) > Date.parse(left) ? right : left; }

function stateFromCi(result: CiRunResult, expected: CiCorrelationRecord, now: UtcTimestamp): CiCorrelationObservation {
  // CiCorrelation.provider is the CI provider. Attempt.provider identifies the code worker
  // and is intentionally a separate identity domain.
  if (result.run !== undefined && (result.run.provider !== expected.provider || result.run.testedRevision !== expected.pushedCommit || result.run.headBranch !== expected.headBranch || result.run.name !== expected.requiredWorkflowName || !result.run.pullRequestNumbers.includes(expected.featurePullRequest.number))) return { state: "stale", observedAt: laterTimestamp(expected.updatedAt, now) };
  return { state: result.outcome, ...(result.run === undefined ? {} : { run: result.run }), observedAt: laterTimestamp(expected.updatedAt, now) };
}

export class CiCorrelationService {
  readonly #store: RuntimeSqliteStore;
  readonly #gateway: ProviderIndependentCiGateway;

  public constructor(store: RuntimeSqliteStore, gateway: ProviderIndependentCiGateway) { this.#store = store; this.#gateway = gateway; }

  public async observe(request: CiCorrelationRequest): Promise<CiCorrelationResult> {
    const provenance = this.#store.pullRequests.getByTaskAttempt(request.taskId, request.attemptId);
    if (provenance.outcome !== "success") return failure(provenance.message, provenance.outcome === "storage_error" ? "storage_error" : "conflict");
    if (provenance.value.repository !== request.repository || provenance.value.headBranch !== request.headBranch || provenance.value.baseBranch !== request.baseBranch || provenance.value.pullRequest.number !== request.featurePullRequestNumber || provenance.value.observedHeadSha !== request.expectedHeadSha || request.provider.trim().length === 0 || request.requiredWorkflowName.trim().length === 0) return failure("CI correlation request does not match durable feature pull request provenance.");
    const input = correlationInput(provenance.value, request);
    const started = this.#store.ciCorrelations.start(input);
    if (started.outcome !== "success") return failure(started.message, started.outcome === "storage_error" ? "storage_error" : "conflict");
    if (!isReobservableCiState(started.value.state)) return { outcome: "replayed", state: started.value.state, record: started.value, message: "Replayed the durable CI correlation." };
    const query: CiRunByPullRequestQuery = { pullRequestNumber: request.featurePullRequestNumber, expectedHeadSha: request.expectedHeadSha, requiredWorkflowName: request.requiredWorkflowName };
    const context: CiRunQueryContext = { correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.pollIntervalMs === undefined ? {} : { pollIntervalMs: request.pollIntervalMs }), ...(request.maxFailedJobs === undefined ? {} : { maxFailedJobs: request.maxFailedJobs }), ...(request.maxFailedSteps === undefined ? {} : { maxFailedSteps: request.maxFailedSteps }), ...(request.signal === undefined ? {} : { signal: request.signal }) };
    let observed: CiRunResult;
    try { observed = await this.#gateway.resolvePullRequest(query, context); } catch { return failure("CI provider observation failed before a normalized result was returned.", "storage_error"); }
    const normalized = stateFromCi(observed, started.value, request.now);
    // No run for this exact head yet (just pushed): keep waiting instead of recording stale or not_found.
    if (observed.run === undefined && (normalized.state === "not_found" || normalized.state === "stale") && Date.parse(request.now) - Date.parse(started.value.createdAt) < CI_RUN_REGISTRATION_GRACE_MS) {
      return { outcome: "observed", state: "pending", record: started.value, ci: observed, message: `No "${request.requiredWorkflowName}" run for ${request.expectedHeadSha.slice(0, 7)} yet; Pirx checks again next cycle.` };
    }
    const saved = this.#store.ciCorrelations.recordObservation(request.taskId, request.attemptId, normalized);
    if (saved.outcome !== "success") return failure(saved.message, saved.outcome === "storage_error" ? "storage_error" : "conflict");
    return { outcome: "observed", state: saved.value.state, record: saved.value, ci: observed, message: "CI observation was durably correlated." };
  }

  public getByTaskAttempt(taskId: string, attemptId: string): StorageResult<CiCorrelationRecord> { return this.#store.ciCorrelations.getByTaskAttempt(taskId, attemptId); }
  public getByPullRequest(repository: string, number: number): StorageResult<CiCorrelationRecord> { return this.#store.ciCorrelations.getByPullRequest(repository, number); }
  public getByCommit(repository: string, commit: string): StorageResult<CiCorrelationRecord> { return this.#store.ciCorrelations.getByCommit(repository, commit); }
  public getByProviderRun(provider: string, providerRunId: string): StorageResult<CiCorrelationRecord> { return this.#store.ciCorrelations.getByProviderRun(provider, providerRunId); }
}
