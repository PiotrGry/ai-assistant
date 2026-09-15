import { GitHubActionsWatcher, type GitHubActionsReadGateway, type GitHubActionsWorkflowRun, type GitHubActionsRunConclusion, type GitHubActionsWatchResult } from "./ci-watch.js";
import type { GitHubConfig } from "./config.js";
import type { CiEvidenceResult, CiFailureEvidence, CiJobEvidence, CiRun, CiRunByPullRequestQuery, CiRunResult, CiRunQueryContext, ProviderIndependentCiGateway } from "../runtime/ci-contract.js";

function result(outcome: CiRunResult["outcome"], message: string, polls = 0, run?: CiRun, evidence?: CiFailureEvidence): CiRunResult { return { outcome, message, polls, ...(run === undefined ? {} : { run }), ...(evidence === undefined ? {} : { evidence }) }; }
function conclusion(value: GitHubActionsRunConclusion): NonNullable<CiRun["conclusion"]> {
  const known: ReadonlySet<string> = new Set(["success", "failure", "cancelled", "neutral", "skipped", "timed_out", "action_required", "startup_failure", "unknown"]);
  return !known.has(value) || value === "stale" ? "unknown" : value;
}
const KNOWN_STATUSES: ReadonlySet<string> = new Set(["requested", "queued", "waiting", "pending", "in_progress", "completed"]);
function status(value: GitHubActionsWorkflowRun["status"]): CiRun["status"] {
  return KNOWN_STATUSES.has(value) ? value : "unknown";
}
function mapRun(run: GitHubActionsWorkflowRun): CiRun {
  return {
    schemaVersion: 1,
    provider: "github-actions",
    providerRunId: String(run.id),
    ...(run.workflowId === undefined ? {} : { pipeline: { provider: "github-actions", providerPipelineId: String(run.workflowId), ...(run.name === undefined ? {} : { name: run.name }), url: run.url } }),
    ...(run.name === undefined ? {} : { name: run.name }),
    status: status(run.status),
    ...(run.conclusion === undefined ? {} : { conclusion: conclusion(run.conclusion) }),
    testedRevision: run.headSha,
    ...(run.headBranch === undefined ? {} : { headBranch: run.headBranch }),
    pullRequestNumbers: run.pullRequestNumbers,
    url: run.url,
    ...(run.createdAt === undefined ? {} : { startedAt: run.createdAt }),
    ...(run.status === "completed" && run.updatedAt !== undefined ? { completedAt: run.updatedAt } : {}),
  };
}
function mapFailure(watched: GitHubActionsWatchResult): CiRunResult {
  if (watched.outcome === "success") {
    const run: CiRun = { schemaVersion: 1, provider: "github-actions", providerRunId: String(watched.workflowRunId), ...(watched.workflowName === undefined ? {} : { name: watched.workflowName }), status: "completed", conclusion: "success", testedRevision: watched.testedRevision, url: watched.runUrl, pullRequestNumbers: watched.pullRequestNumber === undefined ? [] : [watched.pullRequestNumber] };
    return result("success", "The exact GitHub Actions workflow completed successfully.", watched.polls, run);
  }
  if ((watched.outcome === "failed" || watched.outcome === "cancelled") && "testedRevision" in watched) {
    const run: CiRun = { schemaVersion: 1, provider: "github-actions", providerRunId: String(watched.workflowRunId), ...(watched.workflowName === undefined ? {} : { name: watched.workflowName }), status: "completed", conclusion: conclusion(watched.conclusion), testedRevision: watched.testedRevision, url: watched.runUrl, pullRequestNumbers: watched.pullRequestNumber === undefined ? [] : [watched.pullRequestNumber] };
    return result(watched.outcome === "cancelled" ? "cancelled" : watched.conclusion === "timed_out" ? "timed_out" : "failed", "The exact GitHub Actions workflow completed without success.", watched.polls, run);
  }
  const outcome = watched.outcome === "timeout" ? "timed_out" : watched.outcome === "ambiguous" ? "ambiguous" : watched.outcome === "stale" ? "stale" : watched.outcome === "not_found" ? "not_found" : watched.outcome === "rate_limited" ? "rate_limited" : watched.outcome === "cancelled" ? "cancelled" : watched.outcome === "unknown" ? "unknown" : "unavailable";
  return result(outcome, "The exact GitHub Actions workflow could not be accepted.", watched.polls);
}

