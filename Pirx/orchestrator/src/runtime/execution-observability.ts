import type { UtcTimestamp } from "./task-domain.js";

export const EXECUTION_OBSERVABILITY_SCHEMA_VERSION = 1 as const;
export const EXECUTION_OBSERVABILITY_LIMITS = Object.freeze({ attributeName: 64, attributeValue: 256, attributes: 16 } as const);
export const EXECUTION_OBSERVABILITY_RETENTION = Object.freeze({ eventDays: 30, rawMetricDays: 30, aggregateMetricDays: 180 } as const);

export const EXECUTION_EVENT_NAMES = Object.freeze([
  "pirx.task.lifecycle",
  "pirx.attempt.lifecycle",
  "pirx.ci.lifecycle",
  "pirx.worker.cooldown",
  "pirx.delivery.lifecycle",
] as const);
export type ExecutionEventName = (typeof EXECUTION_EVENT_NAMES)[number];

export const EXECUTION_METRIC_NAMES = Object.freeze([
  "pirx.task.lifecycle.total",
  "pirx.attempt.lifecycle.total",
  "pirx.attempt.duration",
  "pirx.ci.lifecycle.total",
  "pirx.worker.cooldown.total",
  "pirx.worker.cooldown.duration",
  "pirx.delivery.lifecycle.total",
  "pirx.delivery.duration",
] as const);
export type ExecutionMetricName = (typeof EXECUTION_METRIC_NAMES)[number];

export type ExecutionAttributeValue = string | number | boolean;
export type ExecutionAttributes = Readonly<Record<string, ExecutionAttributeValue>>;
export type ExecutionMetricInstrument = "counter" | "histogram";
export type ExecutionMetricUnit = "1" | "s";

export interface ExecutionEventDefinition {
  readonly name: ExecutionEventName;
  readonly description: string;
  readonly requiredAttributes: readonly string[];
  readonly optionalAttributes: readonly string[];
  readonly retentionDays: number;
}

export interface ExecutionMetricDefinition {
  readonly name: ExecutionMetricName;
  readonly description: string;
  readonly instrument: ExecutionMetricInstrument;
  readonly unit: ExecutionMetricUnit;
  readonly requiredAttributes: readonly string[];
  readonly optionalAttributes: readonly string[];
  readonly cardinality: "low" | "bounded";
  readonly retention: "raw_30d_rollup_180d";
}

const correlation = "correlationId";
export const EXECUTION_EVENT_DEFINITIONS: Readonly<Record<ExecutionEventName, ExecutionEventDefinition>> = Object.freeze({
  "pirx.task.lifecycle": Object.freeze({ name: "pirx.task.lifecycle", description: "A durable runtime Task lifecycle observation.", requiredAttributes: Object.freeze([correlation, "taskId", "taskState"]), optionalAttributes: Object.freeze(["issueNumber", "priority", "risk", "reasonCode"]), retentionDays: EXECUTION_OBSERVABILITY_RETENTION.eventDays }),
  "pirx.attempt.lifecycle": Object.freeze({ name: "pirx.attempt.lifecycle", description: "An execution Attempt lifecycle observation.", requiredAttributes: Object.freeze([correlation, "taskId", "attemptId", "attemptOrdinal", "attemptState"]), optionalAttributes: Object.freeze(["outcome", "workerId", "provider"]), retentionDays: EXECUTION_OBSERVABILITY_RETENTION.eventDays }),
  "pirx.ci.lifecycle": Object.freeze({ name: "pirx.ci.lifecycle", description: "A normalized CI observation correlated to exact work.", requiredAttributes: Object.freeze([correlation, "taskId", "attemptId", "ciProvider", "ciState"]), optionalAttributes: Object.freeze(["ciRunId", "workflowName"]), retentionDays: EXECUTION_OBSERVABILITY_RETENTION.eventDays }),
  "pirx.worker.cooldown": Object.freeze({ name: "pirx.worker.cooldown", description: "A Worker/provider cooldown lifecycle observation.", requiredAttributes: Object.freeze([correlation, "workerId", "provider", "cooldownState"]), optionalAttributes: Object.freeze(["cooldownUntil", "recoverySource"]), retentionDays: EXECUTION_OBSERVABILITY_RETENTION.eventDays }),
  "pirx.delivery.lifecycle": Object.freeze({ name: "pirx.delivery.lifecycle", description: "A Release or deployment lifecycle observation.", requiredAttributes: Object.freeze([correlation, "releaseId", "repository", "deliveryState"]), optionalAttributes: Object.freeze(["deploymentId", "environment"]), retentionDays: EXECUTION_OBSERVABILITY_RETENTION.eventDays }),
});

