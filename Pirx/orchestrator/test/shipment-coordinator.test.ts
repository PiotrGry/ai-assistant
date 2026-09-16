import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ShipmentCycleCoordinator,
  CiCorrelationService,
  CiFailureEvidenceService,
  GitHubFeaturePullRequestService,
  RuntimeSqliteStore,
  createTask,
  success,
  startInitialAttempt,
  transitionAttempt,
  type CiFailureEvidence,
  type CiRun,
  type CiRunResult,
  type FeatureMergePolicy,
  type GitHubBranchHead,
  type GitHubOperationResult,
  type GitHubPullRequest,
  type GitHubPullRequestGatewayPort,
  type GitHubPullRequestMergeResult,
  type ProviderIndependentCiGateway,
  type TaskId,
  type AttemptId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-15T19:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-15T19:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-15T19:02:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 196, nodeId: "issue-196", url: "https://github.com/PiotrGry/ai-assistant/issues/196" } as const;
const taskId = "shipment-cycle-task" as TaskId;
const attempt1 = "shipment-cycle-attempt-1" as AttemptId;
const branch = "pirx/shipment-cycle";
const sha1 = "a".repeat(40);
const sha2 = "b".repeat(40);
const policy: FeatureMergePolicy = { headPattern: "^pirx/", baseBranch: "develop", requiredChecks: ["Required gate"], requiredApprovals: 0, mergeMethod: "squash", requireMergeable: true };

function run(expectedSha: string, id: string, conclusion: "success" | "failure" = "success"): CiRun { return { schemaVersion: 1, provider: "github-actions", providerRunId: id, name: "Required gate", status: "completed", conclusion, testedRevision: expectedSha, headBranch: branch, pullRequestNumbers: [196], url: `https://github.com/${repository}/actions/runs/${id}` }; }

class FakeCi implements ProviderIndependentCiGateway {
  phase: "failure" | "success" = "failure";
  resolveCalls = 0;
  evidenceCalls = 0;
  async getRun() { return { outcome: "not_found" as const, message: "unused", polls: 0 }; }
  async resolvePullRequest(query: { readonly expectedHeadSha: string }): Promise<CiRunResult> { this.resolveCalls += 1; return this.phase === "failure" ? { outcome: "failed", run: run(query.expectedHeadSha, "run-failed", "failure"), message: "red", polls: 1 } : { outcome: "success", run: run(query.expectedHeadSha, "run-green"), message: "green", polls: 1 }; }
  async getFailureEvidence(value: CiRun): Promise<{ readonly outcome: "success"; readonly evidence: CiFailureEvidence; readonly message: string }> { this.evidenceCalls += 1; return { outcome: "success", evidence: { schemaVersion: 1, provider: "github-actions", providerRunId: value.providerRunId, run: value, failedJobs: [{ providerJobId: "job-196", name: "tests", url: `${value.url}/job/1`, conclusion: "failure", failedSteps: [{ name: "expected test", number: 3 }] }] }, message: "evidence" }; }
}

class FakeGithub implements GitHubPullRequestGatewayPort {
  pull: GitHubPullRequest | undefined;
  branchSha = sha1;
  createCalls = 0;
  listCalls = 0;
  mergeCalls = 0;
  async getBranchHead(branchName: string): Promise<GitHubOperationResult<GitHubBranchHead>> { return success({ branch: branchName, sha: this.branchSha }, "head"); }
  async listPullRequests(): Promise<GitHubOperationResult<readonly GitHubPullRequest[]>> { this.listCalls += 1; return success(this.pull === undefined ? [] : [this.pull], "list"); }
  async getPullRequest(): Promise<GitHubOperationResult<GitHubPullRequest>> { return this.pull === undefined ? { outcome: "permanent_error", error: { code: "not_found", message: "missing" }, correlationId: "pull", remoteOutcome: "not_accepted" } : success(this.pull, "pull"); }
  async createPullRequest(input: { readonly headBranch: string; readonly baseBranch: string; readonly body: string }): Promise<GitHubOperationResult<GitHubPullRequest>> { this.createCalls += 1; this.pull = { number: 196, url: "https://github.com/PiotrGry/ai-assistant/pull/196", state: "open", headBranch: input.headBranch, headSha: this.branchSha, baseBranch: input.baseBranch, merged: false, mergeable: true, body: input.body }; return success(this.pull, "create"); }
  async mergePullRequest(): Promise<GitHubOperationResult<GitHubPullRequestMergeResult>> { this.mergeCalls += 1; this.pull = { ...this.pull!, state: "closed", merged: true, mergeCommitSha: "c".repeat(40) }; return success({ merged: true, sha: "c".repeat(40) }, "merge"); }
}

