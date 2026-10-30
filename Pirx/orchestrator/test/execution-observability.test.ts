import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_EVENT_DEFINITIONS,
  EXECUTION_EVENT_NAMES,
  EXECUTION_METRIC_DEFINITIONS,
  EXECUTION_METRIC_NAMES,
  EXECUTION_OBSERVABILITY_RETENTION,
  createExecutionEvent,
  createExecutionMetric,
  type ExecutionAttributes,
  type ExecutionEventName,
  type ExecutionMetricName,
  type UtcTimestamp,
} from "../src/index.js";

const now = "2026-10-30T12:00:00.000Z" as UtcTimestamp;

const eventAttributes: Readonly<Record<ExecutionEventName, ExecutionAttributes>> = {
  "pirx.task.lifecycle": { correlationId: "task:42:event:1", taskId: "task-42", taskState: "in_progress", issueNumber: 143, risk: "low" },
  "pirx.attempt.lifecycle": { correlationId: "task-42:attempt-2", taskId: "task-42", attemptId: "attempt-2", attemptOrdinal: 2, attemptState: "terminal", outcome: "CODE_PUSHED", provider: "claude-code" },
  "pirx.ci.lifecycle": { correlationId: "task-42:attempt-2:ci", taskId: "task-42", attemptId: "attempt-2", ciProvider: "github-actions", ciState: "success", ciRunId: "34961451743", workflowName: "Develop Fast Gate" },
  "pirx.worker.cooldown": { correlationId: "worker:claude:cooldown:7", workerId: "claude", provider: "claude-code", cooldownState: "started", cooldownUntil: "2026-10-30T17:00:00.000Z", recoverySource: "provider_reset" },
  "pirx.delivery.lifecycle": { correlationId: "release:42:deployment", releaseId: "release-42", repository: "PiotrGry/zdrovena-reconciliation", deliveryState: "production_verification", deploymentId: "deployment-91", environment: "production" },
};

const metricAttributes: Readonly<Record<ExecutionMetricName, ExecutionAttributes>> = {
  "pirx.task.lifecycle.total": { taskState: "completed", risk: "low" },
  "pirx.attempt.lifecycle.total": { attemptState: "terminal", provider: "claude-code", outcome: "CODE_PUSHED" },
  "pirx.attempt.duration": { provider: "claude-code", outcome: "CODE_PUSHED" },
  "pirx.ci.lifecycle.total": { ciProvider: "github-actions", ciState: "success", workflowName: "Develop Fast Gate" },
  "pirx.worker.cooldown.total": { provider: "claude-code", recoverySource: "provider_reset" },
  "pirx.worker.cooldown.duration": { provider: "claude-code", recoverySource: "provider_reset" },
  "pirx.delivery.lifecycle.total": { deliveryState: "deployed", environment: "production" },
  "pirx.delivery.duration": { deliveryState: "production_verification", environment: "production" },
};

test("keeps stable Task, Attempt, CI, cooldown, and delivery event contracts", () => {
  assert.deepEqual(EXECUTION_EVENT_NAMES, ["pirx.task.lifecycle", "pirx.attempt.lifecycle", "pirx.ci.lifecycle", "pirx.worker.cooldown", "pirx.delivery.lifecycle"]);
  for (const name of EXECUTION_EVENT_NAMES) {
    const created = createExecutionEvent({ name, occurredAt: now, attributes: eventAttributes[name] });
    assert.equal(created.ok, true, name);
    if (created.ok) {
      assert.equal(created.value.schemaVersion, 1);
      assert.equal(created.value.name, name);
      assert.equal(created.value.attributes.correlationId, eventAttributes[name].correlationId);
      assert.equal(EXECUTION_EVENT_DEFINITIONS[name].retentionDays, 30);
    }
  }
});

test("keeps stable aggregate metric names, units, and bounded labels", () => {
  assert.equal(EXECUTION_METRIC_NAMES.length, 8);
  for (const name of EXECUTION_METRIC_NAMES) {
    const definition = EXECUTION_METRIC_DEFINITIONS[name];
    const value = definition.instrument === "counter" ? 1 : 12.5;
    const created = createExecutionMetric({ name, observedAt: now, value, attributes: metricAttributes[name] });
    assert.equal(created.ok, true, name);
    if (created.ok) {
      assert.equal(created.value.instrument, definition.instrument);
      assert.equal(created.value.unit, definition.unit);
      assert.equal(created.value.schemaVersion, 1);
    }
    assert.equal(definition.requiredAttributes.some((field) => field.endsWith("Id") || field === "correlationId" || field === "repository"), false, name);
  }
  assert.deepEqual(EXECUTION_OBSERVABILITY_RETENTION, { eventDays: 30, rawMetricDays: 30, aggregateMetricDays: 180 });
});

test("rejects secrets, raw logs, unknown fields, and malformed signal data", () => {
  const secret = createExecutionEvent({ name: "pirx.task.lifecycle", occurredAt: now, attributes: { correlationId: "task:1", taskId: "task-1", taskState: "failed", reasonCode: "token=ghp_abcdefghijklmnopqrstuvwxyz123456" } });
  assert.equal(secret.ok, false);
  const logs = createExecutionEvent({ name: "pirx.task.lifecycle", occurredAt: now, attributes: { correlationId: "task:1", taskId: "task-1", taskState: "failed", logBody: "raw provider output" } as never });
  assert.equal(logs.ok, false);
  const missing = createExecutionEvent({ name: "pirx.attempt.lifecycle", occurredAt: now, attributes: { correlationId: "attempt:1", taskId: "task-1" } });
  assert.equal(missing.ok, false);
  assert.equal(createExecutionEvent({ name: "unknown" as ExecutionEventName, occurredAt: now, attributes: {} }).ok, false);
  assert.equal(createExecutionMetric({ name: "pirx.attempt.duration", observedAt: "not-a-time" as UtcTimestamp, value: 1, attributes: metricAttributes["pirx.attempt.duration"] }).ok, false);
  assert.equal(createExecutionMetric({ name: "pirx.task.lifecycle.total", observedAt: now, value: 0.5, attributes: metricAttributes["pirx.task.lifecycle.total"] }).ok, false);
  assert.equal(createExecutionMetric({ name: "pirx.attempt.duration", observedAt: now, value: -1, attributes: metricAttributes["pirx.attempt.duration"] }).ok, false);
});

test("forbids correlation and entity identifiers as metric labels", () => {
  for (const field of ["correlationId", "taskId", "attemptId", "releaseId", "repository"]) {
    const result = createExecutionMetric({ name: "pirx.attempt.duration", observedAt: now, value: 1, attributes: { ...metricAttributes["pirx.attempt.duration"], [field]: "unique-value" } });
    assert.equal(result.ok, false, field);
  }
});
