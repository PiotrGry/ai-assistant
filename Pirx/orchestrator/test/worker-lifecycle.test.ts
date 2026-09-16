import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RuntimeSqliteStore,
  WorkerLifecycleCoordinator,
  createWorkerFailureDiagnostic,
  createTask,
  createWorkerRequest,
  startInitialAttempt,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
  type WorkerPort,
  type WorkerRequest,
  type WorkerResult,
} from "../src/index.js";

const t0 = "2026-09-15T16:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-15T16:01:00.000Z" as UtcTimestamp;
const taskId = "lifecycle-task" as TaskId;
const attemptId = "lifecycle-attempt-1" as AttemptId;
const branch = "pirx/lifecycle";
const worktree = "/tmp/pirx-lifecycle";

async function storeFixture(): Promise<{ readonly directory: string; readonly store: RuntimeSqliteStore }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-worker-lifecycle-test-"));
  return { directory, store: RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") }) };
}
function request(store: RuntimeSqliteStore, overrides: Partial<{ worker: string; provider: string }> = {}): WorkerRequest {
  const task = createTask({ id: taskId, goal: "Run one assigned worker", scope: "lifecycle", acceptanceCriteria: ["durable result"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
  if (!task.ok) throw new Error(task.error.message);
  const started = startInitialAttempt(task.value, [], { id: attemptId, worker: overrides.worker ?? "worker-1", provider: overrides.provider ?? "provider-1", branch, worktree }, t0);
  if (!started.ok) throw new Error(started.error.message);
  assert.equal(store.tasks.create(started.value.task).outcome, "success");
  assert.equal(store.attempts.create(started.value.attempt).outcome, "success");
  const value = createWorkerRequest({
    task: started.value.task,
    attempt: started.value.attempt,
    workerId: overrides.worker ?? "worker-1",
    provider: overrides.provider ?? "provider-1",
    repository: { owner: "PiotrGry", repository: "ai-assistant" },
    workspace: { branch, worktree },
    capabilityGrant: { grantedCapabilities: ["repository.read"], resourceScope: { repository: "PiotrGry/ai-assistant", branch, worktree } },
    correlationId: "lifecycle-correlation",
    limits: { timeoutMs: 30_000, maxOutputBytes: 10_000, maxErrorBytes: 10_000 },
  });
  if (!value.ok) throw new Error(value.violations[0]?.message ?? "request fixture failed");
  return value.value;
}
function result(value: WorkerRequest, outcome: WorkerResult["outcome"]): WorkerResult {
  return outcome === "CODE_PUSHED"
    ? { kind: "worker_result", schemaVersion: 1, taskId: value.taskId, attemptId: value.attemptId, correlationId: value.correlationId, outcome, branch, finalCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
    : { kind: "worker_result", schemaVersion: 1, taskId: value.taskId, attemptId: value.attemptId, correlationId: value.correlationId, outcome, reason: "bounded worker reason" };
}

test("records CODE_PUSHED once, keeps the Task incomplete, and replays the same result", async () => {
  const value = await storeFixture();
  let calls = 0;
  try {
    const input = request(value.store);
    const worker: WorkerPort = { execute: async () => { calls += 1; return result(input, "CODE_PUSHED"); } };
    const coordinator = new WorkerLifecycleCoordinator(value.store, worker, { now: () => t1 });
    const first = await coordinator.execute(input, new AbortController().signal);
    assert.equal(first.outcome, "terminal_recorded");
    assert.equal(calls, 1);
    if (first.outcome === "terminal_recorded") {
      assert.equal(first.attempt.state, "terminal");
      assert.equal(first.attempt.result, "CODE_PUSHED");
      assert.equal(first.attempt.branch, branch);
      assert.equal(first.attempt.finalCommit, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      assert.equal(first.task.state, "in_progress");
    }
    const replay = await coordinator.execute(input, new AbortController().signal);
    assert.equal(replay.outcome, "replayed");
    assert.equal(calls, 1);
    assert.deepEqual(value.store.attempts.listByTask(taskId).outcome, "success");
    const current = value.store.attempts.currentByTask(taskId);
    assert.equal(current.outcome, "not_found");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("persists every non-success outcome with a checkpoint and explicit Task state", async () => {
  for (const [outcome, expectedState, trigger] of [
    ["BLOCKED", "blocked", "RECOVERABLE_FAILURE"],
    ["FAILED", "failed", "RECOVERABLE_FAILURE"],
    ["QUOTA_EXHAUSTED", "failed", "PROVIDER_QUOTA"],
    ["CANCELLED", "cancelled", "WORKER_INTERRUPTION"],
    ["UNKNOWN", "failed", "RECOVERABLE_FAILURE"],
  ] as const) {
    const value = await storeFixture();
    try {
      const input = request(value.store);
      const coordinator = new WorkerLifecycleCoordinator(value.store, { execute: async () => result(input, outcome) }, { now: () => t1 });
      const recorded = await coordinator.execute(input, new AbortController().signal);
      assert.equal(recorded.outcome, "terminal_recorded", outcome);
      if (recorded.outcome !== "terminal_recorded") continue;
      assert.equal(recorded.task.state, expectedState);
      assert.equal(recorded.attempt.state, "terminal");
      if (recorded.attempt.state === "terminal") assert.equal(recorded.attempt.result, outcome);
      assert.equal(recorded.checkpointId !== undefined, true);
      const checkpoint = value.store.checkpoints.latestByTask(taskId);
      assert.equal(checkpoint.outcome, "success");
      if (checkpoint.outcome === "success") assert.equal(checkpoint.value.trigger, trigger);
    } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
  }
});

test("invokes one worker, rejects conflicting identity, and fails closed for unsafe output", async () => {
  const value = await storeFixture();
  let calls = 0;
  try {
    const input = request(value.store);
    const worker: WorkerPort = { execute: async () => { calls += 1; return { ...result(input, "FAILED"), reason: "token=must-not-persist" }; } };
    const coordinator = new WorkerLifecycleCoordinator(value.store, worker, { now: () => t1 });
    const unsafe = await coordinator.execute(input, new AbortController().signal);
    assert.equal(unsafe.outcome, "terminal_recorded");
    if (unsafe.outcome === "terminal_recorded") {
      assert.equal(unsafe.result.outcome, "UNKNOWN");
      assert.equal(JSON.stringify(unsafe).includes("must-not-persist"), false);
    }
    assert.equal(calls, 1);
    const conflict = await coordinator.execute({ ...input, provider: "other-provider", capabilityGrant: { ...input.capabilityGrant, workerId: input.workerId } }, new AbortController().signal);
    assert.equal(conflict.outcome, "conflict");
    assert.equal(calls, 1);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("does not invoke after pre-cancellation and requires reconciliation after an uncertain restart", async () => {
  const value = await storeFixture();
  let calls = 0;
  try {
    const input = request(value.store);
    const worker: WorkerPort = { execute: async () => { calls += 1; return result(input, "CODE_PUSHED"); } };
    const cancelled = new AbortController();
    cancelled.abort();
    const coordinator = new WorkerLifecycleCoordinator(value.store, worker, { now: () => t1 });
    const before = await coordinator.execute(input, cancelled.signal);
    assert.equal(before.outcome, "cancelled");
    assert.equal(calls, 0);
    const started = value.store.attempts.recordProgress(attemptId, { state: "running", startedAt: t0 }, { progress: "worker invocation started" }, t1);
    assert.equal(started.outcome, "success");
    const reopened = new WorkerLifecycleCoordinator(value.store, worker, { now: () => t1 });
    const recovery = await reopened.execute(input, new AbortController().signal);
    assert.equal(recovery.outcome, "reconciliation_required");
    assert.equal(calls, 0);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("publishes only bounded lifecycle events and reports projection failure after durable commit", async () => {
  const value = await storeFixture();
  const events: string[] = [];
  try {
    const input = request(value.store);
    const projection = { publish: (event: { readonly eventType: string; readonly summary: string }) => { events.push(event.eventType + ":" + event.summary); return { outcome: "provider_error" }; } };
    const coordinator = new WorkerLifecycleCoordinator(value.store, { execute: async () => result(input, "CODE_PUSHED") }, { now: () => t1, projection });
    const first = await coordinator.execute(input, new AbortController().signal);
    assert.equal(first.outcome, "projection_pending");
    assert.deepEqual(events, ["attempt_started:Worker Attempt started.", "attempt_result:Worker Attempt ended with CODE_PUSHED."]);
    const replay = await coordinator.execute(input, new AbortController().signal);
    assert.equal(replay.outcome, "replayed");
    assert.equal(events.length, 2);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("survives restart with a durable terminal Attempt and never creates a second Attempt", async () => {
  const value = await storeFixture();
  try {
    const input = request(value.store);
    let calls = 0;
    const worker: WorkerPort = { execute: async () => { calls += 1; return result(input, "CODE_PUSHED"); } };
    const first = await new WorkerLifecycleCoordinator(value.store, worker, { now: () => t1 }).execute(input, new AbortController().signal);
    assert.equal(first.outcome, "terminal_recorded");
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: join(value.directory, "runtime.sqlite") });
    try {
      const replay = await new WorkerLifecycleCoordinator(reopened, worker, { now: () => t1 }).execute(input, new AbortController().signal);
      assert.equal(replay.outcome, "replayed");
      assert.equal(calls, 1);
      const history = reopened.attempts.listByTask(taskId);
      assert.equal(history.outcome, "success");
      if (history.outcome === "success") assert.equal(history.value.length, 1);
    } finally { reopened.close(); }
  } finally { if (!value.store) { /* store was closed for the restart branch */ } else { try { value.store.close(); } catch { /* already closed */ } } await rm(value.directory, { recursive: true, force: true }); }
});

test("persists bounded worker diagnostics and replays them after restart", async () => {
  const value = await storeFixture();
  try {
    const input = request(value.store);
    const diagnostic = createWorkerFailureDiagnostic("timeout", { durationMs: 30_000 });
    const worker: WorkerPort = {
      execute: async () => ({
        ...result(input, "FAILED"),
        diagnostic,
      }),
    };
    const first = await new WorkerLifecycleCoordinator(value.store, worker, { now: () => t1 }).execute(input, new AbortController().signal);
    assert.equal(first.outcome, "terminal_recorded");
    if (first.outcome === "terminal_recorded") {
      assert.equal(first.result.outcome, "FAILED");
      assert.deepEqual("diagnostic" in first.result ? first.result.diagnostic : undefined, diagnostic);
      if (first.attempt.state === "terminal") assert.deepEqual(first.attempt.diagnostic, diagnostic);
      const checkpoint = value.store.checkpoints.latestByTask(taskId);
      assert.equal(checkpoint.outcome, "success");
      if (checkpoint.outcome === "success") assert.deepEqual(checkpoint.value.diagnostic, diagnostic);
    }
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: join(value.directory, "runtime.sqlite") });
    try {
      const replay = await new WorkerLifecycleCoordinator(reopened, worker, { now: () => t1 }).execute(input, new AbortController().signal);
      assert.equal(replay.outcome, "replayed");
      if (replay.outcome === "replayed") assert.deepEqual("diagnostic" in replay.result ? replay.result.diagnostic : undefined, diagnostic);
      const attempt = reopened.attempts.get(attemptId);
      assert.equal(attempt.outcome, "success");
      if (attempt.outcome === "success" && attempt.value.state === "terminal") assert.deepEqual(attempt.value.diagnostic, diagnostic);
    } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* already closed */ } await rm(value.directory, { recursive: true, force: true }); }
});
