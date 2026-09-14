import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTEMPT_RESULTS,
  TASK_TRANSITIONS,
  createTask,
  deserializeAttempt,
  deserializeTask,
  retryTask,
  serializeAttempt,
  serializeTask,
  startInitialAttempt,
  transitionAttempt,
  transitionTask,
  type AttemptId,
  type AttemptSnapshot,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const taskIdentifier = "task-runtime-1" as TaskId;
const attemptOne = "attempt-runtime-1" as AttemptId;
const attemptTwo = "attempt-runtime-2" as AttemptId;
const t0 = "2026-09-14T10:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T10:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-14T10:02:00.000Z" as UtcTimestamp;
const t3 = "2026-09-14T10:03:00.000Z" as UtcTimestamp;
const t4 = "2026-09-14T10:04:00.000Z" as UtcTimestamp;

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  const result = createTask({
    id: taskIdentifier,
    githubReference: { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 65 },
    goal: "Define runtime domain",
    scope: "Task and Attempt snapshots",
    acceptanceCriteria: ["validated transitions", "retry retains identity"],
    priority: 1,
    risk: "medium",
    requiredCapabilities: ["typescript"],
    createdAt: t0,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function start(): { task: TaskSnapshot; attempt: AttemptSnapshot } {
  const result = startInitialAttempt(task(), [], { id: attemptOne, worker: "pirx", provider: "test", branch: "task/1" }, t1);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test("validates immutable Task inputs, IDs, UTC timestamps, capabilities, and enums", () => {
  const value = task();
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.acceptanceCriteria), true);
  assert.equal(Object.isFrozen(value.githubReference), true);
  assert.equal(value.state, "ready");
  assert.equal(createTask({ ...value, goal: "  " }).ok, false);
  assert.equal(createTask({ ...value, requiredCapabilities: [] }).ok, false);
  assert.equal(createTask({ ...value, createdAt: "2026-09-14T10:00:00+01:00" as UtcTimestamp }).ok, false);
  assert.equal(createTask({ ...value, risk: "unknown" as "medium" }).ok, false);
  assert.equal(createTask({ ...value, id: "bad id" as TaskId }).ok, false);
});

test("starts exactly one initial Attempt and enforces the Task transition table", () => {
  const result = start();
  assert.equal(result.task.id, taskIdentifier);
  assert.equal(result.task.state, "in_progress");
  assert.equal(result.attempt.taskId, result.task.id);
  assert.equal(result.attempt.ordinal, 1);
  assert.equal(result.attempt.state, "running");
  assert.equal(Object.isFrozen(result.attempt), true);
  const second = startInitialAttempt(result.task, [result.attempt], { id: attemptTwo, worker: "pirx", provider: "test" }, t2);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "invalid_transition");
  assert.deepEqual(TASK_TRANSITIONS.ready, ["in_progress", "blocked", "cancelled"]);
});

test("finishes Attempts with explicit terminal results and required evidence", () => {
  const running = start().attempt;
  const missingCommit = transitionAttempt(running, "running", { type: "finish", result: "CODE_PUSHED" }, t2);
  assert.equal(missingCommit.ok, false);
  if (!missingCommit.ok) assert.equal(missingCommit.error.code, "invariant_violation");
  const pushed = transitionAttempt(running, "running", { type: "finish", result: "CODE_PUSHED", finalCommit: "abc123" }, t2);
  assert.equal(pushed.ok, true);
  if (!pushed.ok) return;
  assert.equal(pushed.value.state, "terminal");
  assert.equal(pushed.value.result, "CODE_PUSHED");
  assert.equal(pushed.value.endedAt, t2);
  assert.equal(Object.isFrozen(pushed.value), true);
  for (const result of ATTEMPT_RESULTS.filter((value) => value !== "CODE_PUSHED")) {
    const finished = transitionAttempt(running, "running", { type: "finish", result, blockingReason: "provider reported a terminal condition" }, t2);
    assert.equal(finished.ok, true, result);
  }
  assert.equal(transitionAttempt(running, "running", { type: "finish", result: "FAILED", blockingReason: "x" }, t0).ok, false);
});

test("requires explicit completion evidence and never completes from CODE_PUSHED automatically", () => {
  const running = start();
  const pushed = transitionAttempt(running.attempt, "running", { type: "finish", result: "CODE_PUSHED", finalCommit: "abc123" }, t2);
  assert.equal(pushed.ok, true);
  if (!pushed.ok) return;
  const missing = transitionTask(running.task, "in_progress", { type: "complete", evidence: { attemptId: attemptOne, finalCommit: "", evidenceReference: "" } }, t3);
  assert.equal(missing.ok, false);
  const completed = transitionTask(running.task, "in_progress", { type: "complete", evidence: { attemptId: attemptOne, finalCommit: "abc123", evidenceReference: "ci://attempt-runtime-1" } }, t3);
  assert.equal(completed.ok, true);
  if (completed.ok) {
    assert.equal(completed.value.state, "completed");
    assert.equal(completed.value.completionEvidence?.attemptId, attemptOne);
  }
  assert.equal(transitionTask(completed.ok ? completed.value : running.task, "completed", { type: "start" }, t4).ok, false);
});

test("retry creates the next Attempt for the same Task and rejects active or malformed histories", () => {
  const running = start();
  const failed = transitionAttempt(running.attempt, "running", { type: "finish", result: "FAILED", blockingReason: "provider failure" }, t2);
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  const taskFailed = transitionTask(running.task, "in_progress", { type: "fail", reason: "provider failure" }, t3);
  assert.equal(taskFailed.ok, true);
  if (!taskFailed.ok) return;
  const retry = retryTask(taskFailed.value, [failed.value], { id: attemptTwo, worker: "pirx", provider: "test" }, t4);
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.value.task.id, taskIdentifier);
  assert.equal(retry.value.task.state, "in_progress");
  assert.equal(retry.value.task.blockingReason, undefined);
  assert.equal(retry.value.attempt.taskId, taskIdentifier);
  assert.equal(retry.value.attempt.ordinal, 2);
  assert.equal(retryTask(taskFailed.value, [running.attempt], { id: attemptTwo, worker: "pirx", provider: "test" }, t4).ok, false);
  const outOfOrder = retryTask(taskFailed.value, [{ ...failed.value, ordinal: 3 }], { id: attemptTwo, worker: "pirx", provider: "test" }, t4);
  assert.equal(outOfOrder.ok, false);
  assert.equal(retryTask(task(), [], { id: attemptTwo, worker: "pirx", provider: "test" }, t1).ok, false);
});

test("serializes and validates Task and Attempt snapshots without accepting unknown stored values", () => {
  const running = start();
  const taskRoundTrip = deserializeTask(serializeTask(running.task));
  const attemptRoundTrip = deserializeAttempt(serializeAttempt(running.attempt));
  assert.deepEqual(taskRoundTrip, { ok: true, value: running.task });
  assert.deepEqual(attemptRoundTrip, { ok: true, value: running.attempt });
  const unknownTask = deserializeTask(JSON.stringify({ ...running.task, state: "future_state" }));
  assert.equal(unknownTask.ok, false);
  if (!unknownTask.ok) assert.equal(unknownTask.error.code, "invalid_enum");
  const unknownAttempt = deserializeAttempt(JSON.stringify({ ...running.attempt, schemaVersion: 99 }));
  assert.equal(unknownAttempt.ok, false);
  if (!unknownAttempt.ok) assert.equal(unknownAttempt.error.code, "serialization_error");
  assert.equal(deserializeTask("not-json").ok, false);
});
