import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ExecutionObservabilityQueryService,
  ExecutionObservabilityRepository,
  RuntimeSqliteStore,
  type DurableExecutionEventInput,
  type DurableExecutionMetricInput,
  type UtcTimestamp,
} from "../src/index.js";

const from = "2026-11-01T00:00:00.000Z" as UtcTimestamp;
const t1 = "2026-11-01T01:00:00.000Z" as UtcTimestamp;
const t2 = "2026-11-01T02:00:00.000Z" as UtcTimestamp;
const t3 = "2026-11-01T03:00:00.000Z" as UtcTimestamp;
const to = "2026-11-02T00:00:00.000Z" as UtcTimestamp;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pirx-observability-query-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  return { directory, store };
}

function metric(signalId: string, name: DurableExecutionMetricInput["metric"]["name"], observedAt: UtcTimestamp, value: number, attributes: DurableExecutionMetricInput["metric"]["attributes"]): DurableExecutionMetricInput {
  return { signalId, source: { kind: name.startsWith("pirx.ci") ? "ci" : "attempt", id: signalId, version: 1 }, metric: { name, observedAt, value, attributes } };
}

test("returns deterministic recent outcomes, latency percentiles, and repeated failures", async () => {
  const value = await fixture();
  try {
    const events: DurableExecutionEventInput[] = [
      { signalId: "event-1", source: { kind: "task", id: "task-1", version: 1 }, event: { name: "pirx.task.lifecycle", occurredAt: t1, attributes: { correlationId: "task:1", taskId: "task-1", taskState: "in_progress", risk: "medium" } } },
      { signalId: "event-2", source: { kind: "ci", id: "ci-1", version: 1 }, event: { name: "pirx.ci.lifecycle", occurredAt: t3, attributes: { correlationId: "ci:1", taskId: "task-1", attemptId: "attempt-1", ciProvider: "github-actions", ciState: "failure", workflowName: "CI" } } },
    ];
    const metrics: DurableExecutionMetricInput[] = [1, 2, 3, 4, 100].map((seconds, index) => metric(`duration-${index}`, "pirx.attempt.duration", t2, seconds, { provider: "claude-code", outcome: "FAILED" }));
    metrics.push(
      metric("attempt-failure-1", "pirx.attempt.lifecycle.total", t1, 1, { attemptState: "terminal", provider: "claude-code", outcome: "FAILED" }),
      metric("attempt-failure-2", "pirx.attempt.lifecycle.total", t2, 1, { attemptState: "terminal", provider: "claude-code", outcome: "FAILED" }),
      metric("ci-failure-1", "pirx.ci.lifecycle.total", t2, 1, { ciProvider: "github-actions", ciState: "failure", workflowName: "CI" }),
      metric("ci-failure-2", "pirx.ci.lifecycle.total", t3, 1, { ciProvider: "github-actions", ciState: "failure", workflowName: "CI" }),
    );
    assert.equal(new ExecutionObservabilityRepository(value.store).record({ events, metrics, recordedAt: t3 }).outcome, "recorded");

    const result = new ExecutionObservabilityQueryService(value.store).query({ from, to, recentEventLimit: 1 });
    assert.equal(result.outcome, "success");
    if (result.outcome !== "success") return;
    assert.equal(result.report.partial, false);
    assert.deepEqual(result.report.recentEvents.map((event) => event.name), ["pirx.ci.lifecycle"]);
    const duration = result.report.latency.find((item) => item.name === "pirx.attempt.duration");
    assert.deepEqual(duration, { name: "pirx.attempt.duration", count: 5, minimumSeconds: 1, averageSeconds: 22, p50Seconds: 3, p95Seconds: 100, maximumSeconds: 100 });
    assert.deepEqual(result.report.repeatedFailures.map((item) => [item.kind, item.outcome, item.count]), [["ci", "failure", 2], ["attempt", "FAILED", 2]]);
    assert.equal(JSON.stringify(result.report).includes("correlationId"), true);
    assert.equal(JSON.stringify(result.report).includes("prompt"), false);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("reports empty and partial windows without inventing latency", async () => {
  const value = await fixture();
  try {
    const service = new ExecutionObservabilityQueryService(value.store);
    const empty = service.query({ from, to });
    assert.equal(empty.outcome, "success");
    if (empty.outcome === "success") {
      assert.deepEqual(empty.report.latency, []);
      assert.equal(empty.report.notices.includes("no_data"), true);
    }
    const repository = new ExecutionObservabilityRepository(value.store);
    assert.equal(repository.record({ events: [
      { signalId: "partial-event-1", source: { kind: "task", id: "task-1", version: 1 }, event: { name: "pirx.task.lifecycle", occurredAt: t1, attributes: { correlationId: "task:1", taskId: "task-1", taskState: "ready", risk: "low" } } },
      { signalId: "partial-event-2", source: { kind: "task", id: "task-2", version: 1 }, event: { name: "pirx.task.lifecycle", occurredAt: t2, attributes: { correlationId: "task:2", taskId: "task-2", taskState: "ready", risk: "low" } } },
    ], metrics: [], recordedAt: t2 }).outcome, "recorded");
    const partial = service.query({ from, to, sourceRowLimit: 1 });
    assert.equal(partial.outcome, "success");
    if (partial.outcome === "success") {
      assert.equal(partial.report.partial, true);
      assert.deepEqual(partial.report.coverage, { eventsAvailable: 2, eventsScanned: 1, metricsAvailable: 0, metricsScanned: 0 });
      assert.equal(partial.report.notices.includes("events_truncated"), true);
    }
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("rejects invalid windows and malformed durable observations explicitly", async () => {
  const value = await fixture();
  try {
    const service = new ExecutionObservabilityQueryService(value.store);
    assert.equal(service.query({ from: to, to: from }).outcome, "invalid_request");
    value.store.database.prepare("INSERT INTO runtime_execution_events (signal_id, schema_version, name, occurred_at, attributes_json, source_kind, source_id, source_version, recorded_at, content_hash) VALUES ('bad', 1, 'pirx.task.lifecycle', ?, '[]', 'task', 'task-1', 1, ?, ?)").run(t1, t1, "a".repeat(64));
    assert.equal(service.query({ from, to }).outcome, "invalid_data");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});