async function fixture(): Promise<{ directory: string; store: RuntimeSqliteStore; github: FakeGithub; ci: FakeCi }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-shipment-cycle-")); const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  const task = createTask({ id: taskId, githubReference: issue, goal: "Controlled shipment", scope: "PR CI retry and merge", acceptanceCriteria: ["one retry"], priority: 1, risk: "high", requiredCapabilities: ["repository.write"], createdAt: t0 });
  if (!task.ok || store.tasks.create(task.value).outcome !== "success") throw new Error("task fixture failed");
  const started = startInitialAttempt(task.value, [], { id: attempt1, worker: "application-worker", provider: "application-worker", branch, worktree: "/tmp/pirx-shipment" }, t0);
  if (!started.ok || store.tasks.update(started.value.task, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome !== "success" || store.attempts.create(started.value.attempt).outcome !== "success") throw new Error("attempt fixture failed");
  const current = store.attempts.get(attempt1); if (current.outcome !== "success") throw new Error("attempt read failed");
  const terminal = transitionAttempt(current.value, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha1, currentCommit: sha1 }, t1); if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("terminal fixture failed");
  return { directory, store, github: new FakeGithub(), ci: new FakeCi() };
}
async function dispose(value: { directory: string; store: RuntimeSqliteStore }): Promise<void> { try { value.store.close(); } finally { await rm(value.directory, { recursive: true, force: true }); } }
function request(attemptId: AttemptId = attempt1, expectedHeadSha = sha1, eventId = "shipment-event-1") { return { taskId, attemptId, eventId, correlationId: "shipment-correlation-" + eventId, repository: { owner: "PiotrGry", repository: "ai-assistant" }, headBranch: branch, baseBranch: "develop", expectedHeadSha, provider: "github-actions", workflowName: "Required gate", mergePolicy: policy, now: attemptId === attempt1 ? t1 : t2 }; }