function remoteFailureOutcome(remote: Exclude<Awaited<ReturnType<GitHubActionsReadGateway["getWorkflowRun"]>>, { outcome: "success" }>): CiRunResult["outcome"] {
  if (remote.outcome === "rate_limited" || remote.error.code === "rate_limited") return "rate_limited";
  if (remote.error.code === "timeout") return "timed_out";
  if (remote.error.code === "cancelled") return "cancelled";
  if (remote.outcome === "retryable_error" || remote.error.code === "retryable" || remote.error.code === "network") return "retryable";
  if (remote.outcome === "unknown" || remote.error.code === "unknown") return "unknown";
  if (remote.error.code === "not_found") return "not_found";
  if (remote.error.code === "authentication" || remote.error.code === "forbidden") return "unavailable";
  return "permanent";
}

function boundedLimit(value: number | undefined, defaultValue: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, value ?? defaultValue));
}

export class GitHubCiGatewayAdapter implements ProviderIndependentCiGateway {
  readonly #gateway: GitHubActionsReadGateway;
  readonly #config: GitHubConfig;
  public constructor(gateway: GitHubActionsReadGateway, config: GitHubConfig) { this.#gateway = gateway; this.#config = config; }
  public async getRun(providerRunId: string, context: CiRunQueryContext): Promise<CiRunResult> {
    if (!/^[0-9]+$/u.test(providerRunId)) return result("permanent", "Provider run identity is invalid.");
    const remote = await this.#gateway.getWorkflowRun(Number(providerRunId), context);
    if (remote.outcome !== "success") return result(remoteFailureOutcome(remote), "GitHub Actions run could not be read.");
    const run = mapRun(remote.value);
    if (run.status === "unknown" || run.conclusion === "unknown") return result("unknown", "The GitHub Actions run has an unsupported status or conclusion.", 1, run);
    return run.status === "completed" && run.conclusion === "success" ? result("success", "The exact GitHub Actions run succeeded.", 1, run) : run.status === "completed" ? result(run.conclusion === "cancelled" ? "cancelled" : run.conclusion === "timed_out" ? "timed_out" : "failed", "The GitHub Actions run is terminal and not successful.", 1, run) : result("pending", "The GitHub Actions run is not terminal.", 1, run);
  }
  public async resolvePullRequest(query: CiRunByPullRequestQuery, context: CiRunQueryContext): Promise<CiRunResult> {
    if (!Number.isSafeInteger(query.pullRequestNumber) || query.pullRequestNumber <= 0 || query.expectedHeadSha.trim().length === 0) return result("permanent", "Pull request CI identity is invalid.");
    const watched = await new GitHubActionsWatcher(this.#gateway, this.#config).watch({
      pullRequestNumber: query.pullRequestNumber,
      expectedHeadSha: query.expectedHeadSha,
      ...(query.requiredWorkflowName === undefined ? {} : { requiredWorkflowName: query.requiredWorkflowName }),
      ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
      ...(context.pollIntervalMs === undefined ? {} : { pollIntervalMs: context.pollIntervalMs }),
      ...(context.maxFailedJobs === undefined ? {} : { maxFailedJobs: context.maxFailedJobs }),
      ...(context.maxFailedSteps === undefined ? {} : { maxFailedSteps: context.maxFailedSteps }),
      correlationId: context.correlationId,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    return mapFailure(watched);
  }
  public async getFailureEvidence(run: CiRun, context: CiRunQueryContext): Promise<CiEvidenceResult> {
    if (run.provider !== "github-actions" || !/^[0-9]+$/u.test(run.providerRunId)) return { outcome: "permanent", message: "CI run provider identity is invalid." };
    const jobs = await this.#gateway.listWorkflowRunJobs(Number(run.providerRunId), context);
    if (jobs.outcome !== "success") return { outcome: remoteFailureOutcome(jobs), message: "CI failure evidence could not be read." };
    const maxJobs = boundedLimit(context.maxFailedJobs, 10, 10);
    const maxSteps = boundedLimit(context.maxFailedSteps, 20, 20);
    const failedJobs: CiJobEvidence[] = jobs.value.failedJobs.slice(0, maxJobs).map((job) => ({ providerJobId: String(job.id), name: job.name, ...(job.url === undefined ? {} : { url: job.url }), conclusion: "failure", failedSteps: job.failedSteps.slice(0, maxSteps) }));
    return { outcome: "success", evidence: { schemaVersion: 1, provider: run.provider, providerRunId: run.providerRunId, run, failedJobs }, message: "Bounded CI failure evidence was read." };
  }
}
