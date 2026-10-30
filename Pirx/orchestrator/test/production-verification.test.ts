import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CapabilityEnforcementGate,
  ProductionVerificationCoordinator,
  ProductionVerificationRepository,
  ReleaseCorrelationService,
  RuntimeSqliteStore,
  SafetyEnforcementGate,
  createTask,
  releaseId,
  transitionAttempt,
  transitionTask,
  type AttemptId,
  type CapabilityApproval,
  type CapabilityAuditDecision,
  type ProductionSignalEvidence,
  type ProductionSignalGateway,
  type ProductionSignalKind,
  type ProductionSignalQuery,
  type ProductionSignalContext,
  type ProductionSignalResult,
  type ProductionVerificationPolicy,
  type TaskId,
  type UtcTimestamp,
  type VerifyProductionRequest,
} from "../src/index.js";

const t0 = "2026-10-30T09:00:00.000Z" as UtcTimestamp;
const t1 = "2026-10-30T09:01:00.000Z" as UtcTimestamp;
const t2 = "2026-10-30T09:02:00.000Z" as UtcTimestamp;
const t3 = "2026-10-30T09:03:00.000Z" as UtcTimestamp;
const t4 = "2026-10-30T09:04:00.000Z" as UtcTimestamp;
const t9 = "2026-10-30T10:00:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const environment = "production";
const mergeRevision = "cccccccccccccccccccccccccccccccccccccccc";
const releaseHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const worktree = "/tmp/pirx-production-verifier";

const signalDigests: Readonly<Record<ProductionSignalKind, string>> = {
  version: "1".repeat(64),
  health: "2".repeat(64),
  metrics: "3".repeat(64),
  application_logs: "4".repeat(64),
};

function evidence(kind: ProductionSignalKind, overrides: Partial<ProductionSignalEvidence> = {}): ProductionSignalEvidence {
  return {
    schemaVersion: 1,
    kind,
    repository,
    environment,
    outcome: "healthy",
    observedRevision: mergeRevision,
    observedVersion: "release-42",
    evidenceDigest: signalDigests[kind],
    summary: `${kind} is healthy`,
    observedAt: t3,
    ...overrides,
  };
}

class FakeProductionGateway implements ProductionSignalGateway {
  readonly calls: ProductionSignalQuery[] = [];
  readonly overrides = new Map<ProductionSignalKind, ProductionSignalResult>();

  async read(query: ProductionSignalQuery, _context: ProductionSignalContext): Promise<ProductionSignalResult> {
    this.calls.push(query);
    return this.overrides.get(query.signal) ?? { outcome: "healthy", evidence: evidence(query.signal), message: "healthy" };
  }
}

interface Fixture {
  readonly directory: string;
  readonly filename: string;
  readonly store: RuntimeSqliteStore;
  readonly gateway: FakeProductionGateway;
  readonly audit: CapabilityAuditDecision[];
  readonly taskIds: readonly TaskId[];
  readonly attemptIds: readonly AttemptId[];
}

