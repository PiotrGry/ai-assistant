import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CiCorrelationService,
  RuntimeSqliteStore,
  createTask,
  failure,
  startInitialAttempt,
  success,
  transitionAttempt,
  type AttemptId,
  type CiRun,
  type CiRunResult,
  type ProviderIndependentCiGateway,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-15T18:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-15T18:01:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 132, nodeId: "issue-132", url: "https://github.com/PiotrGry/ai-assistant/issues/132" } as const;
const taskId = "ci-correlation-task" as TaskId;
const attemptId = "ci-correlation-attempt" as AttemptId;
const branch = "pirx/ci-correlation";
const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pullRequest = { nodeId: "pr-132", number: 132, url: "https://github.com/PiotrGry/ai-assistant/pull/132" } as const;

function run(overrides: Partial<CiRun> = {}): CiRun {
  return { schemaVersion: 1, provider: "github-actions", providerRunId: "9001", pipeline: { provider: "github-actions", providerPipelineId: "42", name: "Required gate", url: "https://github.com/PiotrGry/ai-assistant/actions/workflows/required.yml" }, name: "Required gate", status: "completed", conclusion: "success", testedRevision: sha, headBranch: branch, pullRequestNumbers: [pullRequest.number], url: "https://github.com/PiotrGry/ai-assistant/actions/runs/9001", ...overrides };
}

class FakeCiGateway implements ProviderIndependentCiGateway {
  results: CiRunResult[] = [{ outcome: "pending", message: "pending", polls: 1 }, { outcome: "success", run: run(), message: "green", polls: 2 }];
  calls = 0;
  queries: Array<{ pullRequestNumber: number; expectedHeadSha: string; requiredWorkflowName?: string }> = [];
  async getRun(_providerRunId: string) { return { outcome: "unknown" as const, message: "unused", polls: 0 }; }
  async resolvePullRequest(query: { pullRequestNumber: number; expectedHeadSha: string; requiredWorkflowName?: string }) {
    this.calls += 1; this.queries.push(query);
    return this.results.shift() ?? { outcome: "success" as const, run: run(), message: "green", polls: 1 };
  }
  async getFailureEvidence() { return { outcome: "permanent" as const, message: "unused" }; }
}

