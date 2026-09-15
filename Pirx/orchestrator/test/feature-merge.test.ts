import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CiCorrelationService,
  FeatureMergeCoordinator,
  RuntimeSqliteStore,
  createTask,
  failure,
  startInitialAttempt,
  success,
  transitionAttempt,
  type AttemptId,
  type CiRun,
  type CiRunResult,
  type FeatureMergePolicy,
  type GitHubBranchHead,
  type GitHubOperationResult,
  type GitHubPullRequest,
  type GitHubPullRequestGatewayPort,
  type GitHubPullRequestMergeResult,
  type GitHubRequestContext,
  type ProviderIndependentCiGateway,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-15T18:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-15T18:01:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const taskId = "feature-merge-task" as TaskId;
const attemptId = "feature-merge-attempt" as AttemptId;
const branch = "pirx/feature-merge";
const pushedSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const mergeSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 195, nodeId: "issue-195", url: "https://github.com/PiotrGry/ai-assistant/issues/195" } as const;
const pullRequestIdentity = { nodeId: "pr-195", number: 195, url: "https://github.com/PiotrGry/ai-assistant/pull/195" } as const;

const policy: FeatureMergePolicy = { headPattern: "^pirx/", baseBranch: "develop", requiredChecks: ["Required gate"], requiredApprovals: 1, mergeMethod: "squash", requireMergeable: true };

function run(overrides: Partial<CiRun> = {}): CiRun {
  return { schemaVersion: 1, provider: "github-actions", providerRunId: "run-195", pipeline: { provider: "github-actions", providerPipelineId: "pipeline-195", name: "Required gate", url: "https://github.com/PiotrGry/ai-assistant/actions/workflows/required.yml" }, name: "Required gate", status: "completed", conclusion: "success", testedRevision: pushedSha, headBranch: branch, pullRequestNumbers: [195], url: "https://github.com/PiotrGry/ai-assistant/actions/runs/run-195", ...overrides };
}

function ciResult(overrides: Partial<CiRunResult> = {}): CiRunResult { return { outcome: "success", run: run(), message: "green", polls: 1, ...overrides }; }

class FakeCi implements ProviderIndependentCiGateway {
  result: CiRunResult = ciResult();
  calls = 0;
  async getRun() { return this.result; }
  async resolvePullRequest() { this.calls += 1; return this.result; }
  async getFailureEvidence() { return { outcome: "unavailable" as const, message: "unused" }; }
}

class FakePullRequests implements GitHubPullRequestGatewayPort {
  pull: GitHubPullRequest = { number: 195, url: pullRequestIdentity.url, state: "open", headBranch: branch, headSha: pushedSha, baseBranch: "develop", merged: false, mergeable: true };
  branchSha = pushedSha;
  approvals = 1;
  mergeResult: GitHubOperationResult<GitHubPullRequestMergeResult> = success({ merged: true, sha: mergeSha }, "merge");
  mergeAppliesRemotely = false;
  mergeCalls = 0;
  readCalls = 0;
  branchCalls = 0;
  approvalCalls = 0;
  createCalls = 0;
  listCalls = 0;
  async getBranchHead(branchName: string): Promise<GitHubOperationResult<GitHubBranchHead>> { this.branchCalls += 1; return success({ branch: branchName, sha: this.branchSha }, "head"); }
  async listPullRequests() { this.listCalls += 1; return success([this.pull], "list"); }
  async getPullRequest() { this.readCalls += 1; return success(this.pull, "pull"); }
  async createPullRequest() { this.createCalls += 1; return success(this.pull, "create"); }
  async getApprovedReviewCount() { this.approvalCalls += 1; return success(this.approvals, "approval"); }
  async mergePullRequest(): Promise<GitHubOperationResult<GitHubPullRequestMergeResult>> { this.mergeCalls += 1; if ((this.mergeResult.outcome === "success" && this.mergeResult.value.merged) || (this.mergeResult.outcome !== "success" && this.mergeAppliesRemotely)) this.pull = { ...this.pull, merged: true, state: "closed", mergeCommitSha: mergeSha }; return this.mergeResult; }
}

