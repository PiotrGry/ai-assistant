import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  RuntimeSqliteStore,
  createCheckpoint,
  createTask,
  type AttemptId,
  type Checkpoint,
  type CheckpointInput,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-14T18:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T18:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-14T18:02:00.000Z" as UtcTimestamp;
const t3 = "2026-09-14T18:03:00.000Z" as UtcTimestamp;

async function fixture(): Promise<{ readonly directory: string; readonly filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-checkpoint-persistence-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}

function task(id: string): TaskSnapshot {
  const result = createTask({ id: id as TaskId, goal: "Resume a task", scope: "Checkpoint persistence", acceptanceCriteria: ["durable checkpoint"], priority: 1, risk: "low", requiredCapabilities: ["worker"], createdAt: t0 });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function checkpoint(id: string, taskId: string, previousAttemptId: string, createdAt: UtcTimestamp = t1): CheckpointInput {
  return {
    id: id as CheckpointInput["id"],
    taskId: taskId as TaskId,
    previousAttemptId: previousAttemptId as AttemptId,
    trigger: "EXPLICIT_PAUSE",
    createdAt,
    goal: "Resume a task safely",
    currentState: "in_progress",
    completedWork: ["started"],
    remainingWork: ["continue"],
    changedFiles: ["src/runtime/task.ts"],
    findings: ["state is durable"],
    hypotheses: ["the next attempt can continue"],
    tests: [{ command: "pnpm test", result: "passed" }],
    evidence: [{ reference: `checkpoint://${id}`, summary: "checkpoint captured" }],
    lastAction: "paused",
    resumeInstruction: "continue the remaining work",
  };
}

function openWithAttempt(filename: string): { store: RuntimeSqliteStore; task: TaskSnapshot; attemptId: AttemptId } {
  const store = RuntimeSqliteStore.open({ filename });
  const currentTask = task("checkpoint-task-1");
  assert.equal(store.tasks.create(currentTask).outcome, "success");
  const started = store.startAttempt(currentTask.id, { id: "checkpoint-attempt-1" as AttemptId, worker: "pirx", provider: "test", branch: "task/checkpoint" }, t1);
  assert.equal(started.outcome, "success");
  return { store, task: currentTask, attemptId: "checkpoint-attempt-1" as AttemptId };
}

test("saves, replays, orders, queries, and persists Checkpoints across restart", async () => {
  const value = await fixture();
  const first = openWithAttempt(value.filename);
  const firstCheckpoint = createCheckpoint(checkpoint("checkpoint-2", first.task.id, first.attemptId, t2));
  const secondCheckpoint = createCheckpoint(checkpoint("checkpoint-1", first.task.id, first.attemptId, t2));
  assert.equal(firstCheckpoint.ok, true);
  assert.equal(secondCheckpoint.ok, true);
  if (!firstCheckpoint.ok || !secondCheckpoint.ok) return;
  try {
    const savedFirst = first.store.checkpoints.save(firstCheckpoint.value);
    assert.equal(savedFirst.outcome, "success");
    const savedSecond = first.store.checkpoints.save(secondCheckpoint.value);
    assert.equal(savedSecond.outcome, "success");
    const replay = first.store.checkpoints.save(firstCheckpoint.value);
    assert.equal(replay.outcome, "success");
    const history = first.store.checkpoints.listByTask(first.task.id);
    assert.equal(history.outcome, "success");
    if (history.outcome === "success") assert.deepEqual(history.value.map((item) => item.id), ["checkpoint-2", "checkpoint-1"]);
    const latest = first.store.checkpoints.latestByTask(first.task.id);
    assert.equal(latest.outcome, "success");
    if (latest.outcome === "success") assert.equal(latest.value.id, "checkpoint-1");
    first.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: value.filename });
    try {
      const restored = reopened.checkpoints.get("checkpoint-2");
      assert.deepEqual(restored, savedFirst);
      assert.equal(reopened.checkpoints.listByTask(first.task.id).outcome, "success");
    } finally {
      reopened.close();
    }
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("rejects duplicate conflicts, relationship violations, and empty history explicitly", async () => {
  const value = await fixture();
  const setup = openWithAttempt(value.filename);
  try {
    const canonical = createCheckpoint(checkpoint("checkpoint-conflict", setup.task.id, setup.attemptId));
    assert.equal(canonical.ok, true);
    if (!canonical.ok) return;
    assert.equal(setup.store.checkpoints.save(canonical.value).outcome, "success");
    const conflicting = setup.store.checkpoints.save({ ...canonical.value, goal: "different content" });
    assert.equal(conflicting.outcome, "conflict");
    const missingTask = createCheckpoint(checkpoint("checkpoint-missing-task", "missing-task", setup.attemptId));
    assert.equal(missingTask.ok, true);
    if (missingTask.ok) assert.equal(setup.store.checkpoints.save(missingTask.value).outcome, "not_found");
    const otherTask = task("checkpoint-task-2");
    assert.equal(setup.store.tasks.create(otherTask).outcome, "success");
    const otherStarted = setup.store.startAttempt(otherTask.id, { id: "checkpoint-attempt-2" as AttemptId, worker: "pirx", provider: "test" }, t2);
    assert.equal(otherStarted.outcome, "success");
    const wrongRelationship = createCheckpoint(checkpoint("checkpoint-wrong-attempt", setup.task.id, "checkpoint-attempt-2"));
    assert.equal(wrongRelationship.ok, true);
    if (wrongRelationship.ok) assert.equal(setup.store.checkpoints.save(wrongRelationship.value).outcome, "conflict");
    assert.equal(setup.store.checkpoints.latestByTask("task-without-checkpoint").outcome, "not_found");
    assert.deepEqual(setup.store.checkpoints.listByTask("task-without-checkpoint"), { outcome: "success", value: [] });
  } finally {
    setup.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("rolls back atomic checkpoint writes and detects malformed or tampered records", async () => {
  const value = await fixture();
  const setup = openWithAttempt(value.filename);
  try {
    const checkpointValue = createCheckpoint(checkpoint("checkpoint-rollback", setup.task.id, setup.attemptId, t3));
    assert.equal(checkpointValue.ok, true);
    if (!checkpointValue.ok) return;
    const rolledBack = setup.store.transaction(({ checkpoints }) => {
      const saved = checkpoints.save(checkpointValue.value);
      if (saved.outcome !== "success") return saved;
      return { outcome: "storage_error" as const, message: "controlled rollback" };
    });
    assert.equal(rolledBack.outcome, "storage_error");
    assert.equal(setup.store.checkpoints.get(checkpointValue.value.id).outcome, "not_found");

    assert.equal(setup.store.checkpoints.save(checkpointValue.value).outcome, "success");
    setup.store.database.prepare("UPDATE runtime_checkpoints SET content_hash = ? WHERE id = ?").run("0".repeat(64), checkpointValue.value.id);
    assert.equal(setup.store.checkpoints.get(checkpointValue.value.id).outcome, "invalid_record");
    setup.store.database.prepare("UPDATE runtime_checkpoints SET content_json = ? WHERE id = ?").run('{"kind":"checkpoint"}', checkpointValue.value.id);
    assert.equal(setup.store.checkpoints.listByTask(setup.task.id).outcome, "invalid_record");
  } finally {
    setup.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
