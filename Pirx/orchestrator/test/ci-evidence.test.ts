import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CiFailureEvidenceService,
  RuntimeSqliteStore,
  createTask,
  startInitialAttempt,
  success,
  transitionAttempt,
  type AttemptId,
  type CiFailureEvidence,
  type CiEvidenceResult,
  type CiRun,
  type CiRunResult,
  type ProviderIndependentCiGateway,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-15T19:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-15T19:01:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 133, nodeId: "issue-133", url: "https://github.com/PiotrGry/ai-assistant/issues/133" } as const;
const taskId = "ci-evidence-task" as TaskId;
const attemptId = "ci-evidence-attempt" as AttemptId;
const branch = "pirx/ci-evidence";
const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const runUrl = "https://github.com/PiotrGry/ai-assistant/actions/runs/9100";

function run(overrides: Partial<CiRun> = {}): CiRun {
  return { schemaVersion: 1, provider: "github-actions", providerRunId: "9100", pipeline: { provider: "github-actions", providerPipelineId: "43", name: "Required gate", url: "https://github.com/PiotrGry/ai-assistant/actions/workflows/required.yml" }, name: "Required gate", status: "completed", conclusion: "failure", testedRevision: sha, headBranch: branch, pullRequestNumbers: [133], url: runUrl, ...overrides };
}
function evidence(overrides: Partial<CiFailureEvidence> = {}): CiFailureEvidence {
  return { schemaVersion: 1, provider: "github-actions", providerRunId: "9100", run: run(), failedJobs: [{ providerJobId: "9101", name: "unit tests", url: "https://github.com/PiotrGry/ai-assistant/actions/runs/9100/job/9101", conclusion: "failure", failedSteps: [{ name: "Run tests", number: 3 }, { name: "cleanup", number: 4 }] }], ...overrides };
}

class FakeGateway implements ProviderIndependentCiGateway {
  evidenceResult: CiRunResult = { outcome: "failed", run: run(), message: "unused", polls: 1 };
  evidenceCalls = 0;
  logCalls = 0;
  logResult: { readonly outcome: "success" | "unavailable"; readonly excerpt?: string; readonly message: string } = { outcome: "success", excerpt: "Run tests\nerror output\ntoken=fixture-secret\nconnectionString=postgres://user:secret@db", message: "log" };
  async getRun() { return { outcome: "unknown" as const, message: "unused", polls: 0 }; }
  async resolvePullRequest() { return { outcome: "unknown" as const, message: "unused", polls: 0 }; }
  async getFailureEvidence(_run: CiRun): Promise<CiEvidenceResult> { this.evidenceCalls += 1; return this.evidenceResult.outcome === "failed" ? { outcome: "success", evidence: evidence(), message: "evidence" } : { outcome: "rate_limited", message: "limited" }; }
  async getFailureLogExcerpt() { this.logCalls += 1; return this.logResult; }
}

