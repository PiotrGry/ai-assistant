export const CI_RUN_SCHEMA_VERSION = 1 as const;
export type CiRunStatus = "requested" | "queued" | "waiting" | "pending" | "in_progress" | "completed" | "unknown";
export type CiConclusion = "success" | "failure" | "cancelled" | "neutral" | "skipped" | "timed_out" | "action_required" | "startup_failure" | "unknown";
export type CiResolutionOutcome = "success" | "pending" | "failed" | "cancelled" | "timed_out" | "not_found" | "ambiguous" | "stale" | "rate_limited" | "retryable" | "permanent" | "unknown" | "unavailable";
export interface CiPipelineIdentity { readonly provider: string; readonly providerPipelineId: string; readonly name?: string; readonly url?: string; }
export interface CiRunIdentity { readonly provider: string; readonly providerRunId: string; }
export interface CiStepReference { readonly name: string; readonly number?: number; }
export interface CiJobIdentity { readonly provider: string; readonly providerJobId: string; }
export interface CiCheckIdentity { readonly provider: string; readonly providerCheckId: string; }
export interface CiCheck extends CiCheckIdentity {
  readonly name: string;
  readonly status: CiRunStatus;
  readonly conclusion?: CiConclusion;
  readonly url?: string;
  readonly testedRevision: string;
}
export interface CiJob extends CiJobIdentity {
  readonly name: string;
  readonly status: CiRunStatus;
  readonly conclusion?: CiConclusion;
  readonly url?: string;
  readonly testedRevision: string;
  readonly failedSteps: readonly CiStepReference[];
}
export interface CiJobEvidence { readonly providerJobId: string; readonly name: string; readonly url?: string; readonly conclusion: CiConclusion; readonly failedSteps: readonly CiStepReference[]; }
export interface CiRun extends CiRunIdentity {
  readonly schemaVersion: typeof CI_RUN_SCHEMA_VERSION;
  readonly pipeline?: CiPipelineIdentity;
  readonly name?: string;
  readonly status: CiRunStatus;
  readonly conclusion?: CiConclusion;
  readonly testedRevision: string;
  readonly headBranch?: string;
  readonly pullRequestNumbers: readonly number[];
  readonly url: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly checks?: readonly CiCheck[];
}
export interface CiFailureEvidence {
  readonly schemaVersion: typeof CI_RUN_SCHEMA_VERSION;
  readonly provider: string;
  readonly providerRunId: string;
  readonly run: CiRun;
  readonly failedJobs: readonly CiJobEvidence[];
}
export interface CiRunQueryContext {
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxFailedJobs?: number;
  readonly maxFailedSteps?: number;
}
export interface CiRunByPullRequestQuery { readonly pullRequestNumber: number; readonly expectedHeadSha: string; readonly requiredWorkflowName?: string; }
export type CiRunResult = { readonly outcome: CiResolutionOutcome; readonly run?: CiRun; readonly evidence?: CiFailureEvidence; readonly message: string; readonly polls: number };
export type CiEvidenceResult = { readonly outcome: CiResolutionOutcome; readonly evidence?: CiFailureEvidence; readonly message: string };
export type CiFailureLogResult = { readonly outcome: "success" | "unavailable" | "rate_limited" | "retryable" | "permanent" | "unknown"; readonly excerpt?: string; readonly message: string };
export interface ProviderIndependentCiGateway {
  getRun(providerRunId: string, context: CiRunQueryContext): Promise<CiRunResult>;
  resolvePullRequest(query: CiRunByPullRequestQuery, context: CiRunQueryContext): Promise<CiRunResult>;
  getFailureEvidence(run: CiRun, context: CiRunQueryContext): Promise<CiEvidenceResult>;
  getFailureLogExcerpt?(run: CiRun, context: CiRunQueryContext): Promise<CiFailureLogResult>;
}
