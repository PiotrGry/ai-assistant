import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ReleaseMergeCoordinator,
  RuntimeSqliteStore,
  createTask,
  failure,
  releaseId,
  success,
  transitionAttempt,
  type AttemptId,
  type CiRunResult,
  type GitHubOperationResult,
  type GitHubPullRequest,
  type GitHubPullRequestCreateInput,
  type GitHubPullRequestGatewayPort,
  type GitHubPullRequestMergeResult,
  type GitHubRequestContext,
  type ProviderIndependentCiGateway,
  type ReleaseMergePolicy,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-10-29T10:00:00.000Z" as UtcTimestamp;
const t1 = "2026-10-29T10:01:00.000Z" as UtcTimestamp;
const t2 = "2026-10-29T10:02:00.000Z" as UtcTimestamp;
const releaseHead = "cccccccccccccccccccccccccccccccccccccccc";
const mergeRevision = "dddddddddddddddddddddddddddddddddddddddd";
const repository = "PiotrGry/ai-assistant";
const policy: ReleaseMergePolicy = { requiredChecks: ["Main CI", "Security"], requiredApprovals: 1, mergeMethod: "merge", requireMergeable: true };

class FakeCi implements ProviderIndependentCiGateway {
  result?: CiRunResult;
  calls: string[] = [];
  async getRun(): Promise<CiRunResult> { return { outcome: "not_found", message: "unused", polls: 1 }; }
  async getFailureEvidence(): Promise<CiRunResult> { return { outcome: "not_found", message: "unused", polls: 1 }; }
  async resolvePullRequest(query: { readonly pullRequestNumber: number; readonly expectedHeadSha: string; readonly requiredWorkflowName?: string }): Promise<CiRunResult> {
    const name = query.requiredWorkflowName ?? "Main CI";
    this.calls.push(name);
    return this.result ?? { outcome: "success", run: { schemaVersion: 1, provider: "github-actions", providerRunId: "run-" + name, name, status: "completed", conclusion: "success", testedRevision: query.expectedHeadSha, headBranch: "develop", pullRequestNumbers: [query.pullRequestNumber], url: "https://github.com/PiotrGry/ai-assistant/actions/runs/500" }, message: "green", polls: 1 };
  }
}

class FakePullRequests implements GitHubPullRequestGatewayPort {
  headSha = releaseHead;
  pulls: GitHubPullRequest[] = [];
  commits: string[] = [];
  approvals = 1;
  createMode: "success" | "unknown_applied" | "unknown_unresolved" = "success";
  mergeMode: "success" | "unknown_applied" | "unknown_unresolved" | "rate" = "success";
  calls = { branch: 0, list: 0, get: 0, commits: 0, create: 0, merge: 0, approvals: 0 };
  readonly mergeKeys = new Set<string>();