async function fixture(workerProvider = "claude-code"): Promise<{ directory: string; store: RuntimeSqliteStore; task: TaskSnapshot }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-ci-correlation-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  const created = createTask({ id: taskId, githubReference: issue, goal: "Correlate CI", scope: "CI correlation", acceptanceCriteria: ["exact run"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
  if (!created.ok || store.tasks.create(created.value).outcome !== "success") throw new Error("task fixture failed");
  const started = startInitialAttempt(created.value, [], { id: attemptId, worker: "worker", provider: workerProvider, branch }, t0);
  if (!started.ok || store.attempts.create(started.value.attempt).outcome !== "success" || store.tasks.update(started.value.task, { state: created.value.state, updatedAt: created.value.updatedAt }).outcome !== "success") throw new Error("attempt fixture failed");
  const current = store.attempts.get(attemptId);
  if (current.outcome !== "success") throw new Error("attempt read failed");
  const terminal = transitionAttempt(current.value, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha }, t1);
  if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("terminal fixture failed");
  const provenance = store.pullRequests.save({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, workerId: "worker", headBranch: branch, baseBranch: "develop", observedHeadSha: sha, pullRequest, createdAt: t1, updatedAt: t1 });
  if (provenance.outcome !== "success") throw new Error("provenance fixture failed: " + provenance.message);
  return { directory, store, task: created.value };
}

function request(overrides: Partial<{ expectedHeadSha: string; featurePullRequestNumber: number; baseBranch: string }> = {}) {
  return { taskId, attemptId, repository, headBranch: branch, baseBranch: overrides.baseBranch ?? "develop", featurePullRequestNumber: overrides.featurePullRequestNumber ?? pullRequest.number, expectedHeadSha: overrides.expectedHeadSha ?? sha, provider: "github-actions", requiredWorkflowName: "Required gate", correlationId: "ci-correlation-test", now: t1 } as const;
}

test("creates pending correlation before observation, updates exact run, supports all lookup directions and replays", async () => {
  const value = await fixture();
  try {
    const gateway = new FakeCiGateway(); const service = new CiCorrelationService(value.store, gateway);
    const pending = await service.observe(request());
    assert.equal(pending.outcome, "observed"); assert.equal(pending.state, "pending"); assert.equal(pending.record.version, 2);
    assert.equal(gateway.calls, 1);
    const green = await service.observe(request());
    assert.equal(green.outcome, "observed"); assert.equal(green.state, "success");
    assert.equal(green.record.providerRunId, "9001"); assert.equal(green.record.testedRevision, sha); assert.equal(green.record.providerPipelineId, "42");
    assert.deepEqual(gateway.queries, [{ pullRequestNumber: 132, expectedHeadSha: sha, requiredWorkflowName: "Required gate" }, { pullRequestNumber: 132, expectedHeadSha: sha, requiredWorkflowName: "Required gate" }]);
    assert.equal(service.getByTaskAttempt(taskId, attemptId).outcome, "success");
    assert.equal(service.getByPullRequest(repository, pullRequest.number).outcome, "success");
    assert.equal(service.getByCommit(repository, sha).outcome, "success");
    assert.equal(service.getByProviderRun("github-actions", "9001").outcome, "success");
    const calls = gateway.calls;
    const replay = await service.observe(request());
    assert.equal(replay.outcome, "replayed"); assert.equal(replay.record.providerRunId, "9001"); assert.equal(gateway.calls, calls);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("allows independent worker providers to use the same CI provider", async () => {
  for (const workerProvider of ["claude-code", "application-worker"]) {
    const value = await fixture(workerProvider);
    try {
      const gateway = new FakeCiGateway(); gateway.results = [{ outcome: "success", run: run(), message: "green", polls: 1 }];
      const observed = await new CiCorrelationService(value.store, gateway).observe(request());
      assert.equal(observed.outcome, "observed"); assert.equal(observed.record.provider, "github-actions");
      const attempt = value.store.attempts.get(attemptId);
      assert.equal(attempt.outcome, "success");
      if (attempt.outcome === "success") assert.equal(attempt.value.provider, workerProvider);
    } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
  }
});

test("persists correlation and terminal observation across restart without re-reading terminal CI", async () => {
  const value = await fixture();
  const gateway = new FakeCiGateway();
  try {
    gateway.results = [{ outcome: "success", run: run(), message: "green", polls: 1 }];
    const first = await new CiCorrelationService(value.store, gateway).observe(request());
    assert.equal(first.outcome, "observed");
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: join(value.directory, "runtime.sqlite") });
    try {
      const secondGateway = new FakeCiGateway();
      const replay = await new CiCorrelationService(reopened, secondGateway).observe(request());
      assert.equal(replay.outcome, "replayed"); assert.equal(replay.record.state, "success"); assert.equal(secondGateway.calls, 0);
      assert.equal(reopened.ciCorrelations.getByTaskAttempt(taskId, attemptId).outcome, "success");
      const changedProvider = await new CiCorrelationService(reopened, secondGateway).observe({ ...request(), provider: "other-ci" });
      assert.equal(changedProvider.outcome, "conflict"); assert.equal(secondGateway.calls, 0);
      const retainedAttempt = reopened.attempts.get(attemptId); assert.equal(retainedAttempt.outcome, "success");
      if (retainedAttempt.outcome === "success") assert.equal(retainedAttempt.value.provider, "claude-code");
      const retainedCorrelation = reopened.ciCorrelations.getByTaskAttempt(taskId, attemptId); assert.equal(retainedCorrelation.outcome, "success");
      if (retainedCorrelation.outcome === "success") assert.equal(retainedCorrelation.value.provider, "github-actions");
    } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* closed for restart branch */ } await rm(value.directory, { recursive: true, force: true }); }
});

test("rejects provenance mismatches and never calls CI", async () => {
  const value = await fixture();
  try {
    const gateway = new FakeCiGateway(); const service = new CiCorrelationService(value.store, gateway);
    assert.equal((await service.observe(request({ expectedHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }))).outcome, "conflict");
    assert.equal((await service.observe(request({ featurePullRequestNumber: 999 }))).outcome, "conflict");
    assert.equal((await service.observe(request({ baseBranch: "main" }))).outcome, "conflict");
    assert.equal((await service.observe({ ...request(), taskId: "wrong-task" as TaskId })).outcome, "conflict");
    assert.equal((await service.observe({ ...request(), attemptId: "wrong-attempt" as AttemptId })).outcome, "conflict");
    assert.equal(gateway.calls, 0);
    assert.equal(value.store.ciCorrelations.getByTaskAttempt(taskId, attemptId).outcome, "not_found");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("rejects a provider result with the right SHA but wrong branch or workflow", async () => {
  for (const badRun of [run({ headBranch: "other-branch" }), run({ name: "other workflow" })]) {
    const value = await fixture();
    try {
      const gateway = new FakeCiGateway(); gateway.results = [{ outcome: "success", run: badRun, message: "wrong identity", polls: 1 }];
      const output = await new CiCorrelationService(value.store, gateway).observe(request());
      assert.equal(output.outcome, "observed");
      assert.equal(output.state, "stale");
    } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
  }
});

test("stores stale, ambiguous, rate-limited, unavailable and terminal failure observations fail-closed", async () => {
  for (const [name, result] of [
    ["stale", { outcome: "success", run: run({ testedRevision: "old-revision" }), message: "wrong revision", polls: 1 }],
    ["ambiguous", { outcome: "ambiguous", message: "ambiguous", polls: 1 }],
    ["rate", { outcome: "rate_limited", message: "limited", polls: 1 }],
    ["unavailable", { outcome: "unavailable", message: "unavailable", polls: 1 }],
    ["failure", { outcome: "failed", run: run({ conclusion: "failure" }), message: "red", polls: 1 }],
  ] as const) {
    const value = await fixture();
    try {
      const gateway = new FakeCiGateway(); gateway.results = [result];
      const output = await new CiCorrelationService(value.store, gateway).observe({ ...request(), correlationId: name });
      assert.equal(output.outcome, "observed"); assert.equal(output.state, name === "rate" ? "rate_limited" : name === "failure" ? "failed" : name);
      assert.equal(gateway.calls, 1);
    } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
  }
});

test("rolls back a pending correlation transaction and reports provider identity conflict", async () => {
  const value = await fixture();
  try {
    const provenance = value.store.pullRequests.getByTaskAttempt(taskId, attemptId);
    assert.equal(provenance.outcome, "success");
    if (provenance.outcome !== "success") return;
    const started = value.store.transaction((transaction) => {
      const saved = transaction.ciCorrelations.start({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, featurePullRequest: pullRequest, workerId: "worker", headBranch: branch, baseBranch: "develop", pushedCommit: sha, provider: "github-actions", requiredWorkflowName: "Required gate", createdAt: t1, updatedAt: t1 });
      assert.equal(saved.outcome, "success");
      return { outcome: "conflict", message: "forced rollback" } as const;
    });
    assert.equal(started.outcome, "conflict"); assert.equal(value.store.ciCorrelations.getByTaskAttempt(taskId, attemptId).outcome, "not_found");
    const gateway = new FakeCiGateway(); const service = new CiCorrelationService(value.store, gateway);
    const first = await service.observe(request()); assert.equal(first.outcome, "observed");
    assert.equal((await service.observe({ ...request(), provider: "other-ci" })).outcome, "conflict");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("rejects malformed durable optional run data instead of returning a partial correlation", async () => {
  const value = await fixture();
  try {
    const gateway = new FakeCiGateway();
    const observed = await new CiCorrelationService(value.store, gateway).observe(request());
    assert.equal(observed.outcome, "observed");
    value.store.database.prepare("UPDATE runtime_ci_correlations SET provider_run_url = ? WHERE task_id = ? AND attempt_id = ?").run("not-a-url", taskId, attemptId);
    assert.equal(value.store.ciCorrelations.getByTaskAttempt(taskId, attemptId).outcome, "invalid_record");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});
