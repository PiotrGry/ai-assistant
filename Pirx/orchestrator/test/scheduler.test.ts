import assert from "node:assert/strict";
import test from "node:test";

import {
  SingleWorkerScheduler,
  createTask,
  leaseId,
  type AttemptId,
  type LeaseOwnershipToken,
  type LeaseRecord,
  type RunnableTaskCandidate,
  type SchedulerAttemptPort,
  type SchedulerCapabilityPort,
  type SchedulerExecutionPort,
  type SchedulerLeasePort,
  type SchedulerPersistencePort,
  type SchedulerPortResult,
  type SchedulerRecoveryPort,
  type SchedulerSelectionPort,
  type SchedulerWorkerPort,
  type TaskId,
  type TaskSelectionResult,
  type UtcTimestamp,
  type WorkerExecutionResult,
} from "../src/index.js";

const now = "2026-09-14T12:00:00.000Z" as UtcTimestamp;
const taskId = "scheduler-task-1" as TaskId;
const attemptId = "scheduler-attempt-1" as AttemptId;
const result = <T>(value: T): SchedulerPortResult<T> => ({ outcome: "success", value });
const candidate: RunnableTaskCandidate = (() => {
  const task = createTask({ id: taskId, goal: "Run one cycle", scope: "scheduler", acceptanceCriteria: ["durable"], priority: 1, risk: "low", requiredCapabilities: ["tests.run"], createdAt: now });
  if (!task.ok) throw new Error(task.error.message);
  return { task: task.value, explanation: { taskId, eligible: true, reasonCode: "ELIGIBLE", priority: 1, queueOrder: 1, missingCapabilities: [], blockers: [] } };
})();
const selected: TaskSelectionResult = { outcome: "selected", candidate, explanations: [candidate.explanation] };

function lease(version = 1): LeaseRecord {
  return {
    id: leaseId("scheduler-lease-1"),
    taskId,
    workerId: "pirx",
    acquiredAt: now,
    renewedAt: now,
    expiresAt: "2026-09-14T12:05:00.000Z" as UtcTimestamp,
    state: "active",
    ownershipToken: "scheduler-token" as LeaseOwnershipToken,
    version,
  };
}

class Fakes {
  selectionResult: TaskSelectionResult = selected;
  availability: "available" | "unavailable" | "unknown" = "available";
  authorization: SchedulerPortResult<void> = result(undefined);
  acquireResult: SchedulerPortResult<LeaseRecord> = result(lease());
  attemptResult: SchedulerPortResult<{ readonly attemptId: AttemptId }> = result({ attemptId });
  persistenceResult: SchedulerPortResult<{ readonly checkpointRecorded: boolean }> = result({ checkpointRecorded: true });
  recoveryResult: SchedulerPortResult<{ readonly recovered: number }> = result({ recovered: 0 });
  executionResult: WorkerExecutionResult = { outcome: "success", summary: "done" };
  releaseResult: SchedulerPortResult<LeaseRecord> = result(lease(3));
  attachResult: SchedulerPortResult<LeaseRecord> = result(lease(2));
  uncertainResult: SchedulerPortResult<LeaseRecord> = result({ ...lease(2), state: "uncertain" });
  events: string[] = [];
  invocations = 0;
  persistenceInputs: Array<{ interrupted: boolean; execution: WorkerExecutionResult }> = [];
  invocation?: (signal: AbortSignal) => Promise<WorkerExecutionResult>;

  readonly selection: SchedulerSelectionPort = { select: () => { this.events.push("select"); return this.selectionResult; } };
  readonly worker: SchedulerWorkerPort = { check: () => { this.events.push("worker"); return result(this.availability); } };
  readonly capability: SchedulerCapabilityPort = { authorize: async () => { this.events.push("authorize"); return this.authorization; } };
  readonly leases: SchedulerLeasePort = {
    acquire: async () => { this.events.push("acquire"); return this.acquireResult; },
    attachAttempt: async (value) => { this.events.push(`attach:${value.id}`); return this.attachResult; },
    release: async () => { this.events.push("release"); return this.releaseResult; },
    markUncertain: async () => { this.events.push("uncertain"); return this.uncertainResult; },
  };
  readonly attempts: SchedulerAttemptPort = { start: async () => { this.events.push("attempt"); return this.attemptResult; } };
  readonly persistence: SchedulerPersistencePort = { persist: async (input) => { this.events.push("persist"); this.persistenceInputs.push(input); return this.persistenceResult; } };
  readonly recovery: SchedulerRecoveryPort = { reconcile: async () => { this.events.push("recover"); return this.recoveryResult; } };
  readonly execution: SchedulerExecutionPort = { invoke: async ({ signal }) => { this.events.push("invoke"); this.invocations += 1; return this.invocation === undefined ? this.executionResult : this.invocation(signal); } };
}

function scheduler(fakes: Fakes): SingleWorkerScheduler {
  return new SingleWorkerScheduler({
    workerId: "pirx",
    workerCapabilities: ["tests.run"],
    leaseDurationMs: 60_000,
    leaseIdFactory: () => leaseId("scheduler-lease-1"),
    attemptPort: fakes.attempts,
    capabilityPort: fakes.capability,
    clock: { now: () => now },
    executionPort: fakes.execution,
    leasePort: fakes.leases,
    persistencePort: fakes.persistence,
    recoveryPort: fakes.recovery,
    selectionPort: fakes.selection,
    workerPort: fakes.worker,
    shutdownTimeoutMs: 100,
  });
}