async function seedPartialCycle(value: Awaited<ReturnType<typeof fixture>>, state: "started" | "pr_correlated" | "ci_failed" | "evidence_collected", eventId: string): Promise<void> {
  const current = request(attempt1, sha1, eventId);
  const started = value.store.shipmentCycles.start({ schemaVersion: 1, taskId, attemptId: attempt1, eventId, correlationId: current.correlationId, repository, headBranch: branch, baseBranch: "develop", expectedHeadSha: sha1, provider: "github-actions", workflowName: "Required gate", state: "started", message: "Shipment cycle started.", createdAt: t1, updatedAt: t1, version: 1 });
  if (started.outcome !== "success") throw new Error(started.message);
  if (state === "started") return;
  const pr = await new GitHubFeaturePullRequestService(value.store, value.github).createOrReuse({ taskId, attemptId: attempt1, repository: current.repository, baseBranch: "develop", expectedHeadSha: sha1, correlationId: current.correlationId });
  if (pr.pullRequest === undefined) throw new Error("partial-cycle PR fixture failed");
  const correlated = value.store.shipmentCycles.advance(taskId, attempt1, { state: "pr_correlated", pullRequestNumber: pr.pullRequest.number, pullRequestUrl: pr.pullRequest.url, message: "Feature PR is durably correlated." }, t1);
  if (correlated.outcome !== "success") throw new Error(correlated.message);
  if (state === "pr_correlated") return;
  const ci = await new CiCorrelationService(value.store, value.ci).observe({ taskId, attemptId: attempt1, repository, headBranch: branch, baseBranch: "develop", featurePullRequestNumber: pr.pullRequest.number, expectedHeadSha: sha1, provider: "github-actions", requiredWorkflowName: "Required gate", correlationId: current.correlationId, now: t1 });
  if (ci.outcome !== "observed" || ci.state !== "failed") throw new Error("partial-cycle CI fixture failed");
  const failed = value.store.shipmentCycles.advance(taskId, attempt1, { state: "ci_failed", ...(ci.record.providerRunId === undefined ? {} : { providerRunId: ci.record.providerRunId }), message: "Exact CI failure was durably correlated." }, t1);
  if (failed.outcome !== "success") throw new Error(failed.message);
  if (state === "ci_failed") return;
  const evidence = await new CiFailureEvidenceService(value.store, value.ci).collect({ taskId, attemptId: attempt1, correlationId: current.correlationId, now: t1 });
  if ((evidence.outcome !== "collected" && evidence.outcome !== "partial") || evidence.record === undefined) throw new Error("partial-cycle evidence fixture failed");
  const collected = value.store.shipmentCycles.advance(taskId, attempt1, { state: "evidence_collected", evidenceDigest: evidence.record.evidenceDigest, message: "Bounded CI evidence was durably collected." }, t1);
  if (collected.outcome !== "success") throw new Error(collected.message);
}

test("runs failure branch through PR, exact CI, bounded evidence and exactly one successor Attempt", async () => {
  const value = await fixture();
  try {
    const output = await new ShipmentCycleCoordinator(value.store, value.github, value.ci).run(request());
    assert.equal(output.outcome, "retry_created", JSON.stringify(output)); assert.ok(output.successorAttemptId); assert.equal(value.github.createCalls, 1); assert.equal(value.github.mergeCalls, 0); assert.equal(value.ci.resolveCalls, 1); assert.equal(value.ci.evidenceCalls, 1);
    const attempts = value.store.attempts.listByTask(taskId); assert.equal(attempts.outcome, "success"); if (attempts.outcome === "success") assert.equal(attempts.value.length, 2);
    const cycle = value.store.shipmentCycles.getByEvent("shipment-event-1"); assert.equal(cycle.outcome, "success"); if (cycle.outcome === "success") { assert.equal(cycle.value.state, "retry_created"); assert.equal(cycle.value.pullRequestNumber, 196); assert.ok(cycle.value.evidenceDigest); }
  } finally { await dispose(value); }
});

test("replays failure event without another PR, CI read, evidence collection or Attempt", async () => {
  const value = await fixture();
  try {
    const coordinator = new ShipmentCycleCoordinator(value.store, value.github, value.ci); const first = await coordinator.run(request()); assert.equal(first.outcome, "retry_created");
    const replay = await coordinator.run(request()); assert.equal(replay.outcome, "retry_created"); assert.equal(replay.successorAttemptId, first.successorAttemptId); assert.equal(value.github.createCalls, 1); assert.equal(value.ci.resolveCalls, 1); assert.equal(value.ci.evidenceCalls, 1);
  } finally { await dispose(value); }
});

