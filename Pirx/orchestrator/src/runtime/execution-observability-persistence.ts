import { createHash } from "node:crypto";

import {
  createExecutionEvent,
  createExecutionMetric,
  type ExecutionAttributes,
  type ExecutionEvent,
  type ExecutionEventInput,
  type ExecutionMetricInput,
  type ExecutionMetricPoint,
} from "./execution-observability.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import type { UtcTimestamp } from "./task-domain.js";

export const EXECUTION_OBSERVABILITY_PROJECTION_SCHEMA_VERSION = 1 as const;
export const EXECUTION_OBSERVABILITY_PROJECTION_LIMITS = Object.freeze({ sourceRows: 10_000, sourceId: 512, signalId: 256 } as const);
export type ExecutionSignalSourceKind = "task" | "attempt" | "ci" | "cooldown" | "delivery";

export interface ExecutionSignalSource {
  readonly kind: ExecutionSignalSourceKind;
  readonly id: string;
  readonly version: number;
}
export interface DurableExecutionEventInput { readonly signalId: string; readonly source: ExecutionSignalSource; readonly event: ExecutionEventInput; }
export interface DurableExecutionMetricInput { readonly signalId: string; readonly source: ExecutionSignalSource; readonly metric: ExecutionMetricInput; }
export interface ExecutionObservabilityWriteResult { readonly eventsCreated: number; readonly eventsReplayed: number; readonly metricsCreated: number; readonly metricsReplayed: number; }
export type ExecutionObservabilityProjectionResult =
  | ({ readonly outcome: "recorded" | "replayed" } & ExecutionObservabilityWriteResult)
  | { readonly outcome: "invalid_source" | "truncated" | "conflict" | "storage_error"; readonly message: string };

const SIGNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SOURCE_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;

function timestamp(value: unknown): value is UtcTimestamp { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function canonicalAttributes(attributes: ExecutionAttributes): string { return JSON.stringify(Object.fromEntries(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)))); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function identity(kind: ExecutionSignalSourceKind, parts: readonly unknown[]): string { return `obs:${kind}:${digest(parts)}`; }
function seconds(start: unknown, end: unknown): number | undefined {
  if (!timestamp(start) || !timestamp(end)) return undefined;
  const value = (Date.parse(end) - Date.parse(start)) / 1_000;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
function boundedSource(source: ExecutionSignalSource): boolean { return SOURCE_ID.test(source.id) && Number.isSafeInteger(source.version) && source.version > 0; }
function sourceError(message: string): ExecutionObservabilityProjectionResult { return { outcome: "invalid_source", message: message.slice(0, 256) }; }

export class ExecutionObservabilityRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public record(input: { readonly events: readonly DurableExecutionEventInput[]; readonly metrics: readonly DurableExecutionMetricInput[]; readonly recordedAt: UtcTimestamp }): ExecutionObservabilityProjectionResult {
    if (!timestamp(input.recordedAt)) return sourceError("Execution observability recording time is invalid.");
    const eventRows: Array<{ signalId: string; source: ExecutionSignalSource; value: ExecutionEvent; attributes: string; hash: string }> = [];
    const metricRows: Array<{ signalId: string; source: ExecutionSignalSource; value: ExecutionMetricPoint; attributes: string; hash: string }> = [];
    const ids = new Set<string>();
    for (const item of input.events) {
      if (!SIGNAL_ID.test(item.signalId) || !boundedSource(item.source) || ids.has(item.signalId)) return sourceError("Execution event identity is invalid or duplicated in the batch.");
      ids.add(item.signalId);
      const value = createExecutionEvent(item.event);
      if (!value.ok) return sourceError(value.message);
      const attributes = canonicalAttributes(value.value.attributes);
      eventRows.push({ signalId: item.signalId, source: item.source, value: value.value, attributes, hash: digest({ value: value.value, source: item.source }) });
    }
    for (const item of input.metrics) {
      if (!SIGNAL_ID.test(item.signalId) || !boundedSource(item.source) || ids.has(item.signalId)) return sourceError("Execution metric identity is invalid or duplicated in the batch.");
      ids.add(item.signalId);
      const value = createExecutionMetric(item.metric);
      if (!value.ok) return sourceError(value.message);
      const attributes = canonicalAttributes(value.value.attributes);
      metricRows.push({ signalId: item.signalId, source: item.source, value: value.value, attributes, hash: digest({ value: value.value, source: item.source }) });
    }
    const stored = this.#store.transaction((): StorageResult<ExecutionObservabilityWriteResult> => {
      let eventsCreated = 0; let eventsReplayed = 0; let metricsCreated = 0; let metricsReplayed = 0;
      try {
        for (const row of eventRows) {
          const existing = this.#store.database.prepare("SELECT content_hash FROM runtime_execution_events WHERE signal_id = ?").get(row.signalId) as { content_hash: string } | undefined;
          if (existing !== undefined) { if (existing.content_hash !== row.hash) return { outcome: "conflict", message: "Execution event identity conflicts with different content." }; eventsReplayed += 1; continue; }
          this.#store.database.prepare("INSERT INTO runtime_execution_events (signal_id, schema_version, name, occurred_at, attributes_json, source_kind, source_id, source_version, recorded_at, content_hash) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.signalId, row.value.name, row.value.occurredAt, row.attributes, row.source.kind, row.source.id, row.source.version, input.recordedAt, row.hash);
          eventsCreated += 1;
        }
        for (const row of metricRows) {
          const existing = this.#store.database.prepare("SELECT content_hash FROM runtime_execution_metrics WHERE signal_id = ?").get(row.signalId) as { content_hash: string } | undefined;
          if (existing !== undefined) { if (existing.content_hash !== row.hash) return { outcome: "conflict", message: "Execution metric identity conflicts with different content." }; metricsReplayed += 1; continue; }
          this.#store.database.prepare("INSERT INTO runtime_execution_metrics (signal_id, schema_version, name, observed_at, value, instrument, unit, attributes_json, source_kind, source_id, source_version, recorded_at, content_hash) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.signalId, row.value.name, row.value.observedAt, row.value.value, row.value.instrument, row.value.unit, row.attributes, row.source.kind, row.source.id, row.source.version, input.recordedAt, row.hash);
          metricsCreated += 1;
        }
        return { outcome: "success", value: { eventsCreated, eventsReplayed, metricsCreated, metricsReplayed } };
      } catch { return { outcome: "storage_error", message: "Execution observations could not be stored." }; }
    });
    if (stored.outcome === "conflict") return { outcome: "conflict", message: stored.message };
    if (stored.outcome !== "success") return { outcome: "storage_error", message: stored.message };
    const counts = stored.value;
    return { outcome: counts.eventsCreated + counts.metricsCreated === 0 ? "replayed" : "recorded", ...counts };
  }
}

