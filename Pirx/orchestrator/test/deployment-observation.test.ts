import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DeploymentObservationRepository,
  ReleaseCorrelationService,
  ReleaseDeploymentObserver,
  RuntimeSqliteStore,
  createTask,
  releaseId,
  transitionAttempt,
  type AttemptId,
  type DeploymentGatewayResult,
  type DeploymentObservation,
  type DeploymentObservationContext,
  type DeploymentObservationQuery,
  type ReleaseDeploymentGateway,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-10-29T12:00:00.000Z" as UtcTimestamp;
const t1 = "2026-10-29T12:01:00.000Z" as UtcTimestamp;
const t2 = "2026-10-29T12:02:00.000Z" as UtcTimestamp;
const t3 = "2026-10-29T12:03:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const selectedRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const releaseHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const mergeRevision = "cccccccccccccccccccccccccccccccccccccccc";
const releasePullRequest = { nodeId: "pr:800", number: 800, url: "https://github.com/PiotrGry/ai-assistant/pull/800" } as const;

function observation(outcome: DeploymentObservation["outcome"], overrides: Partial<DeploymentObservation> = {}): DeploymentObservation {
  return { schemaVersion: 1, repository, workflowName: "Production Deploy", environment: "production", revision: mergeRevision, provider: "github-actions", providerRunId: "run-800", runUrl: "https://github.com/PiotrGry/ai-assistant/actions/runs/800", providerDeploymentId: "deployment-800", deploymentUrl: "https://github.com/PiotrGry/ai-assistant/deployments/800", outcome, status: outcome === "pending" ? "queued" : "completed", conclusion: outcome, failureReferences: outcome === "failed" ? [{ name: "deploy", providerJobId: "job-1", url: "https://github.com/PiotrGry/ai-assistant/actions/jobs/1" }] : [], observedAt: outcome === "pending" ? t2 : t3, ...overrides };
}

class FakeDeploymentGateway implements ReleaseDeploymentGateway {
  calls = 0;
  results: DeploymentGatewayResult[] = [{ outcome: "pending", observation: observation("pending"), message: "pending" }];
  async observe(_query: DeploymentObservationQuery, _context: DeploymentObservationContext): Promise<DeploymentGatewayResult> { this.calls += 1; return this.results.shift() ?? { outcome: "unknown", message: "no fixture" }; }
}

interface Fixture { readonly directory: string; readonly filename: string; readonly store: RuntimeSqliteStore; readonly gateway: FakeDeploymentGateway; }
async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-deployment-observation-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  const taskId = "deployment-task" as TaskId; const attemptId = "deployment-attempt" as AttemptId; const branch = "pirx/deployment";
  const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 801, nodeId: "issue-801", url: "https://github.com/PiotrGry/ai-assistant/issues/801" } as const;
  const task = createTask({ id: taskId, githubReference: issue, goal: "Deploy", scope: "release", acceptanceCriteria: ["observed"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
  if (!task.ok || store.tasks.create(task.value).outcome !== "success") throw new Error("Task fixture failed.");
  const started = store.startAttempt(taskId, { id: attemptId, worker: "claude", provider: "claude-code", branch }, t0); if (started.outcome !== "success") throw new Error(started.message);
  const terminal = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: selectedRevision }, t1); if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("Attempt fixture failed.");
  const featurePullRequest = { nodeId: "feature-pr-801", number: 801, url: "https://github.com/PiotrGry/ai-assistant/pull/801" } as const;
  const provenance = store.pullRequests.save({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, workerId: "claude", headBranch: branch, baseBranch: "develop", observedHeadSha: selectedRevision, pullRequest: featurePullRequest, createdAt: t1, updatedAt: t1 }); if (provenance.outcome !== "success") throw new Error(provenance.message);
  const ci = store.ciCorrelations.start({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, featurePullRequest, workerId: "claude", headBranch: branch, baseBranch: "develop", pushedCommit: selectedRevision, provider: "github-actions", requiredWorkflowName: "Develop CI", createdAt: t1, updatedAt: t1 }); if (ci.outcome !== "success") throw new Error(ci.message);
  const ciObserved = store.ciCorrelations.recordObservation(taskId, attemptId, { state: "success", run: { schemaVersion: 1, provider: "github-actions", providerRunId: "feature-run", name: "Develop CI", status: "completed", conclusion: "success", testedRevision: selectedRevision, headBranch: branch, pullRequestNumbers: [801], url: "https://github.com/PiotrGry/ai-assistant/actions/runs/801" }, observedAt: t1 }); if (ciObserved.outcome !== "success") throw new Error(ciObserved.message);
  assert.equal(store.releases.create({ id: releaseId("deployment-release"), repository, sourceBranch: "develop", baseBranch: "main", createdAt: t0 }).outcome, "success");
  assert.equal(store.releases.addTask({ releaseId: releaseId("deployment-release"), taskId, attemptId, selectedRevision, featurePullRequest, createdAt: t1 }).outcome, "success");
  let release = store.releases.transition("deployment-release", { to: "validating", expectedVersion: 1, now: t1 }); assert.equal(release.outcome, "success");
  release = store.releases.transition("deployment-release", { to: "ready_to_merge", expectedVersion: 2, now: t1, releasePullRequest }); assert.equal(release.outcome, "success");
  release = store.releases.transition("deployment-release", { to: "merging", expectedVersion: 3, now: t1, releasePullRequest }); assert.equal(release.outcome, "success");
  release = store.releases.transition("deployment-release", { to: "deploying", expectedVersion: 4, now: t1, releasePullRequest, mergeRevision }); assert.equal(release.outcome, "success");
  const correlated = new ReleaseCorrelationService(store).correlate({ releaseId: releaseId("deployment-release"), repository, sourceBranch: "develop", baseBranch: "main", releasePullRequest, releaseHeadRevision: releaseHead, memberRevisions: [selectedRevision], workflow: { provider: "github-actions", providerRunId: "release-run", url: "https://github.com/PiotrGry/ai-assistant/actions/runs/802", name: "Main CI", testedRevision: releaseHead }, mergeRevision, observedAt: t1 }); assert.equal(correlated.outcome, "correlated");
  return { directory, filename, store, gateway: new FakeDeploymentGateway() };
}
function request(overrides: Partial<{ revision: string; environment: string; now: UtcTimestamp }> = {}) { return { releaseId: releaseId("deployment-release"), repository, workflowName: "Production Deploy", environment: overrides.environment ?? "production", revision: overrides.revision ?? mergeRevision, correlationId: "deployment-correlation", now: overrides.now ?? t3 }; }
async function close(value: Fixture): Promise<void> { try { value.store.close(); } finally { await rm(value.directory, { recursive: true, force: true }); } }

