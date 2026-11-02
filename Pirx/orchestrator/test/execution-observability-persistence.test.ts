import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ExecutionObservabilityProjector,
  ExecutionObservabilityRepository,
  RuntimeSqliteStore,
  createTask,
  transitionAttempt,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-11-02T12:00:00.000Z" as UtcTimestamp;
const t1 = "2026-11-02T12:01:00.000Z" as UtcTimestamp;
const t2 = "2026-11-02T12:03:00.000Z" as UtcTimestamp;
const t3 = "2026-11-02T12:05:00.000Z" as UtcTimestamp;
const t4 = "2026-11-02T12:07:00.000Z" as UtcTimestamp;
const t5 = "2026-11-02T12:10:00.000Z" as UtcTimestamp;
const t6 = "2026-11-02T12:12:00.000Z" as UtcTimestamp;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pirx-observability-projection-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  return { directory, filename, store };
}

function task(id: string) {
  const value = createTask({ id: id as TaskId, goal: "record timings", scope: "observability projection", acceptanceCriteria: ["durable"], priority: 50, risk: "medium", requiredCapabilities: ["repository.read"], createdAt: t0 });
  if (!value.ok) throw new Error("Task fixture failed.");
  return value.value;
}

function finish(store: RuntimeSqliteStore, id: AttemptId, at: UtcTimestamp, result: "FAILED" | "CODE_PUSHED") {
  const running = store.attempts.get(id);
  if (running.outcome !== "success") throw new Error("Attempt fixture missing.");
  const terminal = transitionAttempt(running.value, "running", result === "CODE_PUSHED" ? { type: "finish", result, branch: "pirx/task-observability", finalCommit: "a".repeat(40) } : { type: "finish", result, blockingReason: "retry fixture" }, at);
  if (!terminal.ok) throw new Error("Attempt fixture transition failed.");
  assert.equal(store.attempts.update(terminal.value, "running").outcome, "success");
}

