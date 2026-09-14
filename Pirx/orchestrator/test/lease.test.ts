import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  RuntimeSqliteStore,
  createTask,
  leaseId,
  type AttemptId,
  type LeaseId,
  type LeaseRecord,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-14T12:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T12:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-14T12:02:00.000Z" as UtcTimestamp;
const t3 = "2026-09-14T12:03:00.000Z" as UtcTimestamp;
const taskOne = "lease-task-1" as TaskId;
const taskTwo = "lease-task-2" as TaskId;

function task(id: TaskId, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  const result = createTask({
    id,
    goal: "Lease runtime task",
    scope: "SQLite lease tests",
    acceptanceCriteria: ["exclusive ownership"],
    priority: 1,
    risk: "low",
    requiredCapabilities: ["sqlite"],
    createdAt: t0,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function fixture(): Promise<{ directory: string; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-lease-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}

function id(value: string): LeaseId {
  return leaseId(value);
}

function owned(lease: LeaseRecord): { id: string; token: string; version: number } {
  return { id: lease.id, token: lease.ownershipToken, version: lease.version };
}

test("acquires durable leases with task/global exclusivity and restart persistence", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    assert.equal(store.tasks.create(task(taskOne)).outcome, "success");
    assert.equal(store.tasks.create(task(taskTwo)).outcome, "success");
    const acquired = store.leases.acquire({ id: id("lease-1"), taskId: taskOne, workerId: "pirx", now: t1, durationMs: 60_000 });
    assert.equal(acquired.outcome, "success");
    if (acquired.outcome !== "success") return;
    assert.equal(acquired.value.state, "active");
    assert.equal(acquired.value.version, 1);
    assert.equal(store.leases.getActiveByTask(taskOne).outcome, "success");
    assert.equal(store.leases.getActiveByWorker("pirx").outcome, "success");
    assert.equal(store.leases.acquire({ id: id("lease-2"), taskId: taskOne, workerId: "other", now: t1, durationMs: 60_000 }).outcome, "conflict");
    assert.equal(store.leases.acquire({ id: id("lease-3"), taskId: taskTwo, workerId: "other", now: t1, durationMs: 60_000 }).outcome, "conflict");
  } finally {
    store.close();
  }
  const reopened = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    const stored = reopened.leases.get(id("lease-1"));
    assert.equal(stored.outcome, "success");
    if (stored.outcome === "success") assert.equal(stored.value.ownershipToken.length > 0, true);
  } finally {
    reopened.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("renews and releases with token/version CAS and treats exact expiry as expired", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    assert.equal(store.tasks.create(task(taskOne)).outcome, "success");
    const acquired = store.leases.acquire({ id: id("lease-cas"), taskId: taskOne, workerId: "pirx", now: t1, durationMs: 60_000 });
    if (acquired.outcome !== "success") throw new Error(acquired.message);
    const first = owned(acquired.value);
    const renewed = store.leases.renew(first.id, first.token, first.version, t1, 120_000);
    assert.equal(renewed.outcome, "success");
    if (renewed.outcome !== "success") return;
    assert.equal(renewed.value.version, 2);
    assert.equal(store.leases.renew(first.id, first.token, first.version, t2, 60_000).outcome, "conflict");
    assert.equal(store.leases.renew(first.id, first.token, renewed.value.version, t3, 60_000).outcome, "conflict");
    const extended = store.leases.renew(first.id, first.token, renewed.value.version, "2026-09-14T12:02:59.000Z" as UtcTimestamp, 60_000);
    assert.equal(extended.outcome, "success");
    if (extended.outcome !== "success") return;
    const current = store.leases.get(id("lease-cas"));
    if (current.outcome !== "success") throw new Error(current.message);
    assert.equal(store.leases.release(first.id, "stale-token", current.value.version, t2).outcome, "conflict");
    const released = store.leases.release(first.id, first.token, current.value.version, t3);
    assert.equal(released.outcome, "success");
    if (released.outcome === "success") assert.equal(released.value.state, "released");
    assert.equal(store.leases.getActiveByTask(taskOne).outcome, "not_found");
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("attaches only a matching running Attempt and rejects wrong or stale ownership", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    assert.equal(store.tasks.create(task(taskOne)).outcome, "success");
    assert.equal(store.tasks.create(task(taskTwo)).outcome, "success");
    const lease = store.leases.acquire({ id: id("lease-attach"), taskId: taskOne, workerId: "pirx", now: t1, durationMs: 60_000 });
    if (lease.outcome !== "success") throw new Error(lease.message);
    const started = store.startAttempt(taskOne, { id: "lease-attempt-1" as AttemptId, worker: "pirx", provider: "test" }, t1);
    if (started.outcome !== "success") throw new Error(started.message);
    const current = owned(lease.value);
    const wrongTaskAttempt = store.startAttempt(taskTwo, { id: "lease-attempt-2" as AttemptId, worker: "pirx", provider: "test" }, t1);
    if (wrongTaskAttempt.outcome !== "success") throw new Error(wrongTaskAttempt.message);
    assert.equal(store.leases.attachAttempt(current.id, current.token, current.version, "lease-attempt-2", t1).outcome, "conflict");
    const attached = store.leases.attachAttempt(current.id, current.token, current.version, "lease-attempt-1", t1);
    assert.equal(attached.outcome, "success");
    if (attached.outcome === "success") assert.equal(attached.value.attemptId, "lease-attempt-1");
    assert.equal(store.leases.attachAttempt(current.id, current.token, current.version, "lease-attempt-1", t1).outcome, "conflict");
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("requires explicit recovery for expired and uncertain leases before reacquisition", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    assert.equal(store.tasks.create(task(taskOne)).outcome, "success");
    const expired = store.leases.acquire({ id: id("lease-expired"), taskId: taskOne, workerId: "pirx", now: t1, durationMs: 1_000 });
    if (expired.outcome !== "success") throw new Error(expired.message);
    const first = owned(expired.value);
    assert.equal(store.leases.listRecoverable("2026-09-14T12:01:01.000Z" as UtcTimestamp).outcome, "success");
    assert.equal(store.leases.renew(first.id, first.token, first.version, "2026-09-14T12:01:01.000Z" as UtcTimestamp, 1_000).outcome, "conflict");
    const recovered = store.leases.recover(first.id, first.token, first.version, "2026-09-14T12:01:01.000Z" as UtcTimestamp);
    assert.equal(recovered.outcome, "success");
    if (recovered.outcome !== "success") return;
    assert.equal(recovered.value.state, "recovered");
    assert.equal(recovered.value.recoveryReason, "expired");
    const reacquired = store.leases.acquire({ id: id("lease-reacquired"), taskId: taskOne, workerId: "pirx", now: t2, durationMs: 60_000 });
    assert.equal(reacquired.outcome, "success");
    if (reacquired.outcome !== "success") return;
    const uncertain = owned(reacquired.value);
    const marked = store.leases.markUncertain(uncertain.id, uncertain.token, uncertain.version, t2);
    assert.equal(marked.outcome, "success");
    if (marked.outcome !== "success") return;
    assert.equal(marked.value.state, "uncertain");
    const recoveredUncertain = store.leases.recover(uncertain.id, uncertain.token, marked.value.version, t3);
    assert.equal(recoveredUncertain.outcome, "success");
    if (recoveredUncertain.outcome === "success") assert.equal(recoveredUncertain.value.recoveryReason, "uncertain");
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("transaction rollback leaves no partially acquired ownership", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    assert.equal(store.tasks.create(task(taskOne)).outcome, "success");
    const result = store.transaction(({ leases }) => {
      const acquired = leases.acquire({ id: id("lease-rollback"), taskId: taskOne, workerId: "pirx", now: t1, durationMs: 60_000 });
      if (acquired.outcome !== "success") return acquired;
      return { outcome: "conflict" as const, message: "rollback test" };
    });
    assert.equal(result.outcome, "conflict");
    assert.equal(store.leases.get(id("lease-rollback")).outcome, "not_found");
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});