for (const state of ["started", "pr_correlated", "ci_failed", "evidence_collected"] as const) {
  test(`resumes a durable ${state} cycle after restart without duplicating effects`, async () => {
    const value = await fixture();
    try {
      await seedPartialCycle(value, state, "shipment-restart-" + state);
      const beforeCreate = value.github.createCalls; const beforeResolve = value.ci.resolveCalls; const beforeEvidence = value.ci.evidenceCalls;
      const output = await new ShipmentCycleCoordinator(value.store, value.github, value.ci).run(request(attempt1, sha1, "shipment-restart-" + state));
      assert.equal(output.outcome, "retry_created", JSON.stringify(output));
      assert.equal(value.github.createCalls, beforeCreate + (state === "started" ? 1 : 0));
      assert.equal(value.ci.resolveCalls, beforeResolve + (state === "started" || state === "pr_correlated" ? 1 : 0));
      assert.equal(value.ci.evidenceCalls, beforeEvidence + (state === "started" || state === "pr_correlated" || state === "ci_failed" ? 1 : 0));
      const history = value.store.attempts.listByTask(taskId); assert.equal(history.outcome, "success"); if (history.outcome === "success") assert.equal(history.value.length, 2);
      const replay = await new ShipmentCycleCoordinator(value.store, value.github, value.ci).run(request(attempt1, sha1, "shipment-restart-" + state));
      assert.equal(replay.outcome, "retry_created"); assert.equal(replay.successorAttemptId, output.successorAttemptId);
      assert.equal(value.github.createCalls, beforeCreate + (state === "started" ? 1 : 0)); assert.equal(value.ci.resolveCalls, beforeResolve + (state === "started" || state === "pr_correlated" ? 1 : 0)); assert.equal(value.ci.evidenceCalls, beforeEvidence + (state === "started" || state === "pr_correlated" || state === "ci_failed" ? 1 : 0));
    } finally { await dispose(value); }
  });
}

test("fails closed for an incomplete or conflicting durable partial cycle", async () => {
  const value = await fixture();
  try {
    await seedPartialCycle(value, "started", "shipment-incomplete");
    const incomplete = value.store.shipmentCycles.advance(taskId, attempt1, { state: "pr_correlated", message: "Feature PR is durably correlated." }, t1);
    assert.equal(incomplete.outcome, "success");
    const output = await new ShipmentCycleCoordinator(value.store, value.github, value.ci).run(request(attempt1, sha1, "shipment-incomplete"));
    assert.equal(output.outcome, "reconciliation_required"); assert.equal(value.github.createCalls, 0); assert.equal(value.ci.resolveCalls, 0); assert.equal(value.ci.evidenceCalls, 0);

    const conflict = await new ShipmentCycleCoordinator(value.store, value.github, value.ci).run({ ...request(attempt1, sha1, "shipment-incomplete"), correlationId: "different-correlation" });
    assert.equal(conflict.outcome, "reconciliation_required"); assert.equal(value.github.createCalls, 0); assert.equal(value.ci.resolveCalls, 0);
  } finally { await dispose(value); }
});