export const EXECUTION_METRIC_DEFINITIONS: Readonly<Record<ExecutionMetricName, ExecutionMetricDefinition>> = Object.freeze({
  "pirx.task.lifecycle.total": Object.freeze({ name: "pirx.task.lifecycle.total", description: "Task lifecycle observations.", instrument: "counter", unit: "1", requiredAttributes: Object.freeze(["taskState", "risk"]), optionalAttributes: Object.freeze([]), cardinality: "low", retention: "raw_30d_rollup_180d" }),
  "pirx.attempt.lifecycle.total": Object.freeze({ name: "pirx.attempt.lifecycle.total", description: "Attempt lifecycle observations.", instrument: "counter", unit: "1", requiredAttributes: Object.freeze(["attemptState", "provider"]), optionalAttributes: Object.freeze(["outcome"]), cardinality: "bounded", retention: "raw_30d_rollup_180d" }),
  "pirx.attempt.duration": Object.freeze({ name: "pirx.attempt.duration", description: "Terminal Attempt duration in seconds.", instrument: "histogram", unit: "s", requiredAttributes: Object.freeze(["provider", "outcome"]), optionalAttributes: Object.freeze([]), cardinality: "bounded", retention: "raw_30d_rollup_180d" }),
  "pirx.ci.lifecycle.total": Object.freeze({ name: "pirx.ci.lifecycle.total", description: "Normalized CI state observations.", instrument: "counter", unit: "1", requiredAttributes: Object.freeze(["ciProvider", "ciState"]), optionalAttributes: Object.freeze(["workflowName"]), cardinality: "bounded", retention: "raw_30d_rollup_180d" }),
  "pirx.worker.cooldown.total": Object.freeze({ name: "pirx.worker.cooldown.total", description: "Worker cooldown transitions.", instrument: "counter", unit: "1", requiredAttributes: Object.freeze(["provider", "recoverySource"]), optionalAttributes: Object.freeze([]), cardinality: "bounded", retention: "raw_30d_rollup_180d" }),
  "pirx.worker.cooldown.duration": Object.freeze({ name: "pirx.worker.cooldown.duration", description: "Worker cooldown duration in seconds.", instrument: "histogram", unit: "s", requiredAttributes: Object.freeze(["provider", "recoverySource"]), optionalAttributes: Object.freeze([]), cardinality: "bounded", retention: "raw_30d_rollup_180d" }),
  "pirx.delivery.lifecycle.total": Object.freeze({ name: "pirx.delivery.lifecycle.total", description: "Release and deployment state observations.", instrument: "counter", unit: "1", requiredAttributes: Object.freeze(["deliveryState", "environment"]), optionalAttributes: Object.freeze([]), cardinality: "low", retention: "raw_30d_rollup_180d" }),
  "pirx.delivery.duration": Object.freeze({ name: "pirx.delivery.duration", description: "Delivery stage duration in seconds.", instrument: "histogram", unit: "s", requiredAttributes: Object.freeze(["deliveryState", "environment"]), optionalAttributes: Object.freeze([]), cardinality: "low", retention: "raw_30d_rollup_180d" }),
});

export interface ExecutionEventInput {
  readonly name: ExecutionEventName;
  readonly occurredAt: UtcTimestamp;
  readonly attributes: ExecutionAttributes;
}

export interface ExecutionEvent extends ExecutionEventInput {
  readonly schemaVersion: typeof EXECUTION_OBSERVABILITY_SCHEMA_VERSION;
}

export interface ExecutionMetricInput {
  readonly name: ExecutionMetricName;
  readonly observedAt: UtcTimestamp;
  readonly value: number;
  readonly attributes: ExecutionAttributes;
}