function safety(audit: CapabilityAuditDecision[]): SafetyEnforcementGate {
  return new SafetyEnforcementGate(new CapabilityEnforcementGate({ record: (decision) => { audit.push(decision); } }));
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-production-verification-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  const taskIds = ["production-task-1", "production-task-2"] as TaskId[];
  const attemptIds = ["production-attempt-1", "production-attempt-2"] as AttemptId[];
  const revisions = ["a".repeat(40), "d".repeat(40)];

  for (let index = 0; index < taskIds.length; index += 1) {
    const taskId = taskIds[index]!;
    const attemptId = attemptIds[index]!;
    const revision = revisions[index]!;
    const issueNumber = 900 + index;
    const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber, nodeId: `issue-${issueNumber}`, url: `https://github.com/PiotrGry/ai-assistant/issues/${issueNumber}` } as const;
    const created = createTask({ id: taskId, githubReference: issue, goal: "Ship to production", scope: "release", acceptanceCriteria: ["verified"], priority: 1, risk: "high", requiredCapabilities: ["production.read"], createdAt: t0 });
    if (!created.ok || store.tasks.create(created.value).outcome !== "success") throw new Error("Task fixture failed.");
    const branch = `pirx/production-${index + 1}`;
    const started = store.startAttempt(taskId, { id: attemptId, worker: "pirx", provider: "test", branch }, t0);
    if (started.outcome !== "success") throw new Error(started.message);
    const terminal = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: revision }, t1);
    if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("Attempt fixture failed.");
    const featurePullRequest = { nodeId: `feature-pr-${issueNumber}`, number: issueNumber, url: `https://github.com/PiotrGry/ai-assistant/pull/${issueNumber}` } as const;
    const provenance = store.pullRequests.save({ taskId, attemptId, repository, issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, workerId: "pirx", headBranch: branch, baseBranch: "develop", observedHeadSha: revision, pullRequest: featurePullRequest, createdAt: t1, updatedAt: t1 });
    if (provenance.outcome !== "success") throw new Error(provenance.message);
    const ci = store.ciCorrelations.start({ taskId, attemptId, repository, issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, featurePullRequest, workerId: "pirx", headBranch: branch, baseBranch: "develop", pushedCommit: revision, provider: "github-actions", requiredWorkflowName: "Develop CI", createdAt: t1, updatedAt: t1 });
    if (ci.outcome !== "success") throw new Error(ci.message);
    const observed = store.ciCorrelations.recordObservation(taskId, attemptId, { state: "success", run: { schemaVersion: 1, provider: "github-actions", providerRunId: `feature-run-${index}`, name: "Develop CI", status: "completed", conclusion: "success", testedRevision: revision, headBranch: branch, pullRequestNumbers: [issueNumber], url: `https://github.com/PiotrGry/ai-assistant/actions/runs/${issueNumber}` }, observedAt: t1 });
    if (observed.outcome !== "success") throw new Error(observed.message);
  }

  const release = releaseId("production-release");
  assert.equal(store.releases.create({ id: release, repository, sourceBranch: "develop", baseBranch: "main", createdAt: t0 }).outcome, "success");
  for (let index = 0; index < taskIds.length; index += 1) {
    const issueNumber = 900 + index;
    assert.equal(store.releases.addTask({ releaseId: release, taskId: taskIds[index]!, attemptId: attemptIds[index]!, selectedRevision: revisions[index]!, featurePullRequest: { nodeId: `feature-pr-${issueNumber}`, number: issueNumber, url: `https://github.com/PiotrGry/ai-assistant/pull/${issueNumber}` }, createdAt: t1 }).outcome, "success");
  }
  const releasePullRequest = { nodeId: "release-pr-950", number: 950, url: "https://github.com/PiotrGry/ai-assistant/pull/950" } as const;
  let transitioned = store.releases.transition(release, { to: "validating", expectedVersion: 1, now: t1 }); assert.equal(transitioned.outcome, "success");
  transitioned = store.releases.transition(release, { to: "ready_to_merge", expectedVersion: 2, now: t1, releasePullRequest }); assert.equal(transitioned.outcome, "success");
  transitioned = store.releases.transition(release, { to: "merging", expectedVersion: 3, now: t1, releasePullRequest }); assert.equal(transitioned.outcome, "success");
  transitioned = store.releases.transition(release, { to: "deploying", expectedVersion: 4, now: t2, releasePullRequest, mergeRevision }); assert.equal(transitioned.outcome, "success");
  transitioned = store.releases.transition(release, { to: "production_verification", expectedVersion: 5, now: t2, deploymentProviderId: "deployment-950" }); assert.equal(transitioned.outcome, "success");
  const correlated = new ReleaseCorrelationService(store).correlate({ releaseId: release, repository, sourceBranch: "develop", baseBranch: "main", releasePullRequest, releaseHeadRevision: releaseHead, memberRevisions: [...revisions], workflow: { provider: "github-actions", providerRunId: "release-run-950", url: "https://github.com/PiotrGry/ai-assistant/actions/runs/950", name: "Main CI", testedRevision: releaseHead }, mergeRevision, deployment: { provider: "github-actions", providerDeploymentId: "deployment-950", environment, deployedRevision: mergeRevision }, observedAt: t2 });
  assert.equal(correlated.outcome, "correlated");
  return { directory, filename, store, gateway: new FakeProductionGateway(), audit: [], taskIds, attemptIds };
}

function policy(version: ProductionVerificationPolicy["version"] = { mode: "exact_revision" }): ProductionVerificationPolicy {
  return { requiredSignals: ["version", "health", "metrics", "application_logs"], version, maxEvidenceAgeMs: 300_000 };
}

