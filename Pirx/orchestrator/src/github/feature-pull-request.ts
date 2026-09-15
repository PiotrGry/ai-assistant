import { createHash } from "node:crypto";

import type { PullRequestProvenanceInput, PullRequestProvenanceRecord, RuntimeSqliteStore } from "../runtime/sqlite.js";
import type { AttemptSnapshot, TaskSnapshot, UtcTimestamp } from "../runtime/task-domain.js";
import { failure, type GitHubOperationResult } from "./outcome.js";
import type { GitHubRequestContext } from "./transport-types.js";
import type { GitHubPullRequest, GitHubPullRequestGatewayPort } from "./pull-request.js";

export type FeaturePullRequestOutcome = "created" | "reused" | "replayed" | "reconciled" | "stale_head" | "conflict" | "ambiguous" | "not_found" | "authorization_required" | "rate_limited" | "pending" | "reconciliation_required" | "invalid_request" | "provider_error";
export interface FeaturePullRequestRequest {
  readonly taskId: string;
  readonly attemptId: string;
  readonly repository: { readonly owner: string; readonly repository: string };
  readonly baseBranch: string;
  readonly expectedHeadSha: string;
  readonly correlationId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface FeaturePullRequestResult {
  readonly outcome: FeaturePullRequestOutcome;
  readonly taskId: string;
  readonly attemptId: string;
  readonly repository: string;
  readonly message: string;
  readonly pullRequest?: GitHubPullRequest;
  readonly provenance?: PullRequestProvenanceRecord;
}

const SAFE_SHA = /^[A-Za-z0-9._-]{4,128}$/u;
const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,512}$/u;
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function marker(taskId: string, attemptId: string): string { return "<!-- pirx-feature-pr-provenance:v1 " + digest(taskId + "\u0000" + attemptId) + " -->"; }
function generic(outcome: FeaturePullRequestOutcome, request: FeaturePullRequestRequest, message: string, extra: Partial<FeaturePullRequestResult> = {}): FeaturePullRequestResult { return { outcome, taskId: request.taskId, attemptId: request.attemptId, repository: request.repository.owner + "/" + request.repository.repository, message, ...extra }; }
function context(request: FeaturePullRequestRequest): GitHubRequestContext { return { correlationId: request.correlationId, ...(request.signal === undefined ? {} : { signal: request.signal }), ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) }; }
function mapRemote<T>(request: FeaturePullRequestRequest, remote: Exclude<GitHubOperationResult<T>, { outcome: "success" }>): FeaturePullRequestResult {
  const code = remote.error.code;
  const outcome: FeaturePullRequestOutcome = code === "authentication" || code === "forbidden" ? "authorization_required" : code === "rate_limited" ? "rate_limited" : code === "not_found" ? "not_found" : code === "conflict" ? "conflict" : remote.outcome === "unknown" ? "reconciliation_required" : code === "timeout" || code === "cancelled" ? "pending" : "provider_error";
  return generic(outcome, request, outcome === "authorization_required" ? "GitHub authorization is required." : outcome === "rate_limited" ? "GitHub rate limit blocked the feature PR operation." : outcome === "reconciliation_required" ? "The GitHub mutation outcome is uncertain and requires reconciliation." : "GitHub feature PR operation did not complete.");
}
function validRequest(request: FeaturePullRequestRequest): string | undefined {
  if (request.taskId.trim().length === 0 || request.attemptId.trim().length === 0 || request.correlationId.trim().length === 0) return "Task, Attempt, and correlation identities are required.";
  if (request.repository.owner.trim().length === 0 || request.repository.repository.trim().length === 0 || !SAFE_BRANCH.test(request.baseBranch) || !SAFE_SHA.test(request.expectedHeadSha)) return "Repository, base branch, or expected head revision is invalid.";
  return undefined;
}
function exactPull(pull: GitHubPullRequest, head: string, base: string, sha: string): boolean { return pull.state === "open" && !pull.merged && pull.headBranch === head && pull.baseBranch === base && pull.headSha === sha; }

