import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  RuntimeSqliteStore,
  createTask,
  startInitialAttempt,
  transitionTask,
  transitionAttempt,
  type AttemptId,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const taskId = "task-storage-1" as TaskId;
const attemptId = "attempt-storage-1" as AttemptId;
const secondAttemptId = "attempt-storage-2" as AttemptId;
const t0 = "2026-09-14T12:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T12:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-14T12:02:00.000Z" as UtcTimestamp;

function makeTask(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  const result = createTask({
    id: taskId,
    goal: "Persist runtime state",
    scope: "SQLite repository",
    acceptanceCriteria: ["durable"],
    priority: 1,
    risk: "low",
    requiredCapabilities: ["sqlite"],
    createdAt: t0,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function databaseFixture(): Promise<{ directory: string; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-runtime-storage-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}

test("bootstraps versioned WAL storage, repositories, restart durability, and close", async () => {
  const fixture = await databaseFixture();
  const store = RuntimeSqliteStore.open({ filename: fixture.filename });
  try {
    assert.equal(store.filename, fixture.filename);
    const created = store.tasks.create(makeTask());
    assert.equal(created.outcome, "success");
    assert.equal(store.tasks.get(taskId).outcome, "success");
    assert.equal(store.tasks.list().outcome, "success");
    const started = startInitialAttempt(makeTask(), [], { id: attemptId, worker: "pirx", provider: "test" }, t1);
    if (!started.ok) throw new Error(started.error.message);
    assert.equal(store.attempts.create(started.value.attempt).outcome, "success");
    assert.equal(store.attempts.get(attemptId).outcome, "success");
    assert.equal(store.attempts.listByTask(taskId).outcome, "success");
  } finally {
    store.close();
  }
  const reopened = RuntimeSqliteStore.open({ filename: fixture.filename });
  try {
    const taskResult = reopened.tasks.get(taskId);
    assert.equal(taskResult.outcome, "success");
    const attempts = reopened.attempts.listByTask(taskId);
    assert.equal(attempts.outcome, "success");
    if (attempts.outcome === "success") assert.equal(attempts.value.length, 1);
  } finally {
    reopened.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("transaction boundary commits related Task/Attempt writes or rolls them back", async () => {
  const fixture = await databaseFixture();
  const store = RuntimeSqliteStore.open({ filename: fixture.filename });
  try {
    const committed = store.transaction(({ tasks, attempts }) => {
      const created = tasks.create(makeTask());
      if (created.outcome !== "success") return created;
      const started = startInitialAttempt(created.value, [], { id: attemptId, worker: "pirx", provider: "test" }, t1);
      if (!started.ok) return { outcome: "storage_error" as const, message: "test setup failed" };
      const taskUpdate = tasks.update(started.value.task, { state: "ready", updatedAt: t0 });
      if (taskUpdate.outcome !== "success") return taskUpdate;
      return attempts.create(started.value.attempt);
    });
    assert.equal(committed.outcome, "success");
    assert.equal(store.attempts.get(attemptId).outcome, "success");

    const rolledBack = store.transaction(({ tasks }) => {
      const duplicate = tasks.create(makeTask({ id: "task-storage-2" as TaskId }));
      if (duplicate.outcome !== "success") return duplicate;
      return { outcome: "storage_error" as const, message: "controlled rollback" };
    });
    assert.equal(rolledBack.outcome, "storage_error");
    assert.equal(store.tasks.get("task-storage-2").outcome, "not_found");
  } finally {
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("enforces foreign keys, duplicate identity, one active Attempt, and compare-and-set", async () => {
  const fixture = await databaseFixture();
  const store = RuntimeSqliteStore.open({ filename: fixture.filename });
  try {
    const created = makeTask();
    assert.equal(store.tasks.create(created).outcome, "success");
    assert.equal(store.tasks.create(created).outcome, "conflict");
    const orphan = startInitialAttempt({ ...created, state: "ready" }, [], { id: "orphan-attempt" as AttemptId, worker: "pirx", provider: "test" }, t1);
    if (!orphan.ok) throw new Error(orphan.error.message);
    const orphanAttempt = { ...orphan.value.attempt, taskId: "missing-task" as TaskId, id: "orphan-attempt-2" as AttemptId };
    assert.equal(store.attempts.create(orphanAttempt).outcome, "conflict");

    const first = startInitialAttempt(created, [], { id: attemptId, worker: "pirx", provider: "test" }, t1);
    if (!first.ok) throw new Error(first.error.message);
    assert.equal(store.attempts.create(first.value.attempt).outcome, "success");
    const second = { ...first.value.attempt, id: secondAttemptId };
    assert.equal(store.attempts.create(second).outcome, "conflict");

    const transitioned = transitionTask(created, "ready", { type: "start" }, t1);
    if (!transitioned.ok) throw new Error(transitioned.error.message);
    const cas = store.tasks.update(transitioned.value, { state: "ready", updatedAt: t0 });
    assert.equal(cas.outcome, "success");
    assert.equal(store.tasks.update(transitioned.value, { state: "ready", updatedAt: t0 }).outcome, "conflict");
    assert.equal(store.tasks.get("missing-task").outcome, "not_found");
  } finally {
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("maps malformed stored data and locked writers to typed outcomes", async () => {
  const fixture = await databaseFixture();
  const store = RuntimeSqliteStore.open({ filename: fixture.filename, busyTimeoutMs: 20 });
  try {
    assert.equal(store.tasks.create(makeTask()).outcome, "success");
    const raw = new DatabaseSync(fixture.filename);
    raw.prepare("UPDATE runtime_tasks SET acceptance_criteria_json = '{}' WHERE id = ?").run(taskId);
    raw.close();
    assert.equal(store.tasks.get(taskId).outcome, "invalid_record");

    const locker = new DatabaseSync(fixture.filename);
    locker.exec("BEGIN IMMEDIATE");
    const blocked = store.tasks.create(makeTask({ id: "locked-task" as TaskId }));
    assert.equal(blocked.outcome, "storage_error");
    locker.exec("ROLLBACK");
    locker.close();
  } finally {
    store.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("migration failure rolls back without advancing the runtime schema", async () => {
  const fixture = await databaseFixture();
  const raw = new DatabaseSync(fixture.filename);
  raw.exec("CREATE TABLE runtime_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  raw.prepare("INSERT INTO runtime_schema_migrations (version, applied_at) VALUES (1, '2026-09-14T12:00:00.000Z')").run();
  raw.close();
  assert.throws(() => RuntimeSqliteStore.open({ filename: fixture.filename }), /could not be opened or migrated|runtime schema/i);
  const check = new DatabaseSync(fixture.filename);
  try {
    const row = check.prepare("SELECT MAX(version) AS version FROM runtime_schema_migrations").get() as { version: number };
    assert.equal(row.version, 1);
  } finally {
    check.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