test("runs one deterministic select-authorize-Lease-Attempt-invoke-persist-release cycle", async () => {
  const fakes = new Fakes();
  const resultValue = await scheduler(fakes).cycle();
  assert.equal(resultValue.outcome, "started");
  assert.deepEqual(fakes.events, ["recover", "select", "worker", "authorize", "acquire", "attempt", "attach:scheduler-lease-1", "invoke", "persist", "release"]);
  assert.equal(fakes.invocations, 1);
  assert.equal(fakes.persistenceInputs[0]?.interrupted, false);
});

test("returns explicit idle, deferred, blocked, and reconciliation outcomes before mutation", async () => {
  const idleFakes = new Fakes();
  idleFakes.selectionResult = { outcome: "no_runnable_task", explanations: [] };
  assert.deepEqual(await scheduler(idleFakes).cycle(), { outcome: "idle", reason: "no_runnable_task" });
  assert.equal(idleFakes.invocations, 0);

  const unavailable = new Fakes();
  unavailable.availability = "unavailable";
  assert.deepEqual(await scheduler(unavailable).cycle(), { outcome: "deferred", reason: "worker_unavailable" });
  assert.equal(unavailable.events.includes("acquire"), false);

  const denied = new Fakes();
  denied.authorization = { outcome: "failed", reason: "missing capability" };
  const blocked = await scheduler(denied).cycle();
  assert.equal(blocked.outcome, "blocked");
  assert.equal(denied.invocations, 0);
  assert.equal(denied.events.includes("acquire"), false);

  const inconsistent = new Fakes();
  inconsistent.selectionResult = { outcome: "reconciliation_required", reasons: ["duplicate_queue_order"], explanations: [] };
  assert.deepEqual(await scheduler(inconsistent).cycle(), { outcome: "reconciliation_required", reason: "duplicate_queue_order" });
  assert.equal(inconsistent.events.includes("acquire"), false);
});

test("never invokes without durable Lease and Attempt, and marks ownership uncertain on pre-invocation failure", async () => {
  const leaseRace = new Fakes();
  leaseRace.acquireResult = { outcome: "conflict", reason: "global slot" };
  assert.deepEqual(await scheduler(leaseRace).cycle(), { outcome: "deferred", reason: "lease_occupied" });
  assert.equal(leaseRace.invocations, 0);

  const attemptFailure = new Fakes();
  attemptFailure.attemptResult = { outcome: "failed", reason: "attempt transaction" };
  const failed = await scheduler(attemptFailure).cycle();
  assert.equal(failed.outcome, "failed");
  assert.equal(attemptFailure.invocations, 0);
  assert.equal(attemptFailure.events.includes("uncertain"), true);

  const attachFailure = new Fakes();
  attachFailure.attachResult = { outcome: "conflict", reason: "lease CAS" };
  const attach = await scheduler(attachFailure).cycle();
  assert.equal(attach.outcome, "failed");
  assert.equal(attachFailure.invocations, 0);
  assert.equal(attachFailure.events.includes("uncertain"), true);
});

test("persists thrown/failed execution results and exposes release or persistence failures", async () => {
  const thrown = new Fakes();
  thrown.invocation = async () => { throw new Error("provider failed"); };
  const thrownResult = await scheduler(thrown).cycle();
  assert.equal(thrownResult.outcome, "failed");
  assert.equal(thrown.persistenceInputs[0]?.execution.outcome, "unknown");
  assert.equal(thrown.events.includes("release"), true);

  const persistence = new Fakes();
  persistence.persistenceResult = { outcome: "failed", reason: "database unavailable" };
  const persistenceResult = await scheduler(persistence).cycle();
  assert.equal(persistenceResult.outcome, "failed");
  assert.equal(persistence.events.includes("release"), false);
  assert.equal(persistence.events.includes("uncertain"), true);

  const release = new Fakes();
  release.releaseResult = { outcome: "unknown", reason: "release uncertain" };
  const releaseResult = await scheduler(release).cycle();
  assert.equal(releaseResult.outcome, "failed");
  assert.equal(release.events.includes("uncertain"), true);
});

test("prevents concurrent cycles and performs bounded shutdown recovery", async () => {
  const fakes = new Fakes();
  let finish: ((value: WorkerExecutionResult) => void) | undefined;
  fakes.invocation = (signal) => new Promise<WorkerExecutionResult>((resolve) => {
    finish = resolve;
    signal.addEventListener("abort", () => resolve({ outcome: "cancelled", reason: "shutdown" }), { once: true });
  });
  const instance = scheduler(fakes);
  const first = instance.cycle();
  assert.deepEqual(await instance.cycle(), { outcome: "deferred", reason: "cycle_already_running" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fakes.invocations, 1);
  const shutdown = await instance.shutdown();
  assert.deepEqual(shutdown, { outcome: "stopped", interrupted: true });
  assert.equal(fakes.persistenceInputs[0]?.interrupted, true);
  const completed = await first;
  assert.equal(completed.outcome, "failed");
  finish?.({ outcome: "success" });
  assert.deepEqual(await instance.cycle(), { outcome: "deferred", reason: "shutdown_requested" });
});

test("requires successful startup reconciliation before selecting work", async () => {
  const fakes = new Fakes();
  fakes.recoveryResult = { outcome: "unknown", reason: "uncertain lease" };
  const resultValue = await scheduler(fakes).cycle();
  assert.deepEqual(resultValue, { outcome: "reconciliation_required", reason: "recovery:uncertain lease" });
  assert.equal(fakes.events.includes("select"), false);
});