export class GitHubFeaturePullRequestService {
  readonly #store: RuntimeSqliteStore;
  readonly #gateway: GitHubPullRequestGatewayPort;
  readonly #now: () => UtcTimestamp;
  readonly #configuredBaseBranch: string;
  public constructor(store: RuntimeSqliteStore, gateway: GitHubPullRequestGatewayPort, options: { readonly now?: () => UtcTimestamp; readonly configuredBaseBranch?: string } = {}) { this.#store = store; this.#gateway = gateway; this.#now = options.now ?? (() => new Date().toISOString() as UtcTimestamp); this.#configuredBaseBranch = options.configuredBaseBranch ?? "develop"; }

  public async createOrReuse(request: FeaturePullRequestRequest): Promise<FeaturePullRequestResult> {
    const invalid = validRequest(request);
    if (invalid !== undefined) return generic("invalid_request", request, invalid);
    if (request.baseBranch !== this.#configuredBaseBranch) return generic("conflict", request, "Requested base branch is not the configured feature base.");
    const task = this.#store.tasks.get(request.taskId); const attempt = this.#store.attempts.get(request.attemptId);
    if (task.outcome !== "success" || attempt.outcome !== "success") return generic("not_found", request, "Assigned Task or Attempt was not found.");
    const identity = this.#validateAssignment(request, task.value, attempt.value);
    if (identity !== undefined) return generic("conflict", request, identity);
    const stored = this.#store.pullRequests.getByTaskAttempt(request.taskId, request.attemptId);
    if (stored.outcome === "success") return this.#replay(request, stored.value);
    if (stored.outcome !== "not_found") return generic("provider_error", request, "Durable pull request provenance could not be read.");
    const contextValue = context(request);
    const branch = attempt.value.branch!;
    const head = await this.#gateway.getBranchHead(branch, contextValue);
    if (head.outcome !== "success") return mapRemote(request, head);
    if (head.value.sha !== request.expectedHeadSha) return generic("stale_head", request, "Assigned branch head changed before pull request creation.");
    const listed = await this.#gateway.listPullRequests(branch, request.baseBranch, contextValue);
    if (listed.outcome !== "success") return mapRemote(request, listed);
    const candidates = listed.value.filter((pull) => pull.headBranch === branch && pull.baseBranch === request.baseBranch);
    if (candidates.length > 1) return generic("ambiguous", request, "Multiple open pull requests match the exact branch and base.");
    const candidate = candidates[0];
    if (candidate !== undefined) return this.#reuseCandidate(request, task.value, attempt.value, candidate);
    const issue = task.value.githubReference!;
    const body = marker(request.taskId, request.attemptId) + "\n\nPirx Task " + request.taskId + " / Attempt " + request.attemptId + ".\nLinked GitHub Issue: " + issue.url + ".\nWorker: " + attempt.value.worker + ".\nFeature branch: " + branch + " → " + request.baseBranch + ".";
    const created = await this.#gateway.createPullRequest({ headBranch: branch, baseBranch: request.baseBranch, title: "Pirx feature work for Task " + request.taskId, body, idempotencyKey: "feature-pr:" + request.taskId + ":" + request.attemptId, correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) });
    if (created.outcome !== "success") {
      if (created.outcome === "unknown" || created.error.code === "unknown") return this.#reconcileUnknownCreate(request, task.value, attempt.value);
      return mapRemote(request, created);
    }
    return this.#persistRemote(request, task.value, attempt.value, created.value, "created");
  }

  #validateAssignment(request: FeaturePullRequestRequest, task: TaskSnapshot, attempt: AttemptSnapshot): string | undefined {
    const issue = task.githubReference;
    if (attempt.state !== "terminal" || attempt.result !== "CODE_PUSHED" || attempt.branch === undefined || attempt.finalCommit === undefined) return "Feature PR requires a terminal CODE_PUSHED Attempt.";
    if (attempt.taskId !== request.taskId || attempt.branch === undefined || attempt.finalCommit !== request.expectedHeadSha || issue === undefined || issue.nodeId === undefined || issue.url === undefined || issue.owner !== request.repository.owner || issue.repository !== request.repository.repository) return "Task, Attempt, repository, branch, or pushed revision does not match.";
    return undefined;
  }

  async #replay(request: FeaturePullRequestRequest, stored: PullRequestProvenanceRecord): Promise<FeaturePullRequestResult> {
    if (stored.baseBranch !== request.baseBranch || stored.observedHeadSha !== request.expectedHeadSha || stored.repository !== request.repository.owner + "/" + request.repository.repository) return generic("conflict", request, "Stored pull request provenance conflicts with the requested identity.", { provenance: stored });
    const remote = await this.#gateway.getPullRequest(stored.pullRequest.number, context(request));
    if (remote.outcome !== "success") return mapRemote(request, remote);
    if (!exactPull(remote.value, stored.headBranch, stored.baseBranch, stored.observedHeadSha)) return generic("stale_head", request, "Stored pull request no longer matches its durable branch, base, or revision.", { provenance: stored, pullRequest: remote.value });
    return generic("replayed", request, "Replayed the durable feature pull request relationship.", { pullRequest: remote.value, provenance: stored });
  }