async function fixture(): Promise<{ directory: string; store: RuntimeSqliteStore; github: FakePullRequests; ci: FakeCi }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-feature-merge-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  const created = createTask({ id: taskId, githubReference: issue, goal: "Merge feature", scope: "exact CI merge", acceptanceCriteria: ["exact green"], priority: 1, risk: "low", requiredCapabilities: ["repository.write"], createdAt: t0 });
  if (!created.ok || store.tasks.create(created.value).outcome !== "success") throw new Error("task fixture failed");
  const started = startInitialAttempt(created.value, [], { id: attemptId, worker: "worker", provider: "github-actions", branch }, t0);
  if (!started.ok || store.tasks.update(started.value.task, { state: created.value.state, updatedAt: created.value.updatedAt }).outcome !== "success" || store.attempts.create(started.value.attempt).outcome !== "success") throw new Error("attempt fixture failed");
  const current = store.attempts.get(attemptId);
  if (current.outcome !== "success") throw new Error("attempt read failed");
  const terminal = transitionAttempt(current.value, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: pushedSha }, t1);
  if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("terminal fixture failed");
  const provenance = store.pullRequests.save({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, workerId: "worker", headBranch: branch, baseBranch: "develop", observedHeadSha: pushedSha, pullRequest: pullRequestIdentity, createdAt: t1, updatedAt: t1 });
  if (provenance.outcome !== "success") throw new Error("provenance fixture failed: " + provenance.message);
  const ci = new FakeCi();
  const correlation = await new CiCorrelationService(store, ci).observe({ taskId, attemptId, repository, headBranch: branch, baseBranch: "develop", featurePullRequestNumber: 195, expectedHeadSha: pushedSha, provider: "github-actions", requiredWorkflowName: "Required gate", correlationId: "correlation-195", now: t1 });
  if (correlation.outcome !== "observed" || correlation.state !== "success") throw new Error("CI fixture failed");
  return { directory, store, github: new FakePullRequests(), ci };
}

async function close(value: { directory: string; store: RuntimeSqliteStore }): Promise<void> { try { value.store.close(); } finally { await rm(value.directory, { recursive: true, force: true }); } }
function request(overrides: Partial<{ policy: FeatureMergePolicy; correlationId: string }> = {}) { return { taskId, attemptId, policy: overrides.policy ?? policy, correlationId: overrides.correlationId ?? "merge-correlation", now: t1 }; }

test("merges one exact feature PR after exact green CI and persists the merge revision", async () => {
  const value = await fixture();
  try {
    const output = await new FeatureMergeCoordinator(value.store, value.github, value.ci).merge(request());
    assert.equal(output.outcome, "merged"); assert.equal(output.mergeSha, mergeSha); assert.deepEqual(output.checked, ["Required gate"]);
    assert.equal(value.github.mergeCalls, 1); assert.equal(value.github.createCalls, 0); assert.equal(value.github.listCalls, 0);
    const stored = value.store.featureMerges.getByTaskAttempt(taskId, attemptId);
    assert.equal(stored.outcome, "success"); if (stored.outcome === "success") { assert.equal(stored.value.state, "merged"); assert.equal(stored.value.mergeSha, mergeSha); assert.equal(stored.value.baseBranch, "develop"); }
  } finally { await close(value); }
});

test("replays durable merge after restart with the same PR identity and no second mutation", async () => {
  const value = await fixture();
  try {
    const first = await new FeatureMergeCoordinator(value.store, value.github, value.ci).merge(request()); assert.equal(first.outcome, "merged");
    const calls = value.github.mergeCalls; value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: join(value.directory, "runtime.sqlite") });
    try {
      const replay = await new FeatureMergeCoordinator(reopened, value.github, new FakeCi()).merge(request());
      assert.equal(replay.outcome, "replayed"); assert.equal(replay.pullRequest?.number, 195); assert.equal(replay.mergeSha, mergeSha); assert.equal(value.github.mergeCalls, calls);
    } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* restart branch closed it */ } await rm(value.directory, { recursive: true, force: true }); }
});