  async getBranchHead(branch: string, context: GitHubRequestContext) { this.calls.branch += 1; return success({ branch, sha: this.headSha }, context.correlationId); }
  async listPullRequests(_head: string, _base: string, context: GitHubRequestContext) { this.calls.list += 1; return success(this.pulls.filter((pull) => pull.state === "open"), context.correlationId); }
  async getPullRequest(number: number, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubPullRequest>> { this.calls.get += 1; const pull = this.pulls.find((candidate) => candidate.number === number); return pull === undefined ? failure("permanent_error", "not_found", "missing", context.correlationId, "not_accepted") : success(pull, context.correlationId); }
  async listPullRequestCommitShas(_number: number, context: GitHubRequestContext) { this.calls.commits += 1; return success(Object.freeze([...this.commits]), context.correlationId); }
  async createPullRequest(input: GitHubPullRequestCreateInput): Promise<GitHubOperationResult<GitHubPullRequest>> {
    this.calls.create += 1;
    const pull: GitHubPullRequest = { number: 500, url: "https://github.com/PiotrGry/ai-assistant/pull/500", state: "open", title: input.title, body: input.body, headBranch: input.headBranch, headSha: this.headSha, baseBranch: input.baseBranch, merged: false, mergeable: true };
    if (this.createMode !== "unknown_unresolved") this.pulls = [pull];
    return this.createMode === "success" ? success(pull, input.correlationId) : failure("unknown", "unknown", "uncertain", input.correlationId, "unknown");
  }
  async mergePullRequest(number: number, _expected: string, input: { readonly correlationId: string; readonly idempotencyKey: string }): Promise<GitHubOperationResult<GitHubPullRequestMergeResult>> {
    if (this.mergeKeys.has(input.idempotencyKey)) return success({ merged: true, sha: mergeRevision }, input.correlationId);
    this.mergeKeys.add(input.idempotencyKey);
    this.calls.merge += 1;
    if (this.mergeMode === "rate") return failure("rate_limited", "rate_limited", "limited", input.correlationId, "not_accepted");
    if (this.mergeMode !== "unknown_unresolved") this.pulls = this.pulls.map((pull) => pull.number === number ? { ...pull, state: "closed", merged: true, mergeCommitSha: mergeRevision } : pull);
    return this.mergeMode === "success" ? success({ merged: true, sha: mergeRevision }, input.correlationId) : failure("unknown", "unknown", "uncertain", input.correlationId, "unknown");
  }
  async getApprovedReviewCount(_number: number, context: GitHubRequestContext) { this.calls.approvals += 1; return success(this.approvals, context.correlationId); }
}

interface Fixture { readonly directory: string; readonly filename: string; readonly store: RuntimeSqliteStore; readonly github: FakePullRequests; readonly ci: FakeCi; readonly revisions: readonly string[]; }

async function fixture(memberCount = 2): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-release-merge-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  const revisions: string[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    const ordinal = index + 1;
    const revision = String.fromCharCode(97 + index).repeat(40);
    const taskId = `release-merge-task-${ordinal}` as TaskId;
    const attemptId = `release-merge-attempt-${ordinal}` as AttemptId;
    const branch = `pirx/release-merge-${ordinal}`;
    const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 600 + ordinal, nodeId: `issue-${ordinal}`, url: `https://github.com/PiotrGry/ai-assistant/issues/${600 + ordinal}` } as const;
    const task = createTask({ id: taskId, githubReference: issue, goal: "Release member", scope: "release merge", acceptanceCriteria: ["exact merge"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
    if (!task.ok || store.tasks.create(task.value).outcome !== "success") throw new Error("Task fixture failed.");
    const started = store.startAttempt(taskId, { id: attemptId, worker: "claude", provider: "claude-code", branch }, t0);
    if (started.outcome !== "success") throw new Error(started.message);
    const terminal = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: revision }, t1);
    if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("Attempt fixture failed.");
    const featurePullRequest = { nodeId: `feature-pr-${ordinal}`, number: 700 + ordinal, url: `https://github.com/PiotrGry/ai-assistant/pull/${700 + ordinal}` } as const;
    const provenance = store.pullRequests.save({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, workerId: "claude", headBranch: branch, baseBranch: "develop", observedHeadSha: revision, pullRequest: featurePullRequest, createdAt: t1, updatedAt: t1 });
    if (provenance.outcome !== "success") throw new Error(provenance.message);
    const initial = store.ciCorrelations.start({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, featurePullRequest, workerId: "claude", headBranch: branch, baseBranch: "develop", pushedCommit: revision, provider: "github-actions", requiredWorkflowName: "Develop CI", createdAt: t1, updatedAt: t1 });
    if (initial.outcome !== "success") throw new Error(initial.message);
    const observed = store.ciCorrelations.recordObservation(taskId, attemptId, { state: "success", run: { schemaVersion: 1, provider: "github-actions", providerRunId: `feature-run-${ordinal}`, name: "Develop CI", status: "completed", conclusion: "success", testedRevision: revision, headBranch: branch, pullRequestNumbers: [featurePullRequest.number], url: `https://github.com/PiotrGry/ai-assistant/actions/runs/${ordinal}` }, observedAt: t1 });
    if (observed.outcome !== "success") throw new Error(observed.message);
    revisions.push(revision);
  }
  assert.equal(store.releases.create({ id: releaseId("release-merge"), repository, sourceBranch: "develop", baseBranch: "main", createdAt: t0 }).outcome, "success");
  for (let index = 0; index < revisions.length; index += 1) assert.equal(store.releases.addTask({ releaseId: releaseId("release-merge"), taskId: `release-merge-task-${index + 1}` as TaskId, attemptId: `release-merge-attempt-${index + 1}` as AttemptId, selectedRevision: revisions[index]!, featurePullRequest: { nodeId: `feature-pr-${index + 1}`, number: 701 + index, url: `https://github.com/PiotrGry/ai-assistant/pull/${701 + index}` }, createdAt: t1 }).outcome, "success");
  assert.equal(store.releases.transition("release-merge", { to: "validating", expectedVersion: 1, now: t1 }).outcome, "success");
  const github = new FakePullRequests(); github.commits = [...revisions];
  return { directory, filename, store, github, ci: new FakeCi(), revisions };
}