export interface ExecutionMetricPoint extends ExecutionMetricInput {
  readonly schemaVersion: typeof EXECUTION_OBSERVABILITY_SCHEMA_VERSION;
  readonly instrument: ExecutionMetricInstrument;
  readonly unit: ExecutionMetricUnit;
}

export type ExecutionSignalResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string; readonly field?: string };

const SECRET_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+)/iu;
const FORBIDDEN_ATTRIBUTE = /(?:prompt|stdout|stderr|log|message|body|token|secret|password|api[_-]?key|authorization)/iu;

function canonicalTimestamp(value: unknown): value is UtcTimestamp {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateAttributes(attributes: ExecutionAttributes, required: readonly string[], optional: readonly string[], metrics: boolean): ExecutionSignalResult<ExecutionAttributes> {
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) return { ok: false, message: "Execution signal attributes must be a flat object.", field: "attributes" };
  const entries = Object.entries(attributes);
  if (entries.length > EXECUTION_OBSERVABILITY_LIMITS.attributes) return { ok: false, message: "Execution signal has too many attributes.", field: "attributes" };
  const allowed = new Set([...required, ...optional]);
  for (const name of required) if (!(name in attributes)) return { ok: false, message: `Required execution attribute ${name} is missing.`, field: name };
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > EXECUTION_OBSERVABILITY_LIMITS.attributeName || FORBIDDEN_ATTRIBUTE.test(name)) return { ok: false, message: "Execution attribute name is unsafe.", field: name };
    if (metrics && (name === correlation || name.endsWith("Id") || name === "repository")) return { ok: false, message: "High-cardinality identifiers are forbidden on metrics.", field: name };
    if (!allowed.has(name)) return { ok: false, message: `Execution attribute ${name} is not defined by the schema.`, field: name };
    if (typeof value === "string") {
      if (value.length === 0 || value.length > EXECUTION_OBSERVABILITY_LIMITS.attributeValue || /[\u0000-\u001f\u007f]/u.test(value) || SECRET_VALUE.test(value)) return { ok: false, message: "Execution attribute value is unsafe or unbounded.", field: name };
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return { ok: false, message: "Execution numeric attribute must be finite.", field: name };
    } else if (typeof value !== "boolean") return { ok: false, message: "Execution attributes must be scalar values.", field: name };
  }
  return { ok: true, value: Object.freeze({ ...attributes }) };
}

export function createExecutionEvent(input: ExecutionEventInput): ExecutionSignalResult<ExecutionEvent> {
  const definition = EXECUTION_EVENT_DEFINITIONS[input.name];
  if (definition === undefined) return { ok: false, message: "Execution event name is unsupported.", field: "name" };
  if (!canonicalTimestamp(input.occurredAt)) return { ok: false, message: "Execution event timestamp must be canonical UTC.", field: "occurredAt" };
  const attributes = validateAttributes(input.attributes, definition.requiredAttributes, definition.optionalAttributes, false);
  return attributes.ok ? { ok: true, value: Object.freeze({ schemaVersion: EXECUTION_OBSERVABILITY_SCHEMA_VERSION, name: input.name, occurredAt: input.occurredAt, attributes: attributes.value }) } : attributes;
}

export function createExecutionMetric(input: ExecutionMetricInput): ExecutionSignalResult<ExecutionMetricPoint> {
  const definition = EXECUTION_METRIC_DEFINITIONS[input.name];
  if (definition === undefined) return { ok: false, message: "Execution metric name is unsupported.", field: "name" };
  if (!canonicalTimestamp(input.observedAt)) return { ok: false, message: "Execution metric timestamp must be canonical UTC.", field: "observedAt" };
  if (!Number.isFinite(input.value) || input.value < 0 || (definition.instrument === "counter" && !Number.isSafeInteger(input.value))) return { ok: false, message: "Execution metric value is invalid for its instrument.", field: "value" };
  const attributes = validateAttributes(input.attributes, definition.requiredAttributes, definition.optionalAttributes, true);
  return attributes.ok ? { ok: true, value: Object.freeze({ schemaVersion: EXECUTION_OBSERVABILITY_SCHEMA_VERSION, name: input.name, observedAt: input.observedAt, value: input.value, attributes: attributes.value, instrument: definition.instrument, unit: definition.unit }) } : attributes;
}