test("persists pending-to-success deployment evidence and advances only the exact Release", async () => {
  const value = await fixture(); value.gateway.results = [{ outcome: "pending", observation: observation("pending"), message: "pending" }, { outcome: "succeeded", observation: observation("succeeded"), message: "deployed" }];
  try {
    const observer = new ReleaseDeploymentObserver(value.store, value.gateway);
    assert.equal((await observer.observe(request())).outcome, "pending");
    const succeeded = await observer.observe(request()); assert.equal(succeeded.outcome, "succeeded");
    const release = value.store.releases.get("deployment-release"); assert.equal(release.outcome, "success"); if (release.outcome === "success") { assert.equal(release.value.state, "production_verification"); assert.equal(release.value.deploymentProviderId, "deployment-800"); }
    const history = new DeploymentObservationRepository(value.store).list(releaseId("deployment-release")); assert.equal(history.outcome, "success"); if (history.outcome === "success") assert.equal(history.value.length, 2);
  } finally { await close(value); }
});

test("replays a successful exact deployment after restart without another provider call", async () => {
  const value = await fixture(); value.gateway.results = [{ outcome: "succeeded", observation: observation("succeeded"), message: "deployed" }];
  try {
    assert.equal((await new ReleaseDeploymentObserver(value.store, value.gateway).observe(request())).outcome, "succeeded"); value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: value.filename }); try { assert.equal((await new ReleaseDeploymentObserver(reopened, value.gateway).observe(request())).outcome, "replayed"); assert.equal(value.gateway.calls, 1); } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* restart closed it */ } await rm(value.directory, { recursive: true, force: true }); }
});

test("keeps stale, delayed, failed, cancelled, superseded and unavailable outcomes explicit", async () => {
  const stale = await fixture(); try { assert.equal((await new ReleaseDeploymentObserver(stale.store, stale.gateway).observe(request({ revision: "wrong" }))).outcome, "stale"); assert.equal(stale.gateway.calls, 0); } finally { await close(stale); }
  for (const outcome of ["running", "failed", "cancelled", "superseded"] as const) {
    const value = await fixture(); value.gateway.results = [{ outcome, observation: observation(outcome), message: outcome }];
    try { assert.equal((await new ReleaseDeploymentObserver(value.store, value.gateway).observe(request())).outcome, outcome); assert.equal(value.store.releases.get("deployment-release").outcome, "success"); }
    finally { await close(value); }
  }
  for (const outcome of ["not_found", "ambiguous", "rate_limited", "provider_error", "unknown"] as const) {
    const value = await fixture(); value.gateway.results = [{ outcome, message: outcome }];
    try { assert.equal((await new ReleaseDeploymentObserver(value.store, value.gateway).observe(request())).outcome, outcome); }
    finally { await close(value); }
  }
  const wrongEnvironment = await fixture(); wrongEnvironment.gateway.results = [{ outcome: "succeeded", observation: observation("succeeded", { environment: "staging" }), message: "wrong" }];
  try { assert.equal((await new ReleaseDeploymentObserver(wrongEnvironment.store, wrongEnvironment.gateway).observe(request())).outcome, "stale"); }
  finally { await close(wrongEnvironment); }
});

test("binds replay to the first durable workflow and environment query", async () => {
  const value = await fixture();
  value.gateway.results = [{ outcome: "pending", observation: observation("pending"), message: "pending" }];
  try {
    const observer = new ReleaseDeploymentObserver(value.store, value.gateway);
    assert.equal((await observer.observe(request())).outcome, "pending");
    assert.equal((await observer.observe({ ...request(), workflowName: "Another Deploy" })).outcome, "conflict");
    assert.equal((await observer.observe(request({ environment: "staging" }))).outcome, "conflict");
    assert.equal(value.gateway.calls, 1);
  } finally { await close(value); }
});
