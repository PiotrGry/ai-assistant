import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  RuntimeSqliteStore,
  createTask,
  releaseId,
  transitionAttempt,
  type AttemptId,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-14T12:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T12:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-14T12:02:00.000Z" as UtcTimestamp;
const t3 = "2026-09-14T12:03:00.000Z" as UtcTimestamp;
const t4 = "2026-09-14T12:04:00.000Z" as UtcTimestamp;
const t5 = "2026-09-14T12:05:00.000Z" as UtcTimestamp;

function task(id: string): TaskSnapshot {
  const value = createTask({ id: id as TaskId, goal: "Release task", scope: "release aggregate", acceptanceCriteria: ["pushed"], priority: 1, risk: "low", requiredCapabilities: ["git.commit"], createdAt: t0 });
  if (!value.ok) throw new Error(value.error.message);
  return value.value;
}

async function fixture(): Promise<{ directory: string; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-release-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}

function pushedAttempt(store: RuntimeSqliteStore, taskValue: TaskSnapshot, attempt: string, commit: string): void {
  assert.equal(store.tasks.create(taskValue).outcome, "success");
  const started = store.startAttempt(taskValue.id, { id: attempt as AttemptId, worker: "pirx", provider: "test", branch: `task/${taskValue.id}` }, t1);
  if (started.outcome !== "success") throw new Error(started.message);
  const finished = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch: `task/${taskValue.id}`, finalCommit: commit }, t2);
  if (!finished.ok) throw new Error(finished.error.message);
  assert.equal(store.attempts.update(finished.value, "running").outcome, "success");
}