function approval(taskId: TaskId): CapabilityApproval {
  return { approvalId: "production-read-approval", taskId, capability: "production.read", resourceScope: { repository, branch: "main", worktree, environment }, approver: "human", issuedAt: t0, expiresAt: t9, oneUse: false, state: "active" };
}

function request(value: Fixture, overrides: Partial<VerifyProductionRequest> = {}): VerifyProductionRequest {
  const taskId = value.taskIds[0]!;
  return {
    releaseId: releaseId("production-release"),
    repository,
    environment,
    deployedRevision: mergeRevision,
    policy: policy(),
    authorization: { taskId, workerId: "pirx", workerGrants: ["production.read"], approvals: [approval(taskId)], assignedWorktree: worktree },
    correlationId: "production-verification",
    now: t4,
    ...overrides,
  };
}

async function cleanup(value: Fixture): Promise<void> {
  try { value.store.close(); } finally { await rm(value.directory, { recursive: true, force: true }); }
}

test("verifies exact production evidence and atomically completes the Release and member Tasks", async () => {
  const value = await fixture();
  try {
    const result = await new ProductionVerificationCoordinator(value.store, value.gateway, safety(value.audit)).verify(request(value));
    assert.equal(result.outcome, "verified");
    assert.equal(value.gateway.calls.length, 4);
    assert.equal(value.audit.length, 1);
    assert.equal(value.audit[0]?.outcome, "allowed");
    for (const taskId of value.taskIds) {
      const task = value.store.tasks.get(taskId); assert.equal(task.outcome, "success");
      if (task.outcome === "success") { assert.equal(task.value.state, "completed"); assert.match(task.value.completionEvidence?.evidenceReference ?? "", /^production-verification:/u); }
    }
    const release = value.store.releases.get("production-release"); assert.equal(release.outcome, "success");
    if (release.outcome === "success") { assert.equal(release.value.state, "deployed"); assert.equal(release.value.productionVersion, "release-42"); }
    const correlation = value.store.releaseCorrelations.getByRelease("production-release"); assert.equal(correlation.outcome, "success");
    if (correlation.outcome === "success") assert.equal(correlation.value.productionVersion, "release-42");
  } finally { await cleanup(value); }
});

test("supports an explicit configured version fallback only when revision identity is unavailable", async () => {
  const value = await fixture();
  for (const signal of ["version", "health", "metrics", "application_logs"] as const) {
    const { observedRevision: _observedRevision, ...fallbackEvidence } = evidence(signal, { observedVersion: "build-42" });
    value.gateway.overrides.set(signal, { outcome: "healthy", evidence: fallbackEvidence, message: "healthy" });
  }
  try {
    const result = await new ProductionVerificationCoordinator(value.store, value.gateway, safety(value.audit)).verify(request(value, { policy: policy({ mode: "configured_version", expectedVersion: "build-42" }) }));
    assert.equal(result.outcome, "verified");
    assert.equal(result.record?.productionVersion, "build-42");
  } finally { await cleanup(value); }
});

test("keeps non-terminal, failed, degraded, unavailable, ambiguous and stale states explicit", async (context) => {
  for (const outcome of ["pending", "failed", "degraded", "unavailable", "ambiguous", "unknown"] as const) {
    await context.test(outcome, async () => {
      const value = await fixture();
      value.gateway.overrides.set("health", { outcome, ...(outcome === "unknown" ? {} : { evidence: evidence("health", { outcome }) }), message: outcome });
      try {
        const result = await new ProductionVerificationCoordinator(value.store, value.gateway, safety(value.audit)).verify(request(value));
        assert.equal(result.outcome, outcome);
        assert.equal(value.store.releases.get("production-release").outcome, "success");
        const records = new ProductionVerificationRepository(value.store).list(releaseId("production-release")); assert.equal(records.outcome, "success");
        if (records.outcome === "success") assert.equal(records.value.length, 1);
      } finally { await cleanup(value); }
    });
  }
  await context.test("stale and superseded", async () => {
    const value = await fixture();
    value.gateway.overrides.set("health", { outcome: "healthy", evidence: evidence("health", { observedRevision: "stale-revision" }), message: "stale" });
    try { assert.equal((await new ProductionVerificationCoordinator(value.store, value.gateway, safety(value.audit)).verify(request(value))).outcome, "stale"); }
    finally { await cleanup(value); }
    const superseded = await fixture(); superseded.gateway.overrides.set("health", { outcome: "superseded", evidence: evidence("health", { outcome: "superseded" }), message: "superseded" });
    try { assert.equal((await new ProductionVerificationCoordinator(superseded.store, superseded.gateway, safety(superseded.audit)).verify(request(superseded))).outcome, "stale"); }
    finally { await cleanup(superseded); }
  });
});

