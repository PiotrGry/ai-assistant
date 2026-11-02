import {
  EXECUTION_METRIC_NAMES,
  type ExecutionAttributes,
  type ExecutionEventName,
  type ExecutionMetricName,
} from "./execution-observability.js";
import type { RuntimeSqliteStore } from "./sqlite.js";
import type { UtcTimestamp } from "./task-domain.js";

export const EXECUTION_REPORT_SCHEMA_VERSION = 1 as const;
export const EXECUTION_REPORT_LIMITS = Object.freeze({
  recentEventsDefault: 20,
  recentEventsMaximum: 50,
  sourceRowsDefault: 5_000,
  sourceRowsMaximum: 10_000,
  failurePatternsMaximum: 20,
  windowDaysMaximum: 180,
} as const);

export type ExecutionDurationMetricName = Extract<ExecutionMetricName,
  | "pirx.task.queue.duration"
  | "pirx.attempt.duration"
  | "pirx.attempt.retry.wait.duration"
  | "pirx.ci.duration"
  | "pirx.worker.cooldown.duration"
  | "pirx.delivery.duration"
>;

export const EXECUTION_DURATION_METRIC_NAMES = Object.freeze(EXECUTION_METRIC_NAMES.filter((name): name is ExecutionDurationMetricName => name.endsWith(".duration")));

export interface ExecutionReportQuery {
  readonly from: UtcTimestamp;
  readonly to: UtcTimestamp;
  readonly recentEventLimit?: number;
  readonly sourceRowLimit?: number;
}

export interface ExecutionReportRecentEvent {
  readonly name: ExecutionEventName;
  readonly occurredAt: UtcTimestamp;
  readonly attributes: ExecutionAttributes;
}

export interface ExecutionLatencySummary {
  readonly name: ExecutionDurationMetricName;
  readonly count: number;
  readonly minimumSeconds: number;
  readonly averageSeconds: number;
  readonly p50Seconds: number;
  readonly p95Seconds: number;
  readonly maximumSeconds: number;
}

export interface ExecutionFailurePattern {
  readonly kind: "attempt" | "ci";
  readonly outcome: string;
  readonly provider: string;
  readonly workflowName?: string;
  readonly count: number;
  readonly lastObservedAt: UtcTimestamp;
}

export interface ExecutionReport {
  readonly schemaVersion: typeof EXECUTION_REPORT_SCHEMA_VERSION;
  readonly window: { readonly from: UtcTimestamp; readonly to: UtcTimestamp };
  readonly coverage: {
    readonly eventsAvailable: number;
    readonly eventsScanned: number;
    readonly metricsAvailable: number;
    readonly metricsScanned: number;
  };
  readonly partial: boolean;
  readonly notices: readonly string[];
  readonly recentEvents: readonly ExecutionReportRecentEvent[];
  readonly latency: readonly ExecutionLatencySummary[];
  readonly repeatedFailures: readonly ExecutionFailurePattern[];
}

export type ExecutionReportResult =
  | { readonly outcome: "success"; readonly report: ExecutionReport }
  | { readonly outcome: "invalid_request" | "invalid_data" | "storage_error"; readonly message: string };

type EventRow = { name: unknown; occurred_at: unknown; attributes_json: unknown };
type MetricRow = { name: unknown; observed_at: unknown; value: unknown; attributes_json: unknown };

const EVENT_NAMES = new Set<string>(["pirx.task.lifecycle", "pirx.attempt.lifecycle", "pirx.ci.lifecycle", "pirx.worker.cooldown", "pirx.delivery.lifecycle"]);
const DURATION_NAMES = new Set<string>(EXECUTION_DURATION_METRIC_NAMES);
const ATTEMPT_SUCCESS = new Set(["CODE_PUSHED"]);
const CI_NON_FAILURE = new Set(["pending", "success"]);

function canonicalTimestamp(value: unknown): value is UtcTimestamp {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function attributes(value: unknown): ExecutionAttributes | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed);
    if (entries.length > 16) return undefined;
    for (const [name, item] of entries) {
      if (name.length === 0 || name.length > 64 || (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")) return undefined;
    }
    return Object.freeze({ ...(parsed as Record<string, string | number | boolean>) });
  } catch {
    return undefined;
  }
}

function rounded(value: number): number { return Number(value.toFixed(3)); }
function percentile(sorted: readonly number[], fraction: number): number { return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!; }

export class ExecutionObservabilityQueryService {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public query(input: ExecutionReportQuery): ExecutionReportResult {
    if (!canonicalTimestamp(input.from) || !canonicalTimestamp(input.to)) return { outcome: "invalid_request", message: "Execution report window must use canonical UTC timestamps." };
    const fromMs = Date.parse(input.from); const toMs = Date.parse(input.to);
    if (fromMs > toMs || toMs - fromMs > EXECUTION_REPORT_LIMITS.windowDaysMaximum * 86_400_000) return { outcome: "invalid_request", message: "Execution report window is reversed or exceeds 180 days." };
    const recentLimit = input.recentEventLimit ?? EXECUTION_REPORT_LIMITS.recentEventsDefault;
    const sourceLimit = input.sourceRowLimit ?? EXECUTION_REPORT_LIMITS.sourceRowsDefault;
    if (!positiveInteger(recentLimit, EXECUTION_REPORT_LIMITS.recentEventsMaximum) || !positiveInteger(sourceLimit, EXECUTION_REPORT_LIMITS.sourceRowsMaximum)) return { outcome: "invalid_request", message: "Execution report limits are outside their bounded range." };

