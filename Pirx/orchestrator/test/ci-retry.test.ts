import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CiRetryCoordinator,
  RuntimeSqliteStore,
  createTask,
  startInitialAttempt,
  transitionAttempt,
  type CiFailureEvidenceRecord,
  type CiRetryRequest,
  type CiRun,
  type TaskId,
  type AttemptId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-15T20:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-15T20:01:00.000Z" as UtcTimestamp;
const taskId = "retry-ci-task" as TaskId;
const attemptId = "retry-ci-attempt-1" as AttemptId;
const repository = "PiotrGry/ai-assistant";
const branch = "pirx/retry-ci";
const sha = "c".repeat(40);
const runId = "9400";
const eventId = "failure-event-9400";
const evidenceDigest = "d".repeat(64);
const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 134, nodeId: "issue-134", url: "https://github.com/PiotrGry/ai-assistant/issues/134" } as const;
const pullRequest = { nodeId: "pr-134", number: 134, url: "https://github.com/PiotrGry/ai-assistant/pull/134" } as const;

function ciRun(overrides: Partial<CiRun> = {}): CiRun {
  return {
    schemaVersion: 1,
    provider: "github-actions",
    providerRunId: runId,
    name: "Required tests",
    status: "completed",
    conclusion: "failure",
    testedRevision: sha,
    headBranch: branch,
    pullRequestNumbers: [134],
    url: `https://github.com/${repository}/actions/runs/${runId}`,
    ...overrides,
  };
}

function evidence(overrides: Partial<CiFailureEvidenceRecord> = {}): CiFailureEvidenceRecord {
  return {
    schemaVersion: 1,
    taskId,
    attemptId,
    repository,
    issueNumber: issue.issueNumber,
    featurePullRequestNumber: pullRequest.number,
    featurePullRequestUrl: pullRequest.url,
    headBranch: branch,
    pushedCommit: sha,
    provider: "github-actions",
    providerRunId: runId,
    providerRunUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    workflowName: "Required tests",
    conclusion: "failure",
    testedRevision: sha,
    failedJobs: [{ providerJobId: "job-1", name: "unit", url: `https://github.com/${repository}/actions/runs/${runId}/job/1`, conclusion: "failure", failedSteps: [{ name: "test", number: 2 }] }],
    logExcerpt: "assertion failed",
    redactionCount: 0,
    evidenceBytes: 100,
    evidenceDigest,
    createdAt: t1,
    updatedAt: t1,
    version: 1,
    ...overrides,
  };
}

async function fixture(): Promise<{ directory: string; store: RuntimeSqliteStore; request: CiRetryRequest }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-ci-retry-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  const task = createTask({ id: taskId, githubReference: issue, goal: "Retry the assigned task", scope: "controlled CI failure", acceptanceCriteria: ["one retry"], priority: 1, risk: "low", requiredCapabilities: ["repository.write"], createdAt: t0 });
  if (!task.ok || store.tasks.create(task.value).outcome !== "success") throw new Error("task fixture failed");
  const started = startInitialAttempt(task.value, [], { id: attemptId, worker: "application-worker", provider: "application-worker", branch, worktree: "/tmp/pirx-retry", currentCommit: sha }, t0);
  if (!started.ok || store.tasks.update(started.value.task, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome !== "success" || store.attempts.create(started.value.attempt).outcome !== "success") throw new Error("attempt fixture failed");
  const current = store.attempts.get(attemptId);
  if (current.outcome !== "success") throw new Error("attempt read failed");
  const terminal = transitionAttempt(current.value, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha, currentCommit: sha }, t1);
  if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("terminal fixture failed");
  const provenance = store.pullRequests.save({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, workerId: "application-worker", headBranch: branch, baseBranch: "develop", observedHeadSha: sha, pullRequest, createdAt: t1, updatedAt: t1 });
  if (provenance.outcome !== "success") throw new Error("provenance fixture failed");
  const correlation = store.ciCorrelations.start({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, featurePullRequest: pullRequest, workerId: "application-worker", headBranch: branch, baseBranch: "develop", pushedCommit: sha, provider: "github-actions", requiredWorkflowName: "Required tests", createdAt: t1, updatedAt: t1 });
  if (correlation.outcome !== "success") throw new Error("correlation fixture failed");
  const failed = store.ciCorrelations.recordObservation(taskId, attemptId, { state: "failed", run: ciRun(), observedAt: t1 });
  if (failed.outcome !== "success") throw new Error("failed correlation fixture failed");
  if (store.ciEvidence.save(evidence()).outcome !== "success") throw new Error("evidence fixture failed");
  return { directory, store, request: { taskId, attemptId, failureEventId: eventId, evidenceDigest, now: t1 } };
}

