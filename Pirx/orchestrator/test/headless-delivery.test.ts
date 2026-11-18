import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  HeadlessDeliveryCoordinator,
  RuntimeSqliteStore,
  createTask,
  transitionAttempt,
  type AttemptId,
  type HeadlessDeliveryRepositoryRuntime,
  type HeadlessRepositoryConfig,
  type ReleaseId,
  type ShipmentCycleRequest,
  type ShipmentCycleResult,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-10-30T10:00:00.000Z" as UtcTimestamp;
const t1 = "2026-10-30T10:01:00.000Z" as UtcTimestamp;
const sha = "a".repeat(40);
const mergeSha = "b".repeat(40);
const taskId = "headless-delivery-task" as TaskId;
const attemptId = "headless-delivery-attempt" as AttemptId;
const config: HeadlessRepositoryConfig = {
  repository: "PiotrGry/ai-assistant", repositoryRoot: "/tmp/ai-assistant", baseBranch: "develop", baseRevision: "0".repeat(40), remoteName: "origin", testCommands: ["npm run check"],
  delivery: { releaseBranch: "main", featureWorkflowName: "CI", releaseRequiredChecks: ["CI"], featureRequiredApprovals: 0, releaseRequiredApprovals: 0, featureMergeMethod: "merge", releaseMergeMethod: "merge", requireMergeable: true },
};

class ShipmentPort {
  calls: ShipmentCycleRequest[] = [];
  result: ShipmentCycleResult = { outcome: "pending_or_timeout", taskId, attemptId, eventId: "shipment:fixture", message: "CI pending" };
  async run(request: ShipmentCycleRequest): Promise<ShipmentCycleResult> { this.calls.push(request); return { ...this.result, taskId: request.taskId, attemptId: request.attemptId, eventId: request.eventId }; }
}

class ReleasePort {
  calls: Array<{ releaseId: ReleaseId; expectedReleaseHeadSha: string }> = [];
  async merge(request: { readonly releaseId: ReleaseId; readonly expectedReleaseHeadSha: string }) {
    this.calls.push(request);
    return { outcome: "merged" as const, releaseId: request.releaseId, checked: ["CI"], mergeRevision: "c".repeat(40), message: "release merged" };
  }
}

async function fixture(terminal = true): Promise<{ directory: string; filename: string; store: RuntimeSqliteStore; shipment: ShipmentPort; release: ReleasePort; runtime: HeadlessDeliveryRepositoryRuntime }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-headless-delivery-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  const task = createTask({ id: taskId, githubReference: { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 210 }, goal: "Deliver exact code", scope: "CI and Release", acceptanceCriteria: ["release is correlated"], priority: 100, risk: "high", requiredCapabilities: ["repository.write"], createdAt: t0 });
  if (!task.ok || store.tasks.create(task.value).outcome !== "success") throw new Error("Task fixture failed.");
  const started = store.startAttempt(taskId, { id: attemptId, worker: "pirx", provider: "claude-code", branch: "pirx/task-headless-delivery", worktree: "/tmp/worktree" }, t0);
  if (started.outcome !== "success") throw new Error(started.message);
  if (terminal) {
    const completed = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch: "pirx/task-headless-delivery", finalCommit: sha, currentCommit: sha }, t1);
    if (!completed.ok || store.attempts.update(completed.value, "running").outcome !== "success") throw new Error("Attempt fixture failed.");
  }
  const shipment = new ShipmentPort();
  const release = new ReleasePort();
  const runtime: HeadlessDeliveryRepositoryRuntime = {
    config,
    shipment,
    releaseMerge: release,
  };
  return { directory, filename, store, shipment, release, runtime };
}

async function dispose(value: { directory: string; store: RuntimeSqliteStore }): Promise<void> { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }

test("allows the scheduler to claim an already-created durable retry Attempt", async () => {
  const value = await fixture(false);
  try {
    const result = await new HeadlessDeliveryCoordinator(value.store, [value.runtime], { now: () => t1 }).reconcile();
    assert.equal(result.outcome, "worker_required");
    assert.equal(result.allowWorkerCycle, true);
    assert.equal(value.shipment.calls.length, 0);
  } finally { await dispose(value); }
});

test("keeps pending CI in delivery and does not start an unrelated worker", async () => {
  const value = await fixture();
  try {
    const result = await new HeadlessDeliveryCoordinator(value.store, [value.runtime], { now: () => t1 }).reconcile();
    assert.equal(result.outcome, "waiting");
    assert.equal(result.allowWorkerCycle, false);
    assert.equal(value.shipment.calls[0]?.expectedHeadSha, sha);
    assert.equal(value.release.calls.length, 0);
  } finally { await dispose(value); }
});

test("hands a durable failed-CI retry back to the leased scheduler", async () => {
  const value = await fixture();
  try {
    value.shipment.result = { outcome: "retry_created", taskId, attemptId, eventId: "fixture", successorAttemptId: "retry-attempt" as AttemptId, evidenceDigest: "evidence", message: "retry created" };
    const result = await new HeadlessDeliveryCoordinator(value.store, [value.runtime], { now: () => t1 }).reconcile();
    assert.equal(result.outcome, "retry_ready");
    assert.equal(result.allowWorkerCycle, true);
  } finally { await dispose(value); }
});