function request(overrides: Partial<{ expectedReleaseHeadSha: string; policy: ReleaseMergePolicy; correlationId: string; now: UtcTimestamp }> = {}) {
  return { releaseId: releaseId("release-merge"), expectedReleaseHeadSha: overrides.expectedReleaseHeadSha ?? releaseHead, policy: overrides.policy ?? policy, correlationId: overrides.correlationId ?? "release-merge-correlation", now: overrides.now ?? t2 };
}
async function close(value: Fixture): Promise<void> { try { value.store.close(); } finally { await rm(value.directory, { recursive: true, force: true }); } }

test("creates one multi-Task release PR, enforces exact checks, merges, and replays after restart", async () => {
  const value = await fixture();
  try {
    const merged = await new ReleaseMergeCoordinator(value.store, value.github, value.ci).merge(request());
    assert.equal(merged.outcome, "merged"); assert.equal(merged.mergeRevision, mergeRevision); assert.deepEqual(merged.checked, policy.requiredChecks);
    assert.equal(value.github.calls.create, 1); assert.equal(value.github.calls.merge, 1);
    const release = value.store.releases.get("release-merge"); assert.equal(release.outcome, "success"); if (release.outcome === "success") { assert.equal(release.value.state, "deploying"); assert.equal(release.value.mergeRevision, mergeRevision); }
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: value.filename });
    try { const replay = await new ReleaseMergeCoordinator(reopened, value.github, new FakeCi()).merge(request()); assert.equal(replay.outcome, "replayed"); assert.equal(value.github.calls.merge, 1); }
    finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* restart closed it */ } await rm(value.directory, { recursive: true, force: true }); }
});

test("reuses one exact PR and concurrent calls never create or merge a duplicate", async () => {
  const value = await fixture(1);
  value.github.pulls = [{ number: 501, url: "https://github.com/PiotrGry/ai-assistant/pull/501", state: "open", headBranch: "develop", headSha: releaseHead, baseBranch: "main", merged: false, mergeable: true }];
  try {
    const coordinator = new ReleaseMergeCoordinator(value.store, value.github, value.ci);
    const outcomes = await Promise.all([coordinator.merge(request({ correlationId: "concurrent-a" })), coordinator.merge(request({ correlationId: "concurrent-b" }))]);
    assert.equal(value.github.calls.create, 0); assert.equal(value.github.calls.merge, 1); assert.equal(outcomes.some((item) => item.outcome === "merged"), true); assert.equal(outcomes.every((item) => item.outcome !== "invalid_request"), true);
  } finally { await close(value); }
});