test("persists a multi-Task Release and immutable selected Attempt membership across restart", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    pushedAttempt(store, task("release-task-1"), "release-attempt-1", "revision-1");
    pushedAttempt(store, task("release-task-2"), "release-attempt-2", "revision-2");
    const created = store.releases.create({ id: releaseId("release-1"), repository: "PiotrGry/ai-assistant", sourceBranch: "feature/release", baseBranch: "main", createdAt: t0 });
    assert.equal(created.outcome, "success");
    assert.equal(store.releases.addTask({ releaseId: releaseId("release-1"), taskId: "release-task-1" as TaskId, attemptId: "release-attempt-1" as AttemptId, selectedRevision: "revision-1", createdAt: t1, featurePullRequest: { nodeId: "PR_1", number: 1, url: "https://github.com/PiotrGry/ai-assistant/pull/1" } }).outcome, "success");
    assert.equal(store.releases.addTask({ releaseId: releaseId("release-1"), taskId: "release-task-2" as TaskId, attemptId: "release-attempt-2" as AttemptId, selectedRevision: "revision-2", createdAt: t1 }).outcome, "success");
    const membership = store.releases.listTasks("release-1");
    assert.equal(membership.outcome, "success");
    if (membership.outcome === "success") assert.equal(membership.value.length, 2);
    const validating = store.releases.transition("release-1", { to: "validating", expectedVersion: 1, now: t2 });
    assert.equal(validating.outcome, "success");
    assert.equal(store.releases.addTask({ releaseId: releaseId("release-1"), taskId: "release-task-1" as TaskId, attemptId: "release-attempt-2" as AttemptId, selectedRevision: "revision-2", createdAt: t1 }).outcome, "conflict");
  } finally {
    store.close();
  }
  const reopened = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    const release = reopened.releases.get("release-1");
    assert.equal(release.outcome, "success");
    if (release.outcome === "success") assert.equal(release.value.state, "validating");
    const lookup = reopened.releases.listByTaskAttempt("release-task-1", "release-attempt-1");
    assert.equal(lookup.outcome, "success");
  } finally {
    reopened.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("enforces legal ordered transitions, reasons, CAS, replay, and rollback", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    pushedAttempt(store, task("release-transition-task"), "release-transition-attempt", "revision-transition");
    assert.equal(store.releases.create({ id: releaseId("release-transition"), repository: "PiotrGry/ai-assistant", sourceBranch: "feature/release", baseBranch: "main", createdAt: t0 }).outcome, "success");
    assert.equal(store.releases.transition("release-transition", { to: "deployed", expectedVersion: 1, now: t1 }).outcome, "conflict");
    const validating = store.releases.transition("release-transition", { to: "validating", expectedVersion: 1, now: t1 });
    assert.equal(validating.outcome, "success");
    assert.equal(store.releases.transition("release-transition", { to: "ready_to_merge", expectedVersion: 1, now: t2 }).outcome, "conflict");
    assert.equal(store.releases.transition("release-transition", { to: "ready_to_merge", expectedVersion: 2, now: t2 }).outcome, "success");
    assert.equal(store.releases.transition("release-transition", { to: "merging", expectedVersion: 3, now: t3, releasePullRequest: { nodeId: "PR_RELEASE", number: 8, url: "https://github.com/PiotrGry/ai-assistant/pull/8" } }).outcome, "success");
    const deploying = store.releases.transition("release-transition", { to: "deploying", expectedVersion: 4, now: t4, mergeRevision: "revision-transition", deploymentProviderId: "provider-1" });
    assert.equal(deploying.outcome, "success");
    assert.equal(store.releases.transition("release-transition", { to: "production_verification", expectedVersion: 5, now: t5 }).outcome, "success");
    const deployed = store.releases.transition("release-transition", { to: "deployed", expectedVersion: 6, now: t5, productionVersion: "prod-1" });
    assert.equal(deployed.outcome, "success");
    if (deployed.outcome !== "success") return;
    assert.equal(store.releases.transition("release-transition", { to: "rolled_back", expectedVersion: deployed.value.version, now: t5 }).outcome, "invalid_record");
    const rollback = store.releases.transition("release-transition", { to: "rolled_back", expectedVersion: deployed.value.version, now: t5, failureReason: "verification regression" });
    assert.equal(rollback.outcome, "success");
    assert.equal(store.releases.transition("release-transition", { to: "rolled_back", expectedVersion: deployed.value.version, now: t5, failureReason: "verification regression" }).outcome, "conflict");

    const replay = store.releases.create({ id: releaseId("release-transition"), repository: "PiotrGry/ai-assistant", sourceBranch: "feature/release", baseBranch: "main", createdAt: t0 });
    assert.equal(replay.outcome, "success");
    const transactionRollback = store.transaction(({ releases }) => {
      const created = releases.create({ id: releaseId("release-rollback"), repository: "PiotrGry/ai-assistant", sourceBranch: "feature/release", baseBranch: "main", createdAt: t0 });
      if (created.outcome !== "success") return created;
      return { outcome: "conflict" as const, message: "rollback test" };
    });
    assert.equal(transactionRollback.outcome, "conflict");
    assert.equal(store.releases.get("release-rollback").outcome, "not_found");
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("lists interrupted lifecycle states and recovers them to human action", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    assert.equal(store.releases.create({ id: releaseId("release-recovery"), repository: "PiotrGry/ai-assistant", sourceBranch: "feature/release", baseBranch: "main", createdAt: t0 }).outcome, "success");
    assert.equal(store.releases.transition("release-recovery", { to: "validating", expectedVersion: 1, now: t1 }).outcome, "success");
    assert.equal(store.releases.transition("release-recovery", { to: "ready_to_merge", expectedVersion: 2, now: t2 }).outcome, "success");
    assert.equal(store.releases.transition("release-recovery", { to: "merging", expectedVersion: 3, now: t3 }).outcome, "success");
    const recoverable = store.releases.listRecoverable();
    assert.equal(recoverable.outcome, "success");
    if (recoverable.outcome === "success") assert.equal(recoverable.value[0]?.state, "merging");
    const recovered = store.releases.recover("release-recovery", 4, t4, "process restarted during merge");
    assert.equal(recovered.outcome, "success");
    if (recovered.outcome === "success") assert.equal(recovered.value.state, "human_action_required");
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});