async function dispose(value: { directory: string; store: RuntimeSqliteStore }): Promise<void> {
  try { value.store.close(); } finally { await rm(value.directory, { recursive: true, force: true }); }
}

test("creates exactly one successor Attempt and bounded factual Checkpoint", async () => {
  const value = await fixture();
  try {
    const created = new CiRetryCoordinator(value.store).create(value.request);
    assert.equal(created.outcome, "created", JSON.stringify(created));
    assert.ok(created.successorAttemptId); assert.ok(created.checkpointId);
    const attempts = value.store.attempts.listByTask(taskId); const checkpoints = value.store.checkpoints.listByTask(taskId);
    assert.equal(attempts.outcome, "success"); assert.equal(checkpoints.outcome, "success");
    assert.equal(attempts.value.length, 2); assert.equal(checkpoints.value.length, 1);
    const successor = attempts.value[1]; const checkpoint = checkpoints.value[0];
    assert.equal(successor?.predecessorAttemptId, attemptId); assert.equal(successor?.ordinal, 2); assert.equal(successor?.worker, "application-worker"); assert.equal(successor?.checkpointReference, checkpoint?.id);
    assert.equal(checkpoint?.previousAttemptId, attemptId); assert.equal(checkpoint?.currentCommit, sha); assert.match(checkpoint?.evidence[0]?.reference ?? "", /^ci-evidence:/u);
    assert.match(checkpoint?.resumeInstruction ?? "", /bounded failed-CI facts/u);
  } finally { await dispose(value); }
});

test("replays with the same identities after restart and concurrent delivery", async () => {
  const value = await fixture();
  try {
    const coordinator = new CiRetryCoordinator(value.store);
    const first = coordinator.create(value.request); assert.equal(first.outcome, "created", JSON.stringify(first));
    const replay = coordinator.create(value.request); assert.equal(replay.outcome, "already_retried");
    assert.equal(replay.successorAttemptId, first.successorAttemptId); assert.equal(replay.checkpointId, first.checkpointId);
    const concurrent = await Promise.all([coordinator.create(value.request), coordinator.create(value.request)]);
    assert.deepEqual(concurrent.map((item) => item.outcome), ["already_retried", "already_retried"]);
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: join(value.directory, "runtime.sqlite") });
    try {
      const afterRestart = new CiRetryCoordinator(reopened).create(value.request);
      assert.equal(afterRestart.outcome, "already_retried"); assert.equal(afterRestart.successorAttemptId, first.successorAttemptId); assert.equal(afterRestart.checkpointId, first.checkpointId);
      const attempts = reopened.attempts.listByTask(taskId); const checkpoints = reopened.checkpoints.listByTask(taskId);
      assert.equal(attempts.outcome, "success"); assert.equal(checkpoints.outcome, "success"); assert.equal(attempts.value.length, 2); assert.equal(checkpoints.value.length, 1);
    } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* closed for restart branch */ } await rm(value.directory, { recursive: true, force: true }); }
});

