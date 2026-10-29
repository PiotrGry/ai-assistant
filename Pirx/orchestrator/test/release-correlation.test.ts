import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ReleaseCorrelationService,
  RuntimeSqliteStore,
  createTask,
  releaseId,
  transitionAttempt,
  type AttemptId,
  type ReleaseCorrelationRequest,
  type ReleasePullRequestIdentity,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-10-29T08:00:00.000Z" as UtcTimestamp;
const t1 = "2026-10-29T08:01:00.000Z" as UtcTimestamp;
const t2 = "2026-10-29T08:02:00.000Z" as UtcTimestamp;
const t3 = "2026-10-29T08:03:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const releasePullRequest = { nodeId: "release-pr-node", number: 500, url: "https://github.com/PiotrGry/ai-assistant/pull/500" } as const;

interface FixtureMember {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly revision: string;
  readonly featurePullRequest: ReleasePullRequestIdentity;
}

async function fixture(revisions = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]): Promise<{ directory: string; filename: string; store: RuntimeSqliteStore; members: FixtureMember[] }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-release-correlation-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  const members: FixtureMember[] = [];
  for (const [index, revision] of revisions.entries()) {
    const ordinal = index + 1;
    const taskId = `release-correlation-task-${ordinal}` as TaskId;
    const attemptId = `release-correlation-attempt-${ordinal}` as AttemptId;
    const branch = `pirx/release-correlation-${ordinal}`;
    const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 300 + ordinal, nodeId: `issue-${ordinal}`, url: `https://github.com/PiotrGry/ai-assistant/issues/${300 + ordinal}` } as const;
    const created = createTask({ id: taskId, githubReference: issue, goal: `Release member ${ordinal}`, scope: "exact release correlation", acceptanceCriteria: ["exact delivery"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
    if (!created.ok || store.tasks.create(created.value).outcome !== "success") throw new Error("Task fixture failed.");
    const started = store.startAttempt(taskId, { id: attemptId, worker: "claude", provider: "claude-code", branch }, t0);
    if (started.outcome !== "success") throw new Error(started.message);
    const terminal = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: revision }, t1);
    if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("Attempt fixture failed.");
    const featurePullRequest = { nodeId: `feature-pr-${ordinal}`, number: 400 + ordinal, url: `https://github.com/PiotrGry/ai-assistant/pull/${400 + ordinal}` } as const;
    const provenance = store.pullRequests.save({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, workerId: "claude", headBranch: branch, baseBranch: "develop", observedHeadSha: revision, pullRequest: featurePullRequest, createdAt: t1, updatedAt: t1 });
    if (provenance.outcome !== "success") throw new Error(provenance.message);
    const correlation = store.ciCorrelations.start({ taskId, attemptId, repository, issueNumber: issue.issueNumber, issueNodeId: issue.nodeId, issueUrl: issue.url, featurePullRequest, workerId: "claude", headBranch: branch, baseBranch: "develop", pushedCommit: revision, provider: "github-actions", requiredWorkflowName: "Develop - Fast Gate", createdAt: t1, updatedAt: t1 });
    if (correlation.outcome !== "success") throw new Error(correlation.message);
    const observed = store.ciCorrelations.recordObservation(taskId, attemptId, { state: "success", run: { schemaVersion: 1, provider: "github-actions", providerRunId: `run-${ordinal}`, name: "Develop - Fast Gate", status: "completed", conclusion: "success", testedRevision: revision, headBranch: branch, pullRequestNumbers: [featurePullRequest.number], url: `https://github.com/PiotrGry/ai-assistant/actions/runs/${ordinal}` }, observedAt: t2 });
    if (observed.outcome !== "success") throw new Error(observed.message);
    members.push({ taskId, attemptId, revision, featurePullRequest });
  }
  assert.equal(store.releases.create({ id: releaseId("release-correlation"), repository, sourceBranch: "develop", baseBranch: "main", createdAt: t0 }).outcome, "success");
  for (const member of members) assert.equal(store.releases.addTask({ releaseId: releaseId("release-correlation"), taskId: member.taskId, attemptId: member.attemptId, selectedRevision: member.revision, featurePullRequest: member.featurePullRequest, createdAt: t1 }).outcome, "success");
  assert.equal(store.releases.transition("release-correlation", { to: "validating", expectedVersion: 1, now: t2 }).outcome, "success");
  return { directory, filename, store, members };
}

function request(members: readonly FixtureMember[], overrides: Partial<ReleaseCorrelationRequest> = {}): ReleaseCorrelationRequest {
  return {
    releaseId: releaseId("release-correlation"),
    repository,
    sourceBranch: "develop",
    baseBranch: "main",
    releasePullRequest,
    releaseHeadRevision: "cccccccccccccccccccccccccccccccccccccccc",
    memberRevisions: members.map((member) => member.revision),
    workflow: { provider: "github-actions", providerRunId: "release-run-1", url: "https://github.com/PiotrGry/ai-assistant/actions/runs/500", name: "Main CI Gate", testedRevision: "cccccccccccccccccccccccccccccccccccccccc" },
    observedAt: t3,
    ...overrides,
  };
}