test("blocks stale membership, changed heads, failed checks, missing approvals, and policy denial", async () => {
  const stale = await fixture();
  try { stale.github.headSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; assert.equal((await new ReleaseMergeCoordinator(stale.store, stale.github, stale.ci).merge(request())).outcome, "superseded"); assert.equal(stale.github.calls.merge, 0); }
  finally { await close(stale); }
  const missing = await fixture();
  try { missing.github.commits = [missing.revisions[0]!]; assert.equal((await new ReleaseMergeCoordinator(missing.store, missing.github, missing.ci).merge(request())).outcome, "conflict"); assert.equal(missing.github.calls.merge, 0); }
  finally { await close(missing); }
  for (const observed of [{ outcome: "failed", message: "failed", polls: 1 }, { outcome: "pending", message: "pending", polls: 1 }] as CiRunResult[]) {
    const value = await fixture();
    try { value.ci.result = observed; assert.notEqual((await new ReleaseMergeCoordinator(value.store, value.github, value.ci).merge(request())).outcome, "merged"); assert.equal(value.github.calls.merge, 0); }
    finally { await close(value); }
  }
  const approvals = await fixture();
  try { approvals.github.approvals = 0; assert.equal((await new ReleaseMergeCoordinator(approvals.store, approvals.github, approvals.ci).merge(request())).outcome, "human_action_required"); assert.equal(approvals.github.calls.merge, 0); }
  finally { await close(approvals); }
  const mergeability = await fixture();
  mergeability.github.pulls = [{ number: 502, url: "https://github.com/PiotrGry/ai-assistant/pull/502", state: "open", headBranch: "develop", headSha: releaseHead, baseBranch: "main", merged: false, mergeable: false }];
  try { assert.equal((await new ReleaseMergeCoordinator(mergeability.store, mergeability.github, mergeability.ci).merge(request())).outcome, "policy_blocked"); assert.equal(mergeability.github.calls.merge, 0); }
  finally { await close(mergeability); }
  const ambiguous = await fixture();
  ambiguous.github.pulls = [
    { number: 503, url: "https://github.com/PiotrGry/ai-assistant/pull/503", state: "open", headBranch: "develop", headSha: releaseHead, baseBranch: "main", merged: false, mergeable: true },
    { number: 504, url: "https://github.com/PiotrGry/ai-assistant/pull/504", state: "open", headBranch: "develop", headSha: releaseHead, baseBranch: "main", merged: false, mergeable: true },
  ];
  try { assert.equal((await new ReleaseMergeCoordinator(ambiguous.store, ambiguous.github, ambiguous.ci).merge(request())).outcome, "ambiguous"); assert.equal(ambiguous.github.calls.create, 0); assert.equal(ambiguous.github.calls.merge, 0); }
  finally { await close(ambiguous); }
});

test("reconciles uncertain creation and merge without retrying an unresolved mutation", async () => {
  const createApplied = await fixture(); createApplied.github.createMode = "unknown_applied";
  try { assert.equal((await new ReleaseMergeCoordinator(createApplied.store, createApplied.github, createApplied.ci).merge(request())).outcome, "merged"); assert.equal(createApplied.github.calls.create, 1); }
  finally { await close(createApplied); }
  const createUnknown = await fixture(); createUnknown.github.createMode = "unknown_unresolved";
  try {
    const first = await new ReleaseMergeCoordinator(createUnknown.store, createUnknown.github, createUnknown.ci).merge(request()); assert.equal(first.outcome, "reconciliation_required");
    const replay = await new ReleaseMergeCoordinator(createUnknown.store, createUnknown.github, createUnknown.ci).merge(request()); assert.equal(replay.outcome, "reconciliation_required"); assert.equal(createUnknown.github.calls.create, 1);
  } finally { await close(createUnknown); }
  const mergeApplied = await fixture(); mergeApplied.github.mergeMode = "unknown_applied";
  try { assert.equal((await new ReleaseMergeCoordinator(mergeApplied.store, mergeApplied.github, mergeApplied.ci).merge(request())).outcome, "merged"); assert.equal(mergeApplied.github.calls.merge, 1); }
  finally { await close(mergeApplied); }
  const mergeUnknown = await fixture(); mergeUnknown.github.mergeMode = "unknown_unresolved";
  try {
    const first = await new ReleaseMergeCoordinator(mergeUnknown.store, mergeUnknown.github, mergeUnknown.ci).merge(request()); assert.equal(first.outcome, "reconciliation_required");
    const replay = await new ReleaseMergeCoordinator(mergeUnknown.store, mergeUnknown.github, mergeUnknown.ci).merge(request()); assert.equal(replay.outcome, "reconciliation_required"); assert.equal(mergeUnknown.github.calls.merge, 1);
  } finally { await close(mergeUnknown); }
});