test("fails closed for missing, mismatched, stale, and non-failing evidence", async () => {
  const missing = await fixture();
  try { missing.store.database.prepare("DELETE FROM runtime_ci_evidence").run(); assert.equal(new CiRetryCoordinator(missing.store).create(missing.request).outcome, "missing_evidence"); const attempts = missing.store.attempts.listByTask(taskId); assert.equal(attempts.outcome, "success"); if (attempts.outcome === "success") assert.equal(attempts.value.length, 1); } finally { await dispose(missing); }
  const mismatch = await fixture();
  try { assert.equal(new CiRetryCoordinator(mismatch.store).create({ ...mismatch.request, evidenceDigest: "e".repeat(64) }).outcome, "mismatch"); } finally { await dispose(mismatch); }
  const stale = await fixture();
  try { stale.store.database.prepare("UPDATE runtime_ci_evidence SET head_branch = ?").run("old-branch"); assert.equal(new CiRetryCoordinator(stale.store).create(stale.request).outcome, "stale"); } finally { await dispose(stale); }
  const nonFailure = await fixture();
  try { nonFailure.store.database.prepare("UPDATE runtime_ci_evidence SET conclusion = ?").run("success"); assert.equal(new CiRetryCoordinator(nonFailure.store).create(nonFailure.request).outcome, "non_failing_run"); } finally { await dispose(nonFailure); }
});

test("returns explicit reconciliation or blocked outcomes for contradictory state", async () => {
  const value = await fixture();
  try {
    const first = new CiRetryCoordinator(value.store).create(value.request); assert.equal(first.outcome, "created", JSON.stringify(first));
    if (first.outcome !== "created" || first.checkpointId === undefined) throw new Error("retry fixture did not create a checkpoint");
    value.store.database.prepare("DELETE FROM runtime_checkpoints WHERE id = ?").run(first.checkpointId);
    assert.equal(new CiRetryCoordinator(value.store).create(value.request).outcome, "reconciliation_required");
  } finally { await dispose(value); }
  const active = await fixture();
  try {
    const current = active.store.attempts.get(attemptId); assert.equal(current.outcome, "success");
    active.store.database.prepare("UPDATE runtime_attempts SET state = 'running', result = NULL, ended_at = NULL, final_commit = NULL, blocking_reason = NULL WHERE id = ?").run(attemptId);
    assert.equal(new CiRetryCoordinator(active.store).create(active.request).outcome, "mismatch");
  } finally { await dispose(active); }
});

test("rolls back Checkpoint when successor Attempt cannot be persisted and never invokes a worker", async () => {
  const value = await fixture();
  try {
    const stableAttemptId = `ci-retry-${createHash("sha256").update(eventId).digest("hex").slice(0, 48)}` as AttemptId;
    const otherTaskId = "retry-other-task" as TaskId;
    const other = createTask({ id: otherTaskId, goal: "Other task", scope: "rollback fixture", acceptanceCriteria: ["durable"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
    assert.equal(other.ok, true); if (!other.ok) return;
    assert.equal(value.store.tasks.create(other.value).outcome, "success");
    const otherAttempt = startInitialAttempt(other.value, [], { id: stableAttemptId, worker: "unused", provider: "test" }, t0);
    assert.equal(otherAttempt.ok, true); if (!otherAttempt.ok) return;
    assert.equal(value.store.tasks.update(otherAttempt.value.task, { state: other.value.state, updatedAt: other.value.updatedAt }).outcome, "success");
    assert.equal(value.store.attempts.create(otherAttempt.value.attempt).outcome, "success");
    const failed = new CiRetryCoordinator(value.store).create(value.request);
    assert.equal(failed.outcome, "conflict");
    assert.equal(value.store.checkpoints.get(failed.checkpointId ?? "missing").outcome, "not_found");
    const attempts = value.store.attempts.listByTask(taskId); assert.equal(attempts.outcome, "success"); assert.equal(attempts.value.length, 1);
  } finally { await dispose(value); }
});