  async #reuseCandidate(request: FeaturePullRequestRequest, task: TaskSnapshot, attempt: AttemptSnapshot, candidate: GitHubPullRequest): Promise<FeaturePullRequestResult> {
    const currentMarker = candidate.body?.includes(marker(request.taskId, request.attemptId)) === true;
    const prior = this.#store.pullRequests.getByPullRequest(request.repository.owner + "/" + request.repository.repository, candidate.number);
    const sameTaskRetry = prior.outcome === "success" && prior.value.taskId === request.taskId && prior.value.headBranch === attempt.branch && prior.value.baseBranch === request.baseBranch;
    if (!currentMarker && !sameTaskRetry) return generic("conflict", request, "An existing feature pull request has incompatible Pirx provenance.", { pullRequest: candidate });
    if (!exactPull(candidate, attempt.branch!, request.baseBranch, request.expectedHeadSha)) return generic("stale_head", request, "Existing feature pull request does not point at the exact pushed revision.", { pullRequest: candidate });
    return this.#persistRemote(request, task, attempt, candidate, "reused");
  }

  async #reconcileUnknownCreate(request: FeaturePullRequestRequest, task: TaskSnapshot, attempt: AttemptSnapshot): Promise<FeaturePullRequestResult> {
    const listed = await this.#gateway.listPullRequests(attempt.branch!, request.baseBranch, context(request));
    if (listed.outcome !== "success") return generic("reconciliation_required", request, "Pull request creation is uncertain and reconciliation read did not complete.");
    const matching = listed.value.filter((pull) => pull.headBranch === attempt.branch && pull.baseBranch === request.baseBranch && pull.body?.includes(marker(request.taskId, request.attemptId)) === true);
    if (matching.length !== 1) return generic(matching.length > 1 ? "ambiguous" : "reconciliation_required", request, "Pull request creation is uncertain and cannot be reconciled to exactly one PR.");
    const candidate = matching[0]!;
    if (!exactPull(candidate, attempt.branch!, request.baseBranch, request.expectedHeadSha)) return generic("stale_head", request, "Reconciled pull request does not point at the exact pushed revision.", { pullRequest: candidate });
    return this.#persistRemote(request, task, attempt, candidate, "reconciled");
  }

  async #persistRemote(request: FeaturePullRequestRequest, task: TaskSnapshot, attempt: AttemptSnapshot, pull: GitHubPullRequest, outcome: "created" | "reused" | "reconciled"): Promise<FeaturePullRequestResult> {
    const issue = task.githubReference!;
    const input: PullRequestProvenanceInput = { taskId: request.taskId as PullRequestProvenanceInput["taskId"], attemptId: request.attemptId as PullRequestProvenanceInput["attemptId"], repository: request.repository.owner + "/" + request.repository.repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId!, issueUrl: issue.url!, workerId: attempt.worker, headBranch: attempt.branch!, baseBranch: request.baseBranch, observedHeadSha: request.expectedHeadSha, pullRequest: { nodeId: "pr:" + pull.number, number: pull.number, url: pull.url }, createdAt: this.#now(), updatedAt: this.#now() };
    const saved = this.#store.pullRequests.save(input);
    if (saved.outcome !== "success") return generic(saved.outcome === "conflict" ? "conflict" : "provider_error", request, "Feature pull request was not durably correlated.");
    return generic(outcome, request, outcome === "created" ? "Created and durably correlated the feature pull request." : "Reused and durably correlated the feature pull request.", { pullRequest: pull, provenance: saved.value });
  }
}