interface ProjectionBatch { events: DurableExecutionEventInput[]; metrics: DurableExecutionMetricInput[]; }
function event(batch: ProjectionBatch, source: ExecutionSignalSource, suffix: string, value: ExecutionEventInput): void { batch.events.push({ signalId: identity(source.kind, [source.id, source.version, suffix]), source, event: value }); }
function metric(batch: ProjectionBatch, source: ExecutionSignalSource, suffix: string, value: ExecutionMetricInput): void { batch.metrics.push({ signalId: identity(source.kind, [source.id, source.version, suffix]), source, metric: value }); }

export class ExecutionObservabilityProjector {
  readonly #store: RuntimeSqliteStore;
  readonly #repository: ExecutionObservabilityRepository;
  readonly #now: () => UtcTimestamp;
  readonly #limit: number;
  public constructor(store: RuntimeSqliteStore, options: { readonly now?: () => UtcTimestamp; readonly sourceRowLimit?: number } = {}) {
    const limit = options.sourceRowLimit ?? EXECUTION_OBSERVABILITY_PROJECTION_LIMITS.sourceRows;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXECUTION_OBSERVABILITY_PROJECTION_LIMITS.sourceRows) throw new RangeError("Execution observability source-row limit is invalid.");
    this.#store = store; this.#repository = new ExecutionObservabilityRepository(store); this.#now = options.now ?? (() => new Date().toISOString() as UtcTimestamp); this.#limit = limit;
  }

  public reconcile(): ExecutionObservabilityProjectionResult {
    const batch: ProjectionBatch = { events: [], metrics: [] };
    try {
      const tasks = this.#rows("SELECT id, state, risk, github_issue_number, created_at, updated_at FROM runtime_tasks ORDER BY created_at, id LIMIT ?");
      if (!tasks.ok) return tasks.result;
      for (const row of tasks.rows) {
        if (!timestamp(row.created_at) || !timestamp(row.updated_at) || typeof row.id !== "string" || typeof row.state !== "string" || typeof row.risk !== "string") return sourceError("A Task observability source row is malformed.");
        const source = { kind: "task" as const, id: row.id, version: 1 };
        const attributes: Record<string, string | number> = { correlationId: `task:${row.id}:${row.updated_at}`, taskId: row.id, taskState: row.state, risk: row.risk };
        if (typeof row.github_issue_number === "number") attributes.issueNumber = row.github_issue_number;
        event(batch, source, `state:${row.updated_at}`, { name: "pirx.task.lifecycle", occurredAt: row.updated_at, attributes });
        metric(batch, source, `state-total:${row.updated_at}`, { name: "pirx.task.lifecycle.total", observedAt: row.updated_at, value: 1, attributes: { taskState: row.state, risk: row.risk } });
      }

      const attempts = this.#rows("SELECT a.id, a.task_id, a.ordinal, a.provider, a.state, a.result, a.started_at, a.ended_at, t.created_at AS task_created_at, t.risk, p.ended_at AS predecessor_ended_at, p.result AS predecessor_result FROM runtime_attempts a JOIN runtime_tasks t ON t.id = a.task_id LEFT JOIN runtime_attempts p ON p.task_id = a.task_id AND p.ordinal = a.ordinal - 1 ORDER BY a.started_at, a.id LIMIT ?");
      if (!attempts.ok) return attempts.result;
      for (const row of attempts.rows) {
        if (typeof row.id !== "string" || typeof row.task_id !== "string" || typeof row.provider !== "string" || typeof row.state !== "string" || !Number.isSafeInteger(row.ordinal) || !timestamp(row.started_at)) return sourceError("An Attempt observability source row is malformed.");
        const source = { kind: "attempt" as const, id: row.id, version: 1 };
        const startedAttributes = { correlationId: `attempt:${row.id}:started`, taskId: row.task_id, attemptId: row.id, attemptOrdinal: row.ordinal as number, attemptState: "running", provider: row.provider };
        event(batch, source, "started", { name: "pirx.attempt.lifecycle", occurredAt: row.started_at, attributes: startedAttributes });
        metric(batch, source, "started-total", { name: "pirx.attempt.lifecycle.total", observedAt: row.started_at, value: 1, attributes: { attemptState: "running", provider: row.provider } });
        if (row.ordinal === 1) {
          const duration = seconds(row.task_created_at, row.started_at);
          if (duration === undefined) return sourceError("Task queue timing endpoints are malformed or reversed.");
          metric(batch, source, "queue-duration", { name: "pirx.task.queue.duration", observedAt: row.started_at, value: duration, attributes: { risk: row.risk as string } });
        } else if (row.predecessor_ended_at !== null && row.predecessor_result !== null) {
          const duration = seconds(row.predecessor_ended_at, row.started_at);
          if (duration === undefined || typeof row.predecessor_result !== "string") return sourceError("Attempt retry timing endpoints are malformed or reversed.");
          metric(batch, source, "retry-wait-duration", { name: "pirx.attempt.retry.wait.duration", observedAt: row.started_at, value: duration, attributes: { provider: row.provider, previousOutcome: row.predecessor_result } });
        }
        if (row.state === "terminal") {
          if (!timestamp(row.ended_at) || typeof row.result !== "string") return sourceError("A terminal Attempt timing source is incomplete.");
          const duration = seconds(row.started_at, row.ended_at);
          if (duration === undefined) return sourceError("Attempt timing endpoints are malformed or reversed.");
          event(batch, { ...source, version: 2 }, "terminal", { name: "pirx.attempt.lifecycle", occurredAt: row.ended_at, attributes: { ...startedAttributes, attemptState: "terminal", outcome: row.result } });
          metric(batch, { ...source, version: 2 }, "terminal-total", { name: "pirx.attempt.lifecycle.total", observedAt: row.ended_at, value: 1, attributes: { attemptState: "terminal", provider: row.provider, outcome: row.result } });
          metric(batch, { ...source, version: 2 }, "duration", { name: "pirx.attempt.duration", observedAt: row.ended_at, value: duration, attributes: { provider: row.provider, outcome: row.result } });
        }
      }

      const ci = this.#rows("SELECT 'primary' AS source_table, task_id, attempt_id, provider, state, required_workflow_name, workflow_name, created_at, updated_at, version FROM runtime_ci_correlations UNION ALL SELECT 'retry' AS source_table, task_id, attempt_id, provider, state, required_workflow_name, workflow_name, created_at, updated_at, version FROM runtime_retry_ci_correlations ORDER BY created_at, attempt_id LIMIT ?");
      if (!ci.ok) return ci.result;
      for (const row of ci.rows) {
        if (typeof row.task_id !== "string" || typeof row.attempt_id !== "string" || typeof row.provider !== "string" || typeof row.state !== "string" || !timestamp(row.updated_at) || !timestamp(row.created_at) || !Number.isSafeInteger(row.version)) return sourceError("A CI observability source row is malformed.");
        const source = { kind: "ci" as const, id: `${String(row.source_table)}:${row.attempt_id}`, version: row.version as number };
        const workflowName = typeof row.workflow_name === "string" ? row.workflow_name : row.required_workflow_name;
        const attributes = { correlationId: `ci:${source.id}:${source.version}`, taskId: row.task_id, attemptId: row.attempt_id, ciProvider: row.provider, ciState: row.state, ...(typeof workflowName === "string" ? { workflowName } : {}) };
        event(batch, source, "state", { name: "pirx.ci.lifecycle", occurredAt: row.updated_at, attributes });
        metric(batch, source, "state-total", { name: "pirx.ci.lifecycle.total", observedAt: row.updated_at, value: 1, attributes: { ciProvider: row.provider, ciState: row.state, ...(typeof workflowName === "string" ? { workflowName } : {}) } });
        if (row.state !== "pending") {
          const duration = seconds(row.created_at, row.updated_at);
          if (duration === undefined) return sourceError("CI timing endpoints are malformed or reversed.");
          metric(batch, source, "duration", { name: "pirx.ci.duration", observedAt: row.updated_at, value: duration, attributes: { ciProvider: row.provider, ciState: row.state, ...(typeof workflowName === "string" ? { workflowName } : {}) } });
        }
      }

      const cooldowns = this.#rows("SELECT sequence, worker_id, provider, state, started_at, expires_at, provider_metadata_json FROM runtime_worker_availability WHERE state = 'cooldown' ORDER BY sequence LIMIT ?");
      if (!cooldowns.ok) return cooldowns.result;
      for (const row of cooldowns.rows) {
        if (!Number.isSafeInteger(row.sequence) || typeof row.worker_id !== "string" || typeof row.provider !== "string" || !timestamp(row.started_at) || !timestamp(row.expires_at)) return sourceError("A cooldown observability source row is malformed.");
        let recoverySource = "bounded_default";
        if (typeof row.provider_metadata_json === "string") { try { const parsed = JSON.parse(row.provider_metadata_json) as { source?: unknown }; if (typeof parsed.source === "string") recoverySource = parsed.source; } catch { return sourceError("Cooldown provider metadata is malformed."); } }
        const duration = seconds(row.started_at, row.expires_at);
        if (duration === undefined) return sourceError("Cooldown timing endpoints are malformed or reversed.");
        const source = { kind: "cooldown" as const, id: String(row.sequence), version: 1 };
        event(batch, source, "state", { name: "pirx.worker.cooldown", occurredAt: row.started_at, attributes: { correlationId: `cooldown:${row.sequence}`, workerId: row.worker_id, provider: row.provider, cooldownState: "started", cooldownUntil: row.expires_at, recoverySource } });
        metric(batch, source, "state-total", { name: "pirx.worker.cooldown.total", observedAt: row.started_at, value: 1, attributes: { provider: row.provider, recoverySource } });
        metric(batch, source, "duration", { name: "pirx.worker.cooldown.duration", observedAt: row.started_at, value: duration, attributes: { provider: row.provider, recoverySource } });
      }

      const deliveries = this.#rows("SELECT task_id, attempt_id, correlation_id, repository, state, created_at, updated_at, version FROM runtime_shipment_cycles ORDER BY created_at, attempt_id LIMIT ?");
      if (!deliveries.ok) return deliveries.result;
      for (const row of deliveries.rows) {
        if (typeof row.task_id !== "string" || typeof row.attempt_id !== "string" || typeof row.correlation_id !== "string" || typeof row.repository !== "string" || typeof row.state !== "string" || !timestamp(row.created_at) || !timestamp(row.updated_at) || !Number.isSafeInteger(row.version)) return sourceError("A delivery observability source row is malformed.");
        const duration = seconds(row.created_at, row.updated_at);
        if (duration === undefined) return sourceError("Delivery timing endpoints are malformed or reversed.");
        const source = { kind: "delivery" as const, id: row.attempt_id, version: row.version as number };
        event(batch, source, "state", { name: "pirx.delivery.lifecycle", occurredAt: row.updated_at, attributes: { correlationId: row.correlation_id, releaseId: `shipment:${row.attempt_id}`, repository: row.repository, deliveryState: row.state, environment: "integration" } });
        metric(batch, source, "state-total", { name: "pirx.delivery.lifecycle.total", observedAt: row.updated_at, value: 1, attributes: { deliveryState: row.state, environment: "integration" } });
        metric(batch, source, "duration", { name: "pirx.delivery.duration", observedAt: row.updated_at, value: duration, attributes: { deliveryState: row.state, environment: "integration" } });
      }
      return this.#repository.record({ events: batch.events, metrics: batch.metrics, recordedAt: this.#now() });
    } catch { return { outcome: "storage_error", message: "Execution observability projection failed." }; }
  }

  #rows(sql: string): { readonly ok: true; readonly rows: Record<string, unknown>[] } | { readonly ok: false; readonly result: ExecutionObservabilityProjectionResult } {
    try {
      const rows = this.#store.database.prepare(sql).all(this.#limit + 1) as Record<string, unknown>[];
      return rows.length > this.#limit ? { ok: false, result: { outcome: "truncated", message: "Execution observability source scan exceeded its bound." } } : { ok: true, rows };
    } catch { return { ok: false, result: { outcome: "storage_error", message: "Execution observability source scan failed." } }; }
  }
}