test("fails closed for missing, ambiguous, pending, cancelled, stale and failed CI without merge", async () => {
  const cases: Array<[string, CiRunResult]> = [
    ["missing", { outcome: "not_found", message: "missing", polls: 1 }],
    ["ambiguous", { outcome: "ambiguous", message: "ambiguous", polls: 1 }],
    ["pending", { outcome: "pending", message: "pending", polls: 1 }],
    ["cancelled", { outcome: "cancelled", message: "cancelled", polls: 1 }],
    ["failed", { outcome: "failed", run: run({ conclusion: "failure" }), message: "failed", polls: 1 }],
    ["stale", { outcome: "success", run: run({ testedRevision: "old-sha" }), message: "stale", polls: 1 }],
  ];
  for (const [name, result] of cases) {
    const value = await fixture();
    try { value.ci.result = result; const output = await new FeatureMergeCoordinator(value.store, value.github, value.ci).merge(request({ correlationId: "case-" + name })); assert.notEqual(output.outcome, "merged"); assert.equal(value.github.mergeCalls, 0); assert.equal(value.github.approvalCalls, 0); } finally { await close(value); }
  }
});

test("rejects changed branch, changed PR provenance, wrong base and wrong head policy before merge", async () => {
  for (const change of ["branch", "pr", "base", "pattern"] as const) {
    const value = await fixture();
    try {
      if (change === "branch") value.github.branchSha = "cccccccccccccccccccccccccccccccccccccccc";
      if (change === "pr") value.github.pull = { ...value.github.pull, headSha: "cccccccccccccccccccccccccccccccccccccccc" };
      const changedPolicy = change === "base" ? { ...policy, baseBranch: "main" } : change === "pattern" ? { ...policy, headPattern: "^other/" } : policy;
      const output = await new FeatureMergeCoordinator(value.store, value.github, value.ci).merge(request({ policy: changedPolicy }));
      assert.ok(["stale", "conflict"].includes(output.outcome)); assert.equal(value.github.mergeCalls, 0);
    } finally { await close(value); }
  }
});

test("requires approvals and mergeability, and maps conflict, authorization and rate-limit outcomes", async () => {
  for (const setup of [
    (github: FakePullRequests) => { github.approvals = 0; },
    (github: FakePullRequests) => { github.pull = { ...github.pull, mergeable: false }; },
    (github: FakePullRequests) => { github.mergeResult = failure("permanent_error", "conflict", "conflict", "merge", "not_accepted"); },
    (github: FakePullRequests) => { github.mergeResult = failure("permanent_error", "authentication", "denied", "merge", "not_accepted"); },
    (github: FakePullRequests) => { github.mergeResult = failure("rate_limited", "rate_limited", "limited", "merge", "not_accepted"); },
  ]) {
    const value = await fixture();
    try { setup(value.github); const output = await new FeatureMergeCoordinator(value.store, value.github, value.ci).merge(request()); assert.notEqual(output.outcome, "merged"); assert.equal(value.github.mergeCalls, output.outcome === "policy_blocked" ? 0 : 1); } finally { await close(value); }
  }
});

test("reconciles an uncertain merge, but never retries an unresolved mutation", async () => {
  const reconciled = await fixture();
  try {
    reconciled.github.mergeResult = failure("unknown", "unknown", "uncertain", "merge", "unknown"); reconciled.github.mergeAppliesRemotely = true;
    const replay = await new FeatureMergeCoordinator(reconciled.store, reconciled.github, reconciled.ci).merge(request());
    assert.equal(replay.outcome, "replayed"); assert.equal(reconciled.github.mergeCalls, 1);
  } finally { await close(reconciled); }
  const unresolved = await fixture();
  try {
    unresolved.github.mergeResult = failure("unknown", "unknown", "uncertain", "merge", "unknown");
    const output = await new FeatureMergeCoordinator(unresolved.store, unresolved.github, unresolved.ci).merge(request());
    assert.equal(output.outcome, "reconciliation_required"); assert.equal(unresolved.github.mergeCalls, 1);
    const second = await new FeatureMergeCoordinator(unresolved.store, unresolved.github, unresolved.ci).merge(request());
    assert.equal(second.outcome, "reconciliation_required"); assert.equal(unresolved.github.mergeCalls, 1);
  } finally { await close(unresolved); }
});

test("does not expose release, dispatch or deployment operations in the feature merge boundary", async () => {
  const value = await fixture();
  try {
    const output = await new FeatureMergeCoordinator(value.store, value.github, value.ci).merge(request());
    assert.equal(output.outcome, "merged"); assert.equal(value.github.createCalls, 0); assert.equal(value.github.listCalls, 0); assert.equal(value.github.mergeCalls, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(value.github, "deploy"), false); assert.equal(Object.prototype.hasOwnProperty.call(value.github, "dispatchWorkflow"), false);
  } finally { await close(value); }
});