test("projects every durable lifecycle and timing definition, then replays across restart", async () => {
  const value = await fixture();
  try {
    const current = task("observability-task");
    assert.equal(value.store.tasks.create(current).outcome, "success");
    const first = "observability-attempt-1" as AttemptId;
    const second = "observability-attempt-2" as AttemptId;
    assert.equal(value.store.startAttempt(current.id, { id: first, worker: "pirx", provider: "claude-code" }, t1).outcome, "success");
    finish(value.store, first, t2, "FAILED");
    assert.equal(value.store.startAttempt(current.id, { id: second, worker: "pirx", provider: "claude-code", predecessorAttemptId: first }, t3).outcome, "success");
    finish(value.store, second, t4, "CODE_PUSHED");
    value.store.database.prepare("INSERT INTO runtime_ci_correlations (task_id, attempt_id, schema_version, repository, issue_number, issue_node_id, issue_url, feature_pr_node_id, feature_pr_number, feature_pr_url, worker_id, head_branch, base_branch, pushed_commit, provider, required_workflow_name, provider_run_id, provider_run_url, workflow_name, provider_pipeline_id, tested_revision, state, observed_at, created_at, updated_at, version) VALUES (?, ?, 1, 'PiotrGry/ai-assistant', 144, 'issue-144', 'https://example.test/issues/144', 'pr-144', 144, 'https://example.test/pulls/144', 'pirx', 'pirx/task-observability', 'main', ?, 'github-actions', 'CI', 'run-144', 'https://example.test/runs/144', 'CI', 'pipeline-144', ?, 'success', ?, ?, ?, 2)").run(current.id, second, "a".repeat(40), "a".repeat(40), t5, t4, t5);
    assert.equal(value.store.workerAvailability.record({ workerId: "pirx", provider: "claude-code", state: "cooldown", startedAt: t1, expiresAt: t3, reason: "provider reset", providerMetadata: { source: "provider_reset", resetAt: t3 } }).outcome, "success");
    assert.equal(value.store.shipmentCycles.start({ schemaVersion: 1, taskId: current.id, attemptId: second, eventId: "shipment-observability", correlationId: "delivery:observability", repository: "PiotrGry/ai-assistant", headBranch: "pirx/task-observability", baseBranch: "main", expectedHeadSha: "a".repeat(40), provider: "github-actions", workflowName: "CI", completionMode: "merge", state: "started", message: "started", createdAt: t4, updatedAt: t4, version: 1 }).outcome, "success");
    assert.equal(value.store.shipmentCycles.advance(current.id, second, { state: "recovery_success", outcome: "recovery_success", message: "delivered", mergeSha: "b".repeat(40) }, t6).outcome, "success");

    const firstProjection = new ExecutionObservabilityProjector(value.store, { now: () => t6 }).reconcile();
    assert.equal(firstProjection.outcome, "recorded", JSON.stringify(firstProjection));
    const metricRows = value.store.database.prepare("SELECT name, value FROM runtime_execution_metrics ORDER BY name, value").all() as Array<{ name: string; value: number }>;
    const values = (name: string) => metricRows.filter((row) => row.name === name).map((row) => row.value);
    assert.deepEqual(values("pirx.task.queue.duration"), [60]);
    assert.deepEqual(values("pirx.attempt.duration"), [120, 120]);
    assert.deepEqual(values("pirx.attempt.retry.wait.duration"), [120]);
    assert.deepEqual(values("pirx.ci.duration"), [180]);
    assert.deepEqual(values("pirx.worker.cooldown.duration"), [240]);
    assert.deepEqual(values("pirx.delivery.duration"), [300]);
    const eventNames = new Set((value.store.database.prepare("SELECT name FROM runtime_execution_events").all() as Array<{ name: string }>).map((row) => row.name));
    assert.deepEqual(eventNames, new Set(["pirx.task.lifecycle", "pirx.attempt.lifecycle", "pirx.ci.lifecycle", "pirx.worker.cooldown", "pirx.delivery.lifecycle"]));
    const counts = { events: (value.store.database.prepare("SELECT COUNT(*) AS value FROM runtime_execution_events").get() as { value: number }).value, metrics: (value.store.database.prepare("SELECT COUNT(*) AS value FROM runtime_execution_metrics").get() as { value: number }).value };
    assert.equal(new ExecutionObservabilityProjector(value.store, { now: () => t6 }).reconcile().outcome, "replayed");
    value.store.close();
    value.store = RuntimeSqliteStore.open({ filename: value.filename });
    assert.equal(new ExecutionObservabilityProjector(value.store, { now: () => t6 }).reconcile().outcome, "replayed");
    assert.deepEqual({ events: (value.store.database.prepare("SELECT COUNT(*) AS value FROM runtime_execution_events").get() as { value: number }).value, metrics: (value.store.database.prepare("SELECT COUNT(*) AS value FROM runtime_execution_metrics").get() as { value: number }).value }, counts);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("rolls back conflicting signal identity and rejects truncated or reversed source time", async () => {
  const value = await fixture();
  try {
    const repository = new ExecutionObservabilityRepository(value.store);
    const base = { signalId: "fixed-event", source: { kind: "task" as const, id: "task-1", version: 1 }, event: { name: "pirx.task.lifecycle" as const, occurredAt: t0, attributes: { correlationId: "task:1", taskId: "task-1", taskState: "ready", risk: "low" } } };
    assert.equal(repository.record({ events: [base], metrics: [], recordedAt: t0 }).outcome, "recorded");
    assert.equal(repository.record({ events: [{ ...base, event: { ...base.event, attributes: { ...base.event.attributes, taskState: "failed" } } }], metrics: [], recordedAt: t1 }).outcome, "conflict");
    const one = task("truncated-task-1"); const two = task("truncated-task-2");
    assert.equal(value.store.tasks.create(one).outcome, "success"); assert.equal(value.store.tasks.create(two).outcome, "success");
    assert.equal(new ExecutionObservabilityProjector(value.store, { now: () => t1, sourceRowLimit: 1 }).reconcile().outcome, "truncated");
    assert.equal(value.store.startAttempt(one.id, { id: "reversed-attempt" as AttemptId, worker: "pirx", provider: "claude-code" }, t1).outcome, "success");
    value.store.database.prepare("UPDATE runtime_tasks SET created_at = ? WHERE id = ?").run(t2, one.id);
    assert.equal(new ExecutionObservabilityProjector(value.store, { now: () => t2 }).reconcile().outcome, "invalid_source");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("records partial lifecycle facts without inventing unavailable terminal durations", async () => {
  const value = await fixture();
  try {
    const current = task("partial-observability-task");
    assert.equal(value.store.tasks.create(current).outcome, "success");
    assert.equal(value.store.startAttempt(current.id, { id: "partial-observability-attempt" as AttemptId, worker: "pirx", provider: "claude-code" }, t1).outcome, "success");
    const projected = new ExecutionObservabilityProjector(value.store, { now: () => t1 }).reconcile();
    assert.equal(projected.outcome, "recorded");
    const names = (value.store.database.prepare("SELECT name FROM runtime_execution_metrics").all() as Array<{ name: string }>).map((row) => row.name);
    assert.equal(names.includes("pirx.task.queue.duration"), true);
    assert.equal(names.includes("pirx.attempt.duration"), false);
    assert.equal(names.includes("pirx.attempt.retry.wait.duration"), false);
    assert.equal(names.includes("pirx.ci.duration"), false);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});