async function fixture(): Promise<{ directory: string; store: RuntimeSqliteStore }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-ci-evidence-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  const created = createTask({ id: taskId, githubReference: issue, goal: "Collect evidence", scope: "CI evidence", acceptanceCriteria: ["bounded evidence"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
  if (!created.ok || store.tasks.create(created.value).outcome !== "success") throw new Error("task fixture failed");
  const started = startInitialAttempt(created.value, [], { id: attemptId, worker: "worker", provider: "github-actions", branch }, t0);
  if (!started.ok || store.attempts.create(started.value.attempt).outcome !== "success" || store.tasks.update(started.value.task, { state: created.value.state, updatedAt: created.value.updatedAt }).outcome !== "success") throw new Error("attempt fixture failed");
  const current = store.attempts.get(attemptId);
  if (current.outcome !== "success") throw new Error("attempt read failed");
  const terminal = transitionAttempt(current.value, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha }, t1);
  if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("terminal fixture failed");
  const provenance = store.pullRequests.save({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, workerId: "worker", headBranch: branch, baseBranch: "develop", observedHeadSha: sha, pullRequest: { nodeId: "pr-133", number: 133, url: "https://github.com/PiotrGry/ai-assistant/pull/133" }, createdAt: t1, updatedAt: t1 });
  if (provenance.outcome !== "success") throw new Error("provenance fixture failed");
  const correlation = store.ciCorrelations.start({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, featurePullRequest: { nodeId: "pr-133", number: 133, url: "https://github.com/PiotrGry/ai-assistant/pull/133" }, workerId: "worker", headBranch: branch, baseBranch: "develop", pushedCommit: sha, provider: "github-actions", requiredWorkflowName: "Required gate", createdAt: t1, updatedAt: t1 });
  if (correlation.outcome !== "success") throw new Error("correlation fixture failed");
  const failed = store.ciCorrelations.recordObservation(taskId, attemptId, { state: "failed", run: run(), observedAt: t1 });
  if (failed.outcome !== "success") throw new Error("failed correlation fixture failed");
  return { directory, store };
}

function request(overrides: Partial<{ maxJobs: number; maxStepsPerJob: number; maxLogLines: number; maxLogBytes: number; maxEvidenceBytes: number }> = {}) {
  return { taskId, attemptId, correlationId: "evidence-correlation", now: t1, ...overrides } as const;
}

test("collects bounded sanitized evidence for the exact durable correlation and persists a digest", async () => {
  const value = await fixture();
  try {
    const gateway = new FakeGateway();
    const service = new CiFailureEvidenceService(value.store, gateway);
    const result = await service.collect(request({ maxJobs: 1, maxStepsPerJob: 1, maxLogLines: 4, maxLogBytes: 200 }));
    assert.equal(result.outcome, "collected");
    assert.equal(result.record.failedJobs.length, 1);
    assert.deepEqual(result.record.failedJobs[0]?.failedSteps, [{ name: "Run tests", number: 3 }]);
    assert.equal(result.record.logExcerpt?.split("\n").length, 4);
    assert.ok(result.record.redactionCount >= 2);
    assert.equal(result.record.evidenceDigest.length, 64);
    assert.ok(result.record.evidenceBytes <= 24_000);
    const serialized = JSON.stringify(result.record);
    assert.equal(serialized.includes("fixture-secret"), false);
    assert.equal(serialized.includes("postgres://user:secret@db"), false);
    assert.equal(value.store.ciEvidence.getByTaskAttempt(taskId, attemptId).outcome, "success");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("replays the same evidence and restart without a second provider read", async () => {
  const value = await fixture();
  try {
    const gateway = new FakeGateway(); const service = new CiFailureEvidenceService(value.store, gateway);
    const first = await service.collect(request()); assert.equal(first.outcome, "collected");
    const replay = await service.collect(request()); assert.equal(replay.outcome, "replayed");
    assert.equal(gateway.evidenceCalls, 1); assert.equal(gateway.logCalls, 1); assert.equal(replay.record.evidenceDigest, first.record.evidenceDigest);
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: join(value.directory, "runtime.sqlite") });
    try {
      const afterRestart = await new CiFailureEvidenceService(reopened, new FakeGateway()).collect(request());
      assert.equal(afterRestart.outcome, "replayed");
    } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* closed for restart branch */ } await rm(value.directory, { recursive: true, force: true }); }
});

test("returns partial evidence when optional logs are unavailable and maps provider failures", async () => {
  const value = await fixture();
  try {
    const gateway = new FakeGateway(); gateway.logResult = { outcome: "unavailable", message: "log unavailable" };
    const partial = await new CiFailureEvidenceService(value.store, gateway).collect(request());
    assert.equal(partial.outcome, "partial"); if (partial.outcome !== "partial") return; assert.equal(partial.record.logExcerpt, undefined);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
  for (const expected of ["rate_limited", "unavailable", "unknown"] as const) {
    const value = await fixture();
    try {
      const gateway = new FakeGateway(); gateway.evidenceResult = { outcome: "failed", run: run(), message: expected, polls: 1 };
      gateway.getFailureEvidence = async () => ({ outcome: expected, message: expected });
      assert.equal((await new CiFailureEvidenceService(value.store, gateway).collect(request())).outcome, expected);
    } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
  }
});

test("rejects stale or unbounded evidence and never persists a raw log", async () => {
  const stale = await fixture();
  try {
    const gateway = new FakeGateway(); gateway.getFailureEvidence = async () => ({ outcome: "success", evidence: evidence({ run: run({ testedRevision: "old-revision" }) }), message: "wrong" });
    assert.equal((await new CiFailureEvidenceService(stale.store, gateway).collect(request())).outcome, "stale");
  } finally { stale.store.close(); await rm(stale.directory, { recursive: true, force: true }); }
  const bounded = await fixture();
  try {
    const gateway = new FakeGateway(); gateway.logResult = { outcome: "success", excerpt: "safe", message: "log" };
    const result = await new CiFailureEvidenceService(bounded.store, gateway).collect(request({ maxEvidenceBytes: 1 }));
    assert.equal(result.outcome, "redaction_failed");
    assert.equal(bounded.store.ciEvidence.getByTaskAttempt(taskId, attemptId).outcome, "not_found");
    assert.equal((await readFile(join(bounded.directory, "runtime.sqlite"))).includes("safe"), false);
  } finally { bounded.store.close(); await rm(bounded.directory, { recursive: true, force: true }); }
});
