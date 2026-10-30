import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ResumeEscalationCoordinator,
  RuntimeSqliteStore,
  createTask,
  transitionAttempt,
  transitionTask,
  type AttemptId,
  type AttemptResult,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const times = [
  "2026-10-30T10:00:00.000Z" as UtcTimestamp,
  "2026-10-30T10:01:00.000Z" as UtcTimestamp,
  "2026-10-30T10:02:00.000Z" as UtcTimestamp,
  "2026-10-30T10:03:00.000Z" as UtcTimestamp,
  "2026-10-30T10:04:00.000Z" as UtcTimestamp,
  "2026-10-30T10:05:00.000Z" as UtcTimestamp,
] as const;

async function fixture(): Promise<{ readonly directory: string; readonly filename: string; readonly store: RuntimeSqliteStore; readonly task: TaskSnapshot }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-resume-escalation-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  const task = createTask({ id: "resume-escalation-task" as TaskId, goal: "Bound automatic resume", scope: "resume policy", acceptanceCriteria: ["human action after bound"], priority: 1, risk: "medium", requiredCapabilities: ["repository.write"], createdAt: times[0] });
  if (!task.ok) throw new Error(task.error.message);
  assert.equal(store.tasks.create(task.value).outcome, "success");
  return { directory, filename, store, task: task.value };
}

function recordFailure(store: RuntimeSqliteStore, taskId: TaskId, ordinal: number, result: Extract<AttemptResult, "FAILED" | "QUOTA_EXHAUSTED" | "UNKNOWN">): TaskSnapshot {
  const task = store.tasks.get(taskId);
  const history = store.attempts.listByTask(taskId);
  assert.equal(task.outcome, "success");
  assert.equal(history.outcome, "success");
  if (task.outcome !== "success" || history.outcome !== "success") throw new Error("fixture state unavailable");
  const predecessor = history.value[history.value.length - 1];
  const startedAt = times[Math.min(ordinal * 2 - 1, times.length - 1)]!;
  const endedAt = times[Math.min(ordinal * 2, times.length - 1)]!;
  const started = store.startAttempt(taskId, { id: `resume-escalation-attempt-${ordinal}` as AttemptId, worker: "pirx", provider: "test", ...(predecessor === undefined ? {} : { predecessorAttemptId: predecessor.id }), branch: "pirx/resume-escalation", worktree: "/tmp/pirx-resume-escalation", currentCommit: "a".repeat(40) }, startedAt);
  if (started.outcome !== "success") throw new Error("Attempt fixture could not start.");
  const terminal = transitionAttempt(started.value.attempt, "running", { type: "finish", result, blockingReason: `${result} during resume`, currentCommit: "a".repeat(40) }, endedAt);
  if (!terminal.ok) throw new Error("Attempt fixture could not finish.");
  assert.equal(store.attempts.update(terminal.value, "running").outcome, "success");
  const failed = transitionTask(started.value.task, "in_progress", { type: "fail", reason: `${result} during resume` }, endedAt);
  if (!failed.ok) throw new Error("Task fixture could not fail.");
  assert.equal(store.tasks.update(failed.value, { state: started.value.task.state, updatedAt: started.value.task.updatedAt }).outcome, "success");
  return failed.value;
}

test("tracks consecutive resume failures and escalates exactly at the configured bound", async () => {
  const value = await fixture();
  try {
    recordFailure(value.store, value.task.id, 1, "FAILED");
    recordFailure(value.store, value.task.id, 2, "QUOTA_EXHAUSTED");
    const coordinator = new ResumeEscalationCoordinator(value.store, { maximumConsecutiveFailures: 2 });
    const before = coordinator.evaluate(value.task.id, times[4]);
    assert.equal(before.outcome, "no_action");
    if (before.outcome === "no_action") assert.equal(before.consecutiveResumeFailures, 1);
    recordFailure(value.store, value.task.id, 3, "FAILED");
    const escalated = coordinator.evaluate(value.task.id, times[5]);
    assert.equal(escalated.outcome, "escalated", JSON.stringify(escalated));
    if (escalated.outcome !== "escalated") return;
    assert.equal(escalated.reason, "RESUME_FAILURE_LIMIT_REACHED");
    assert.equal(escalated.evidence.consecutiveResumeFailures, 2);
    assert.deepEqual(escalated.evidence.attemptIds, ["resume-escalation-attempt-2", "resume-escalation-attempt-3"]);
    const task = value.store.tasks.get(value.task.id);
    assert.equal(task.outcome, "success");
    if (task.outcome === "success") {
      assert.equal(task.value.state, "blocked");
      assert.match(task.value.blockingReason ?? "", /Human action required/u);
    }
    const checkpoint = value.store.checkpoints.get(escalated.checkpointId);
    assert.equal(checkpoint.outcome, "success");
    if (checkpoint.outcome === "success") {
      assert.equal(checkpoint.value.currentState, "blocked");
      assert.equal(checkpoint.value.evidence.length, 2);
      assert.equal(checkpoint.value.previousAttemptId, "resume-escalation-attempt-3");
    }
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("escalates an ambiguous provider result immediately and replays after restart", async () => {
  const value = await fixture();
  try {
    recordFailure(value.store, value.task.id, 1, "UNKNOWN");
    const coordinator = new ResumeEscalationCoordinator(value.store, { maximumConsecutiveFailures: 3 });
    const escalated = coordinator.evaluate(value.task.id, times[3]);
    assert.equal(escalated.outcome, "escalated", JSON.stringify(escalated));
    if (escalated.outcome !== "escalated") return;
    assert.equal(escalated.reason, "AMBIGUOUS_PROVIDER_STATE");
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: value.filename });
    try {
      const replay = new ResumeEscalationCoordinator(reopened, { maximumConsecutiveFailures: 3 }).evaluate(value.task.id, times[4]);
      assert.equal(replay.outcome, "replayed");
      if (replay.outcome === "replayed") assert.equal(replay.checkpointId, escalated.checkpointId);
      const history = reopened.checkpoints.listByTask(value.task.id);
      assert.equal(history.outcome, "success");
      if (history.outcome === "success") assert.equal(history.value.length, 1);
    } finally { reopened.close(); }
  } finally {
    try { value.store.close(); } catch { /* reopened fixture already closed it */ }
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("rejects unsafe retry limits", async () => {
  const value = await fixture();
  try {
    assert.throws(() => new ResumeEscalationCoordinator(value.store, { maximumConsecutiveFailures: 0 }), /failure limit/u);
    assert.throws(() => new ResumeEscalationCoordinator(value.store, { maximumConsecutiveFailures: 21 }), /failure limit/u);
  } finally {
    value.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