test("correlates exact multi-Task Release membership and supports reverse lookups across restart", async () => {
  const value = await fixture();
  try {
    const service = new ReleaseCorrelationService(value.store);
    const correlated = service.correlate(request(value.members));
    assert.equal(correlated.outcome, "correlated");
    if (correlated.outcome !== "correlated") return;
    assert.equal(correlated.record.state, "workflow_correlated");
    assert.deepEqual(correlated.record.memberRevisions, value.members.map((member) => member.revision).sort());
    const members = service.listMembers("release-correlation");
    assert.equal(members.outcome, "success");
    if (members.outcome === "success") assert.deepEqual(members.value.map((member) => [member.taskId, member.attemptId, member.featurePullRequest?.number]), value.members.map((member) => [member.taskId, member.attemptId, member.featurePullRequest.number]));
    assert.equal(service.getByPullRequest(repository, releasePullRequest.number).outcome, "success");
    assert.equal(service.getByWorkflowRun("github-actions", "release-run-1").outcome, "success");
    const version = correlated.record.version;
    const replay = service.correlate(request(value.members));
    assert.equal(replay.outcome, "replayed");
    if (replay.outcome === "replayed") assert.equal(replay.record.version, version);
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: value.filename });
    try {
      const retained = new ReleaseCorrelationService(reopened).getByRelease("release-correlation");
      assert.equal(retained.outcome, "success");
      if (retained.outcome === "success") assert.equal(retained.value.workflow?.providerRunId, "release-run-1");
    } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* closed for restart */ } await rm(value.directory, { recursive: true, force: true }); }
});

test("correlates a one-Task Release without inventing additional membership", async () => {
  const value = await fixture(["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  try {
    const correlated = new ReleaseCorrelationService(value.store).correlate(request(value.members));
    assert.equal(correlated.outcome, "correlated");
    if (correlated.outcome === "correlated") assert.deepEqual(correlated.record.memberRevisions, [value.members[0]!.revision]);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("advances correlation through merge, deployment and production without changing immutable identity", async () => {
  const value = await fixture();
  try {
    const service = new ReleaseCorrelationService(value.store);
    const base = request(value.members);
    const { workflow: _workflow, ...pullRequestOnly } = base;
    const releasePullRequestCorrelated = service.correlate(pullRequestOnly);
    assert.equal(releasePullRequestCorrelated.outcome, "correlated");
    if (releasePullRequestCorrelated.outcome === "correlated") assert.equal(releasePullRequestCorrelated.record.state, "release_pr_correlated");
    assert.equal(service.correlate(base).outcome, "correlated");
    const merged = service.correlate({ ...base, mergeRevision: "dddddddddddddddddddddddddddddddddddddddd", observedAt: "2026-10-29T08:04:00.000Z" as UtcTimestamp });
    assert.equal(merged.outcome, "correlated");
    const deployed = service.correlate({ ...base, mergeRevision: "dddddddddddddddddddddddddddddddddddddddd", deployment: { provider: "github-actions", providerDeploymentId: "deployment-1", environment: "production", deployedRevision: "dddddddddddddddddddddddddddddddddddddddd" }, productionVersion: "2026.10.29.1", observedAt: "2026-10-29T08:05:00.000Z" as UtcTimestamp });
    assert.equal(deployed.outcome, "correlated");
    if (deployed.outcome === "correlated") assert.equal(deployed.record.state, "production_observed");
    assert.equal(service.getByDeployment("github-actions", "deployment-1").outcome, "success");
    assert.equal(service.getByProductionVersion(repository, "2026.10.29.1").outcome, "success");
    const superseded = service.correlate({ ...base, mergeRevision: "dddddddddddddddddddddddddddddddddddddddd", deployment: { provider: "github-actions", providerDeploymentId: "deployment-2", environment: "production", deployedRevision: "dddddddddddddddddddddddddddddddddddddddd" }, productionVersion: "2026.10.29.2", observedAt: "2026-10-29T08:06:00.000Z" as UtcTimestamp });
    assert.equal(superseded.outcome, "superseded");
    const conflict = service.correlate({ ...base, releaseHeadRevision: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", workflow: { ...base.workflow!, testedRevision: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }, observedAt: "2026-10-29T08:06:00.000Z" as UtcTimestamp });
    assert.equal(conflict.outcome, "superseded");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("rejects incomplete, conflicting, stale and ambiguous Release evidence explicitly", async () => {
  const missing = await fixture();
  try {
    const service = new ReleaseCorrelationService(missing.store);
    assert.equal(service.correlate(request(missing.members, { memberRevisions: [missing.members[0]!.revision] })).outcome, "missing_evidence");
    assert.equal(service.correlate(request(missing.members, { memberRevisions: [...missing.members.map((member) => member.revision), "ffffffffffffffffffffffffffffffffffffffff"] })).outcome, "unrelated");
    const stale = missing.store.ciCorrelations.getByTaskAttempt(missing.members[0]!.taskId, missing.members[0]!.attemptId);
    assert.equal(stale.outcome, "success");
    missing.store.database.prepare("UPDATE runtime_ci_correlations SET tested_revision = ? WHERE task_id = ? AND attempt_id = ?").run("wrong-revision", missing.members[0]!.taskId, missing.members[0]!.attemptId);
    assert.equal(service.correlate(request(missing.members)).outcome, "stale");
  } finally { missing.store.close(); await rm(missing.directory, { recursive: true, force: true }); }

  const ambiguous = await fixture();
  try {
    ambiguous.store.database.prepare("UPDATE runtime_release_tasks SET selected_revision = ? WHERE release_id = ? AND task_id = ?").run(ambiguous.members[0]!.revision, "release-correlation", ambiguous.members[1]!.taskId);
    assert.equal(new ReleaseCorrelationService(ambiguous.store).correlate(request(ambiguous.members, { memberRevisions: [ambiguous.members[0]!.revision] })).outcome, "ambiguous");
  }
  finally { ambiguous.store.close(); await rm(ambiguous.directory, { recursive: true, force: true }); }
});