test("denies missing production.read approval before any provider read", async () => {
  const value = await fixture();
  try {
    const denied = request(value, { authorization: { taskId: value.taskIds[0]!, workerId: "pirx", workerGrants: ["production.read"], approvals: [], assignedWorktree: worktree } });
    const result = await new ProductionVerificationCoordinator(value.store, value.gateway, safety(value.audit)).verify(denied);
    assert.equal(result.outcome, "policy_blocked");
    assert.equal(value.gateway.calls.length, 0);
    assert.equal(value.audit[0]?.reasonCode, "SENSITIVE_APPROVAL_REQUIRED");
  } finally { await cleanup(value); }
});

test("rolls back verified evidence, correlation and prior Task completions when one member conflicts", async () => {
  const value = await fixture();
  const blockedTask = value.store.tasks.get(value.taskIds[1]!);
  if (blockedTask.outcome !== "success") throw new Error(blockedTask.message);
  const blocked = transitionTask(blockedTask.value, "in_progress", { type: "block", reason: "manual hold" }, t3);
  if (!blocked.ok) throw new Error(blocked.error.message);
  assert.equal(value.store.tasks.update(blocked.value, { state: blockedTask.value.state, updatedAt: blockedTask.value.updatedAt }).outcome, "success");
  try {
    const result = await new ProductionVerificationCoordinator(value.store, value.gateway, safety(value.audit)).verify(request(value));
    assert.equal(result.outcome, "conflict");
    const first = value.store.tasks.get(value.taskIds[0]!); assert.equal(first.outcome, "success"); if (first.outcome === "success") assert.equal(first.value.state, "in_progress");
    const release = value.store.releases.get("production-release"); assert.equal(release.outcome, "success"); if (release.outcome === "success") assert.equal(release.value.state, "production_verification");
    const records = new ProductionVerificationRepository(value.store).list(releaseId("production-release")); assert.equal(records.outcome, "success"); if (records.outcome === "success") assert.equal(records.value.length, 0);
    const correlation = value.store.releaseCorrelations.getByRelease("production-release"); assert.equal(correlation.outcome, "success"); if (correlation.outcome === "success") assert.equal(correlation.value.productionVersion, undefined);
  } finally { await cleanup(value); }
});

test("replays verified production after restart without another signal read", async () => {
  const value = await fixture();
  try {
    assert.equal((await new ProductionVerificationCoordinator(value.store, value.gateway, safety(value.audit)).verify(request(value))).outcome, "verified");
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: value.filename });
    try {
      const replay = await new ProductionVerificationCoordinator(reopened, value.gateway, safety([])).verify(request({ ...value, store: reopened }));
      assert.equal(replay.outcome, "replayed");
      assert.equal(value.gateway.calls.length, 4);
    } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* closed for restart */ } await rm(value.directory, { recursive: true, force: true }); }
});

test("rejects invalid policy and healthy signals without correlated evidence", async () => {
  const invalid = await fixture();
  try {
    const result = await new ProductionVerificationCoordinator(invalid.store, invalid.gateway, safety(invalid.audit)).verify(request(invalid, { policy: { requiredSignals: ["health"], version: { mode: "exact_revision" }, maxEvidenceAgeMs: 300_000 } }));
    assert.equal(result.outcome, "invalid_request");
    assert.equal(invalid.gateway.calls.length, 0);
  } finally { await cleanup(invalid); }
  const missing = await fixture(); missing.gateway.overrides.set("version", { outcome: "healthy", message: "unproven" });
  try { assert.equal((await new ProductionVerificationCoordinator(missing.store, missing.gateway, safety(missing.audit)).verify(request(missing))).outcome, "unknown"); }
  finally { await cleanup(missing); }
});
