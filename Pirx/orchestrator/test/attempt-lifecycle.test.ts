import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  RuntimeSqliteStore,
  createTask,
  transitionAttempt,
  transitionTask,
  type AttemptId,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-14T16:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T16:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-14T16:02:00.000Z" as UtcTimestamp;
const t3 = "2026-09-14T16:03:00.000Z" as UtcTimestamp;

async function fixture(): Promise<{ readonly directory: string; readonly filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-attempt-lifecycle-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}
function task(id: string): TaskSnapshot {
  const result = createTask({ id: id as TaskId, goal: "Record an execution", scope: "Attempt lifecycle", acceptanceCriteria: ["durable evidence"], priority: 1, risk: "low", requiredCapabilities: ["worker"], createdAt: t0 });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test("atomically starts first and retry Attempts, records progress, and queries current/history", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    const firstTask = task("attempt-task-1");
    assert.equal(store.tasks.create(firstTask).outcome, "success");
    const first = store.startAttempt(firstTask.id, { id: "attempt-1" as AttemptId, worker: "pirx", provider: "fake", branch: "task/1", progress: "started" }, t1);
    assert.equal(first.outcome, "success");
    if (first.outcome !== "success") return;
    assert.equal(first.value.attempt.ordinal, 1);
    assert.equal(first.value.task.state, "in_progress");
    const progress = store.attempts.recordProgress(first.value.attempt.id, { state: "running", startedAt: t1 }, { checkpointReference: "checkpoint://1", currentCommit: "abc123", testSummary: "unit tests pending", progress: "validated inputs" }, t2);
    assert.equal(progress.outcome, "success");
    const current = store.attempts.currentByTask(firstTask.id);
    assert.equal(current.outcome, "success");
    if (current.outcome !== "success") return;
    assert.equal(current.value.checkpointReference, "checkpoint://1");
    assert.equal(current.value.testSummary, "unit tests pending");
    const finished = transitionAttempt(current.value, "running", { type: "finish", result: "CODE_PUSHED", finalCommit: "def456", testSummary: "unit tests passed" }, t3);
    if (!finished.ok) throw new Error(finished.error.message);
    assert.equal(store.attempts.update(finished.value, "running").outcome, "success");
    const retryTask = transitionTask(first.value.task, "in_progress", { type: "fail", reason: "provider failed after push" }, t3);
    if (!retryTask.ok) throw new Error(retryTask.error.message);
    assert.equal(store.tasks.update(retryTask.value, { state: "in_progress", updatedAt: t1 }).outcome, "success");
    const retry = store.startAttempt(firstTask.id, { id: "attempt-2" as AttemptId, worker: "pirx", provider: "fake", branch: "task/1-retry" }, t3);
    assert.equal(retry.outcome, "success");
    const history = store.attempts.listByTask(firstTask.id);
    assert.equal(history.outcome, "success");
    if (history.outcome === "success") assert.deepEqual(history.value.map((attempt) => attempt.ordinal), [1, 2]);
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("requires CODE_PUSHED branch and commit, makes terminal completion idempotent, and rejects conflicts", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    const currentTask = task("attempt-task-2");
    assert.equal(store.tasks.create(currentTask).outcome, "success");
    const started = store.startAttempt(currentTask.id, { id: "attempt-3" as AttemptId, worker: "pirx", provider: "fake" }, t1);
    assert.equal(started.outcome, "success");
    if (started.outcome !== "success") return;
    const missingBranch = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", finalCommit: "abc" }, t2);
    assert.equal(missingBranch.ok, false);
    const finished = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch: "task/3", finalCommit: "abc", currentCommit: "abc", testSummary: "passed" }, t2);
    if (!finished.ok) throw new Error(finished.error.message);
    assert.equal(store.attempts.update(finished.value, "running").outcome, "success");
    assert.equal(store.attempts.update(finished.value, "terminal").outcome, "success");
    assert.equal(store.attempts.update({ ...finished.value, finalCommit: "different" }, "terminal").outcome, "conflict");
    assert.equal(store.attempts.update({ ...finished.value, taskId: "other-task" as TaskId }, "terminal").outcome, "conflict");
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("stores every terminal result and rolls back a failed atomic start", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    const results = ["BLOCKED", "FAILED", "QUOTA_EXHAUSTED", "CANCELLED", "UNKNOWN"] as const;
    for (const [index, result] of results.entries()) {
      const id = `attempt-task-result-${index}`;
      const currentTask = task(id);
      assert.equal(store.tasks.create(currentTask).outcome, "success");
      const started = store.startAttempt(id, { id: `attempt-result-${index}` as AttemptId, worker: "pirx", provider: "fake", branch: `task/result-${index}` }, t1);
      assert.equal(started.outcome, "success");
      if (started.outcome !== "success") continue;
      const finished = transitionAttempt(started.value.attempt, "running", { type: "finish", result, blockingReason: `terminal ${result}` }, t2);
      if (!finished.ok) throw new Error(finished.error.message);
      assert.equal(store.attempts.update(finished.value, "running").outcome, "success");
    }
    const rolledBackId = "attempt-task-rollback" as TaskId;
    const rolledBack = store.transaction(({ tasks }) => {
      const created = tasks.create(task(rolledBackId));
      if (created.outcome !== "success") return created;
      return { outcome: "storage_error" as const, message: "controlled rollback" };
    });
    assert.equal(rolledBack.outcome, "storage_error");
    assert.equal(store.tasks.get(rolledBackId).outcome, "not_found");
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