    try {
      const eventCount = this.#count("runtime_execution_events", "occurred_at", input.from, input.to);
      const metricCount = this.#count("runtime_execution_metrics", "observed_at", input.from, input.to);
      const eventRows = this.#store.database.prepare("SELECT name, occurred_at, attributes_json FROM runtime_execution_events WHERE occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at DESC, signal_id DESC LIMIT ?").all(input.from, input.to, sourceLimit) as EventRow[];
      const metricRows = this.#store.database.prepare("SELECT name, observed_at, value, attributes_json FROM runtime_execution_metrics WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at DESC, signal_id DESC LIMIT ?").all(input.from, input.to, sourceLimit) as MetricRow[];
      const parsedEvents: ExecutionReportRecentEvent[] = [];
      for (const row of eventRows) {
        const parsedAttributes = attributes(row.attributes_json);
        if (typeof row.name !== "string" || !EVENT_NAMES.has(row.name) || !canonicalTimestamp(row.occurred_at) || parsedAttributes === undefined) return { outcome: "invalid_data", message: "A stored execution event is malformed." };
        if (parsedEvents.length < recentLimit) parsedEvents.push({ name: row.name as ExecutionEventName, occurredAt: row.occurred_at, attributes: parsedAttributes });
      }

      const durations = new Map<ExecutionDurationMetricName, number[]>();
      const failures = new Map<string, ExecutionFailurePattern>();
      for (const row of metricRows) {
        const parsedAttributes = attributes(row.attributes_json);
        if (typeof row.name !== "string" || !canonicalTimestamp(row.observed_at) || typeof row.value !== "number" || !Number.isFinite(row.value) || row.value < 0 || parsedAttributes === undefined) return { outcome: "invalid_data", message: "A stored execution metric is malformed." };
        if (DURATION_NAMES.has(row.name)) {
          const name = row.name as ExecutionDurationMetricName;
          const values = durations.get(name) ?? []; values.push(row.value); durations.set(name, values);
        }
        const pattern = this.#failurePattern(row.name, row.observed_at, row.value, parsedAttributes);
        if (pattern !== undefined) {
          const key = [pattern.kind, pattern.provider, pattern.outcome, pattern.workflowName ?? ""].join("\u0000");
          const current = failures.get(key);
          failures.set(key, current === undefined ? pattern : { ...current, count: current.count + pattern.count, lastObservedAt: current.lastObservedAt > pattern.lastObservedAt ? current.lastObservedAt : pattern.lastObservedAt });
        }
      }

      const latency = EXECUTION_DURATION_METRIC_NAMES.flatMap((name): ExecutionLatencySummary[] => {
        const values = durations.get(name); if (values === undefined || values.length === 0) return [];
        values.sort((left, right) => left - right);
        return [{ name, count: values.length, minimumSeconds: rounded(values[0]!), averageSeconds: rounded(values.reduce((sum, value) => sum + value, 0) / values.length), p50Seconds: rounded(percentile(values, 0.5)), p95Seconds: rounded(percentile(values, 0.95)), maximumSeconds: rounded(values[values.length - 1]!) }];
      });
      const repeatedFailures = [...failures.values()].filter((item) => item.count >= 2).sort((left, right) => right.count - left.count || right.lastObservedAt.localeCompare(left.lastObservedAt) || left.kind.localeCompare(right.kind) || left.outcome.localeCompare(right.outcome)).slice(0, EXECUTION_REPORT_LIMITS.failurePatternsMaximum);
      const partial = eventCount > eventRows.length || metricCount > metricRows.length;
      const notices: string[] = [];
      if (eventCount === 0 && metricCount === 0) notices.push("no_data");
      if (eventCount > eventRows.length) notices.push("events_truncated");
      if (metricCount > metricRows.length) notices.push("metrics_truncated");
      for (const name of EXECUTION_DURATION_METRIC_NAMES) if (!durations.has(name)) notices.push(`missing:${name}`);
      return { outcome: "success", report: { schemaVersion: EXECUTION_REPORT_SCHEMA_VERSION, window: { from: input.from, to: input.to }, coverage: { eventsAvailable: eventCount, eventsScanned: eventRows.length, metricsAvailable: metricCount, metricsScanned: metricRows.length }, partial, notices, recentEvents: parsedEvents, latency, repeatedFailures } };
    } catch {
      return { outcome: "storage_error", message: "Execution observations could not be queried." };
    }
  }

  #count(table: "runtime_execution_events" | "runtime_execution_metrics", column: "occurred_at" | "observed_at", from: UtcTimestamp, to: UtcTimestamp): number {
    const row = this.#store.database.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE ${column} >= ? AND ${column} <= ?`).get(from, to) as { value: number };
    return row.value;
  }

  #failurePattern(name: string, observedAt: UtcTimestamp, value: number, values: ExecutionAttributes): ExecutionFailurePattern | undefined {
    if (name === "pirx.attempt.lifecycle.total" && values.attemptState === "terminal" && typeof values.provider === "string" && typeof values.outcome === "string" && !ATTEMPT_SUCCESS.has(values.outcome)) return { kind: "attempt", provider: values.provider, outcome: values.outcome, count: value, lastObservedAt: observedAt };
    if (name === "pirx.ci.lifecycle.total" && typeof values.ciProvider === "string" && typeof values.ciState === "string" && !CI_NON_FAILURE.has(values.ciState)) return { kind: "ci", provider: values.ciProvider, outcome: values.ciState, ...(typeof values.workflowName === "string" ? { workflowName: values.workflowName } : {}), count: value, lastObservedAt: observedAt };
    return undefined;
  }
}