test("creates one immutable Release membership after exact-green feature merge and replays it", async () => {
  const value = await fixture();
  let store = value.store;
  try {
    value.shipment.result = { outcome: "recovery_success", taskId, attemptId, eventId: "fixture", mergeSha, pullRequest: { number: 210, url: "https://github.com/PiotrGry/ai-assistant/pull/210", state: "closed", headBranch: "pirx/task-headless-delivery", headSha: sha, baseBranch: "develop", merged: true, mergeCommitSha: mergeSha }, message: "feature merged" };
    const coordinator = new HeadlessDeliveryCoordinator(store, [value.runtime], { now: () => t1 });
    const first = await coordinator.reconcile();
    store.close();
    store = RuntimeSqliteStore.open({ filename: value.filename });
    const second = await new HeadlessDeliveryCoordinator(store, [value.runtime], { now: () => t1 }).reconcile();
    assert.equal(first.outcome, "release_merged");
    assert.equal(second.outcome, "release_merged");
    assert.equal(first.releaseId, second.releaseId);
    assert.equal(value.release.calls.length, 2);
    assert.equal(value.release.calls[0]?.expectedReleaseHeadSha, mergeSha);
    const members = store.releases.listTasks(first.releaseId!);
    assert.equal(members.outcome, "success");
    if (members.outcome === "success") {
      assert.equal(members.value.length, 1);
      assert.equal(members.value[0]?.selectedRevision, sha);
      assert.equal(members.value[0]?.featurePullRequest?.number, 210);
    }
  } finally { await dispose({ directory: value.directory, store }); }
});

function startCycle(store: RuntimeSqliteStore): void {
  const started = store.shipmentCycles.start({ schemaVersion: 1, taskId, attemptId, eventId: `shipment:${attemptId}`, correlationId: `delivery:${taskId}:${attemptId}`, repository: config.repository, headBranch: "pirx/task-headless-delivery", baseBranch: "develop", expectedHeadSha: sha, provider: "github-actions", workflowName: "CI", completionMode: "merge", state: "started", message: "Shipment cycle started.", createdAt: t1, updatedAt: t1, version: 1 });
  if (started.outcome !== "success") throw new Error(started.message);
}

test("a PR behind its base is synced by Pirx and delivery then waits for CI on the new Attempt", async () => {
  const value = await fixture();
  try {
    value.shipment.result = { outcome: "base_behind", taskId, attemptId, eventId: "shipment:fixture", message: "PR #1 is behind develop." };
    const calls: Array<{ remoteName: string; baseBranch: string }> = [];
    const successor = "headless-delivery-attempt-2" as AttemptId;
    const delivery = new HeadlessDeliveryCoordinator(value.store, [{ ...value.runtime, branchSync: { sync: async (request) => { calls.push({ remoteName: request.remoteName, baseBranch: request.baseBranch }); return { outcome: "synced", message: "Pirx merged develop as ddddddd.", successorAttemptId: successor, commit: "d".repeat(40) }; } } }], { now: () => t1 });
    const result = await delivery.reconcile();
    assert.equal(result.outcome, "waiting");
    assert.equal(result.attemptId, successor);
    assert.equal(result.allowWorkerCycle, false);
    assert.deepEqual(calls, [{ remoteName: "origin", baseBranch: "develop" }]);
  } finally { await dispose(value); }
});

test("a sync conflict blocks delivery once, so the merge and repository hooks are not re-run every cycle", async () => {
  const value = await fixture();
  try {
    startCycle(value.store);
    value.shipment.result = { outcome: "base_behind", taskId, attemptId, eventId: "shipment:fixture", message: "PR #1 is behind develop." };
    const delivery = new HeadlessDeliveryCoordinator(value.store, [{ ...value.runtime, branchSync: { sync: async () => ({ outcome: "conflict", message: "Merging develop conflicts in 1 file(s).", conflictedFiles: ["shared.txt"] }) } }], { now: () => t1 });
    const result = await delivery.reconcile();
    assert.equal(result.outcome, "blocked");
    assert.match(result.message, /Files: shared\.txt/u);
    const cycle = value.store.shipmentCycles.getByTaskAttempt(taskId, attemptId);
    assert.equal(cycle.outcome === "success" ? `${cycle.value.state}:${cycle.value.outcome}` : "missing", "blocked:policy_blocked");
  } finally { await dispose(value); }
});

test("without a branch sync a behind PR blocks with the reason instead of waiting forever", async () => {
  const value = await fixture();
  try {
    startCycle(value.store);
    value.shipment.result = { outcome: "base_behind", taskId, attemptId, eventId: "shipment:fixture", message: "PR #1 is behind develop." };
    const result = await new HeadlessDeliveryCoordinator(value.store, [value.runtime], { now: () => t1 }).reconcile();
    assert.equal(result.outcome, "blocked");
    assert.match(result.message, /behind develop\. Branch sync is not configured/u);
  } finally { await dispose(value); }
});