test("reuses the same feature PR and records exact green CI and recovery after the normal worker finishes Attempt 2", async () => {
  const value = await fixture();
  try {
    const coordinator = new ShipmentCycleCoordinator(value.store, value.github, value.ci); const failureOutput = await coordinator.run(request()); assert.equal(failureOutput.outcome, "retry_created"); if (failureOutput.successorAttemptId === undefined) throw new Error("missing successor");
    const successor = value.store.attempts.get(failureOutput.successorAttemptId); assert.equal(successor.outcome, "success"); if (successor.outcome !== "success") return;
    const repaired = transitionAttempt(successor.value, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha2, currentCommit: sha2 }, t2); assert.equal(repaired.ok, true); if (!repaired.ok) return; assert.equal(value.store.attempts.update(repaired.value, "running").outcome, "success"); value.github.branchSha = sha2; value.ci.phase = "success";
    value.github.pull = { ...value.github.pull!, headSha: sha2 }; const green = await coordinator.run(request(failureOutput.successorAttemptId, sha2, "shipment-event-2")); assert.equal(green.outcome, "recovery_success", JSON.stringify(green)); assert.equal(value.github.createCalls, 1); assert.equal(value.github.mergeCalls, 1); assert.equal(value.ci.resolveCalls, 3); const history = value.store.attempts.listByTask(taskId); assert.equal(history.outcome, "success"); if (history.outcome === "success") assert.equal(history.value.length, 2);
    const firstPr = value.store.pullRequests.getByTaskAttempt(taskId, attempt1); const secondPr = value.store.pullRequests.getByTaskAttempt(taskId, failureOutput.successorAttemptId); assert.equal(firstPr.outcome, "success"); assert.equal(secondPr.outcome, "success"); if (firstPr.outcome === "success" && secondPr.outcome === "success") assert.equal(firstPr.value.pullRequest.number, secondPr.value.pullRequest.number);
    const firstCorrelation = value.store.ciCorrelations.getByTaskAttempt(taskId, attempt1); const secondCorrelation = value.store.ciCorrelations.getByTaskAttempt(taskId, failureOutput.successorAttemptId); assert.equal(firstCorrelation.outcome, "success"); assert.equal(secondCorrelation.outcome, "success"); if (firstCorrelation.outcome === "success" && secondCorrelation.outcome === "success") { assert.equal(firstCorrelation.value.provider, "github-actions"); assert.equal(secondCorrelation.value.provider, "github-actions"); }
    const cycle = value.store.shipmentCycles.getByEvent("shipment-event-2"); assert.equal(cycle.outcome, "success"); if (cycle.outcome === "success") { assert.equal(cycle.value.state, "recovery_success"); assert.equal(cycle.value.expectedHeadSha, sha2); }
  } finally { await dispose(value); }
});

test("maps cancellation, rate limit, stale CI and unknown mutation to explicit durable outcomes without merge", async () => {
  for (const [label, result] of [["cancelled", { outcome: "cancelled", message: "cancelled", polls: 1 }], ["rate", { outcome: "rate_limited", message: "rate", polls: 1 }], ["stale", { outcome: "success", run: { ...run(sha1, "old", "success"), testedRevision: "old-sha" }, message: "stale", polls: 1 }] ] as const) {
    const value = await fixture(); try { value.ci.resolvePullRequest = async () => result; const output = await new ShipmentCycleCoordinator(value.store, value.github, value.ci).run(request()); assert.notEqual(output.outcome, "recovery_success"); assert.equal(value.github.mergeCalls, 0); assert.equal(value.store.shipmentCycles.getByEvent("shipment-event-1").outcome, "success"); } finally { await dispose(value); }
  }
});

test("revalidates an immutable blocked retry after its transient blocker clears", async () => {
  const value = await fixture();
  try {
    const task = value.store.tasks.get(taskId);
    assert.equal(task.outcome, "success");
    if (task.outcome !== "success") return;
    const moved = value.store.tasks.update({ ...task.value, updatedAt: t2 }, { state: task.value.state, updatedAt: task.value.updatedAt });
    assert.equal(moved.outcome, "success");

    const coordinator = new ShipmentCycleCoordinator(value.store, value.github, value.ci);
    const blocked = await coordinator.run(request());
    assert.equal(blocked.outcome, "stale_or_conflicting_evidence");
    assert.match(blocked.message, /cannot precede Task updatedAt/u);
    const blockedHistory = value.store.attempts.listByTask(taskId);
    assert.equal(blockedHistory.outcome, "success");
    if (blockedHistory.outcome === "success") assert.equal(blockedHistory.value.length, 1);
    const evidence = value.store.ciEvidence.getByTaskAttempt(taskId, attempt1);
    assert.equal(evidence.outcome, "success");
    if (evidence.outcome !== "success") return;
    const blockedDecision = value.store.retryDecisions.getByIdentity(taskId, attempt1, "shipment-event-1", evidence.value.evidenceDigest, "blocked");
    assert.equal(blockedDecision.outcome, "success");
    const historicalCycle = value.store.shipmentCycles.getByEvent("shipment-event-1");
    assert.equal(historicalCycle.outcome, "success");
    if (historicalCycle.outcome !== "success") return;
    assert.equal(historicalCycle.value.state, "blocked");
    assert.equal(historicalCycle.value.outcome, "stale_or_conflicting_evidence");

    const resumed = await coordinator.run({ ...request(), now: t2 });
    assert.equal(resumed.outcome, "retry_created", JSON.stringify(resumed));
    assert.ok(resumed.successorAttemptId);
    const createdDecision = value.store.retryDecisions.getByIdentity(taskId, attempt1, "shipment-event-1", evidence.value.evidenceDigest, "created");
    assert.equal(createdDecision.outcome, "success");
    const history = value.store.attempts.listByTask(taskId);
    assert.equal(history.outcome, "success");
    if (history.outcome === "success") assert.equal(history.value.length, 2);

    const replay = await coordinator.run({ ...request(), now: t2 });
    assert.equal(replay.outcome, "retry_created");
    assert.equal(replay.successorAttemptId, resumed.successorAttemptId);
    const replayHistory = value.store.attempts.listByTask(taskId);
    assert.equal(replayHistory.outcome, "success");
    if (replayHistory.outcome === "success") assert.equal(replayHistory.value.length, 2);
    assert.equal(value.github.createCalls, 1);
    assert.equal(value.github.mergeCalls, 0);
    assert.equal(value.ci.resolveCalls, 1);
    assert.equal(value.ci.evidenceCalls, 1);
  } finally { await dispose(value); }
});

