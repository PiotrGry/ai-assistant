import assert from "node:assert/strict";
import { backup, DatabaseSync } from "node:sqlite";
import { link, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { backupRuntimeBeforeMigration } from "../src/runtime/sqlite.js";

import {
  RuntimeSqliteStore,
  RUNTIME_STORAGE_SCHEMA_VERSION,
  createTask,
  createCheckpoint,
  createWorkerFailureDiagnostic,
  OrchestratorControlRepository,
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
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pirx-runtime-storage-test-")));
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
    const started = startInitialAttempt(makeTask(), [], { id: attemptId, worker: "pirx", provider: "test", branch: "task/storage" }, t1);
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

test("persists reasoned terminal Tasks and rejects completion not backed by a stored CODE_PUSHED Attempt", async () => {
  const fixture = await databaseFixture();
  const store = RuntimeSqliteStore.open({ filename: fixture.filename });
  try {
    const cancelledId = "task-storage-cancelled" as TaskId;
    assert.equal(store.tasks.create(makeTask({ id: cancelledId })).outcome, "success");
    const cancelled = transitionTask(makeTask({ id: cancelledId }), "ready", { type: "cancel", reason: "dropped from queue" }, t1);
    if (!cancelled.ok) throw new Error(cancelled.error.message);
    assert.equal(store.tasks.update(cancelled.value, { state: "ready", updatedAt: t0 }).outcome, "success");
    assert.equal(store.tasks.get(cancelledId).outcome, "success");

    assert.equal(store.tasks.create(makeTask()).outcome, "success");
    const started = startInitialAttempt(makeTask(), [], { id: attemptId, worker: "pirx", provider: "test", branch: "task/storage" }, t1);
    if (!started.ok) throw new Error(started.error.message);
    assert.equal(store.tasks.update(started.value.task, { state: "ready", updatedAt: t0 }).outcome, "success");
    assert.equal(store.attempts.create(started.value.attempt).outcome, "success");
    const completedWith = (finalCommit: string) => makeTask({ state: "completed", updatedAt: t2, completionEvidence: { attemptId, finalCommit, evidenceReference: "ci://storage" } });
    const inProgress = { state: "in_progress" as const, updatedAt: t1 };
    assert.equal(store.tasks.update(completedWith("abc123"), inProgress).outcome, "conflict", "Attempt is still running");

    const pushed = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", finalCommit: "abc123" }, t2);
    if (!pushed.ok) throw new Error(pushed.error.message);
    assert.equal(store.attempts.update(pushed.value, "running").outcome, "success");
    assert.equal(store.tasks.update(completedWith("fake"), inProgress).outcome, "conflict", "commit mismatch");
    assert.equal(store.tasks.create(makeTask({ id: "task-storage-forged" as TaskId, state: "completed", completionEvidence: { attemptId, finalCommit: "abc123", evidenceReference: "ci://forged" } })).outcome, "conflict", "Attempt of another Task");
    assert.equal(store.tasks.update(completedWith("abc123"), inProgress).outcome, "success");
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

test("requires a runtime path and rejects conflicting paths and aliases to chat SQLite before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-runtime-path-"));
  const chat = join(directory, "chat.sqlite");
  const runtime = join(directory, "runtime.sqlite");
  const alias = join(directory, "alias.sqlite");
  const environment = { PIRX_STORAGE_FILE: chat, PIRX_ORCHESTRATOR_DATABASE: runtime };
  try {
    const chatBytes = Buffer.from("existing chat database fixture");
    await writeFile(chat, chatBytes);
    await link(chat, alias);
    assert.throws(() => RuntimeSqliteStore.open({ environment: { PIRX_STORAGE_FILE: chat } }), /explicit runtime SQLite path/u);
    assert.throws(() => RuntimeSqliteStore.open({ filename: alias, environment }), /conflicts/u);
    assert.throws(() => RuntimeSqliteStore.open({ environment: { ...environment, PIRX_ORCHESTRATOR_DATABASE: alias } }), /identifies the Pirx chat database/u);
    const daemon = RuntimeSqliteStore.open({ filename: runtime, environment });
    const shipment = RuntimeSqliteStore.open({ environment });
    assert.equal(daemon.filename, shipment.filename);
    daemon.close();
    shipment.close();
    assert.deepEqual(await readFile(chat), chatBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("existing runtime open rejects incompatible schema before changing the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-runtime-no-migration-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  try {
    store.database.prepare("UPDATE runtime_schema_migrations SET version = ? WHERE version = ?").run(RUNTIME_STORAGE_SCHEMA_VERSION + 1, RUNTIME_STORAGE_SCHEMA_VERSION);
    assert.throws(() => RuntimeSqliteStore.open({ filename, mode: "existing" }), /Incompatible SQLite runtime schema/u);
    assert.throws(() => RuntimeSqliteStore.open({ filename, mode: "read_only" }), /Incompatible SQLite runtime schema/u);
    assert.equal(store.database.prepare("SELECT version FROM runtime_schema_migrations WHERE version = ?").get(RUNTIME_STORAGE_SCHEMA_VERSION), undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("pre-migration backup captures committed WAL data and restores it to a separate runtime", async () => {
  const fixture = await databaseFixture();
  const store = RuntimeSqliteStore.open({ filename: fixture.filename });
  try {
    assert.equal(store.tasks.create(makeTask()).outcome, "success");
    const started = store.startAttempt(taskId, { id: attemptId, worker: "pirx", provider: "test" }, t1);
    if (started.outcome !== "success") throw new Error("Attempt fixture failed");
    const terminal = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "FAILED", blockingReason: "reconciliation required", diagnostic: createWorkerFailureDiagnostic("timeout") }, t2);
    if (!terminal.ok) throw new Error("Terminal fixture failed");
    assert.equal(store.attempts.update(terminal.value, "running").outcome, "success");
    const blocked = transitionTask(started.value.task, "in_progress", { type: "block", reason: "reconciliation required" }, t2);
    if (!blocked.ok) throw new Error("Task fixture failed");
    assert.equal(store.tasks.update(blocked.value, { state: "in_progress", updatedAt: started.value.task.updatedAt }).outcome, "success");
    const checkpoint = createCheckpoint({ id: "backup-checkpoint" as never, taskId, previousAttemptId: attemptId, trigger: "RECOVERABLE_FAILURE", createdAt: t2, goal: makeTask().goal, currentState: "blocked", completedWork: [], remainingWork: ["verify remote state"], changedFiles: [], findings: [], hypotheses: [], tests: [], evidence: [], lastAction: "push returned no result", resumeInstruction: "reconcile before retry" });
    if (!checkpoint.ok) throw new Error(JSON.stringify(checkpoint.violations));
    assert.equal(store.checkpoints.save(checkpoint.value).outcome, "success");
    const control = new OrchestratorControlRepository(store);
    const entry = control.recordDiagnostic({ schemaVersion: 1, event: "cycle", outcome: "failed", reason: "reconciliation required" }, t2);
    if (entry.outcome !== "success") throw new Error(entry.message);
    const saved = await backupRuntimeBeforeMigration(fixture.filename, {});
    assert.ok(saved);
    const restoredPath = join(fixture.directory, "restored.sqlite");
    const source = new DatabaseSync(saved, { readOnly: true });
    try { await backup(source, restoredPath); } finally { source.close(); }
    const restored = RuntimeSqliteStore.open({ filename: restoredPath, mode: "existing" });
    try {
      assert.deepEqual(restored.tasks.get(taskId), store.tasks.get(taskId));
      assert.deepEqual(restored.attempts.get(attemptId), store.attempts.get(attemptId));
      assert.equal(restored.database.prepare("SELECT id FROM runtime_checkpoints WHERE id = ?").get(checkpoint.value.id)?.id, checkpoint.value.id);
      assert.deepEqual(new OrchestratorControlRepository(restored).diagnostic(entry.value), control.diagnostic(entry.value));
      assert.equal(restored.selection.select({ evaluatedAt: t2, worker: { workerId: "pirx", capabilities: ["repository.read"] } }).outcome, "no_runnable_task");
      assert.deepEqual(restored.database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { restored.close(); }
  } finally { store.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("pre-migration backup rejects a corrupt source without replacing it", async () => {
  const fixture = await databaseFixture();
  try {
    await writeFile(fixture.filename, "invalid SQLite");
    await assert.rejects(backupRuntimeBeforeMigration(fixture.filename, {}), /migration was not started/u);
    assert.equal(await readFile(fixture.filename, "utf8"), "invalid SQLite");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