/** zdrovena-reconciliation releases on its own: Pirx ends the Task at the base merge once the pipeline passed for it. */
function selfReleasing(value: Awaited<ReturnType<typeof fixture>>, runs: { validation: Array<{ id: number; status: "completed" | "in_progress"; conclusion?: "success" | "failure" }> }): HeadlessDeliveryRepositoryRuntime {
  value.shipment.result = { outcome: "recovery_success", taskId, attemptId, eventId: "fixture", mergeSha, pullRequest: { number: 210, url: "https://github.com/PiotrGry/ai-assistant/pull/210", state: "closed", headBranch: "pirx/task-headless-delivery", headSha: sha, baseBranch: "develop", merged: true, mergeCommitSha: mergeSha }, message: "feature merged" };
  const started = value.store.featureMerges.start({ schemaVersion: 1, taskId, attemptId, repository: config.repository, pullRequestNodeId: "PR_210", pullRequestNumber: 210, pullRequestUrl: "https://github.com/PiotrGry/ai-assistant/pull/210", headBranch: "pirx/task-headless-delivery", baseBranch: "develop", expectedHeadSha: sha, state: "pending", createdAt: t1, updatedAt: t1, version: 1 });
  if (started.outcome !== "success" || value.store.featureMerges.markMerged(taskId, attemptId, mergeSha, t1).outcome !== "success") throw new Error("feature merge fixture failed");
  const ok = <T>(item: T) => ({ outcome: "success" as const, value: item, correlationId: "test", remoteOutcome: "accepted" as const });
  return {
    ...value.runtime,
    config: { ...config, delivery: { ...config.delivery, postMerge: { checks: [{ workflow: "release-validation.yml", branch: "develop" }], mustReach: ["main"], optionalGraceMinutes: 15, timeoutMinutes: 180 } } },
    postMerge: {
      listWorkflowRuns: async () => ok(runs.validation.map((run) => ({ ...run, headSha: mergeSha, pullRequestNumbers: [], url: `https://github.com/o/r/actions/runs/${run.id}`, updatedAt: t1 }))),
      contains: async (ancestor: string, head: string) => ok(ancestor === head),
      branchHead: async () => ok(mergeSha),
    },
  };
}

test("a self-releasing repository completes the Task once its pipeline passed for the merge, without a Pirx Release", async () => {
  const value = await fixture();
  try {
    const runs: Parameters<typeof selfReleasing>[1] = { validation: [{ id: 7, status: "in_progress" }] };
    const cleanups: Array<{ attemptId: string; baseBranch: string; remoteName: string }> = [];
    const runtime: HeadlessDeliveryRepositoryRuntime = { ...selfReleasing(value, runs), branchCleanup: { cleanup: async (request) => { cleanups.push({ attemptId: request.attemptId, baseBranch: request.baseBranch, remoteName: request.remoteName }); return { outcome: "deleted", message: "Deleted the branch." }; } } };
    const waiting = await new HeadlessDeliveryCoordinator(value.store, [runtime], { now: () => t1 }).reconcile();
    assert.equal(waiting.outcome, "waiting", waiting.message);
    runs.validation = [{ id: 7, status: "completed", conclusion: "success" }];
    const done = await new HeadlessDeliveryCoordinator(value.store, [runtime], { now: () => t1 }).reconcile();
    assert.equal(done.outcome, "completed", done.message);
    assert.deepEqual(cleanups, [{ attemptId, baseBranch: "develop", remoteName: "origin" }]);
    assert.match(done.message, /Deleted the branch\.$/u);
    assert.equal(value.release.calls.length, 0);
    const task = value.store.tasks.get(taskId);
    assert.equal(task.outcome === "success" ? task.value.state : task.outcome, "completed");
    assert.equal(task.outcome === "success" ? task.value.completionEvidence?.evidenceReference : "", `post-merge:${mergeSha}:7`);
    assert.equal((await new HeadlessDeliveryCoordinator(value.store, [runtime], { now: () => t1 }).reconcile()).outcome, "idle");
  } finally { await dispose(value); }
});

test("a pipeline failure after the merge keeps the Task open and names the failed run", async () => {
  const value = await fixture();
  try {
    const runtime = selfReleasing(value, { validation: [{ id: 8, status: "completed", conclusion: "failure" }] });
    const failed = await new HeadlessDeliveryCoordinator(value.store, [runtime], { now: () => t1 }).reconcile();
    assert.equal(failed.outcome, "blocked", failed.message);
    assert.match(failed.message, /release-validation\.yml on develop failed for bbbbbbb: run 8/u);
    const task = value.store.tasks.get(taskId);
    assert.equal(task.outcome === "success" ? task.value.state : task.outcome, "in_progress");
  } finally { await dispose(value); }
});