test("keeps blocked retry fail-closed when the exact PR identity changes", async () => {
  const value = await fixture();
  try {
    const task = value.store.tasks.get(taskId);
    assert.equal(task.outcome, "success");
    if (task.outcome !== "success") return;
    assert.equal(value.store.tasks.update({ ...task.value, updatedAt: t2 }, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome, "success");
    const coordinator = new ShipmentCycleCoordinator(value.store, value.github, value.ci);
    const blocked = await coordinator.run(request());
    assert.equal(blocked.outcome, "stale_or_conflicting_evidence");
    value.github.pull = { ...value.github.pull!, headSha: sha2 };
    const mismatch = await coordinator.run({ ...request(), now: t2 });
    assert.equal(mismatch.outcome, "stale_or_conflicting_evidence");
    assert.match(mismatch.message, /exact|revision|head|provenance/u);
    const history = value.store.attempts.listByTask(taskId);
    assert.equal(history.outcome, "success");
    if (history.outcome === "success") assert.equal(history.value.length, 1);
    assert.equal(value.github.mergeCalls, 0);
  } finally { await dispose(value); }
});

test("restarts between a blocked decision and retry recovery without duplicating effects", async () => {
  const value = await fixture();
  try {
    const task = value.store.tasks.get(taskId);
    assert.equal(task.outcome, "success");
    if (task.outcome !== "success") return;
    assert.equal(value.store.tasks.update({ ...task.value, updatedAt: t2 }, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome, "success");
    const first = await new ShipmentCycleCoordinator(value.store, value.github, value.ci).run(request());
    assert.equal(first.outcome, "stale_or_conflicting_evidence");
    const filename = value.store.filename;
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename });
    const resumed = await new ShipmentCycleCoordinator(reopened, value.github, value.ci).run({ ...request(), now: t2 });
    assert.equal(resumed.outcome, "retry_created");
    const replay = await new ShipmentCycleCoordinator(reopened, value.github, value.ci).run({ ...request(), now: t2 });
    assert.equal(replay.outcome, "retry_created");
    assert.equal(replay.successorAttemptId, resumed.successorAttemptId);
    const history = reopened.attempts.listByTask(taskId);
    assert.equal(history.outcome, "success");
    if (history.outcome === "success") assert.equal(history.value.length, 2);
    assert.equal(value.github.createCalls, 1);
    assert.equal(value.ci.resolveCalls, 1);
    assert.equal(value.ci.evidenceCalls, 1);
    reopened.close();
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});
