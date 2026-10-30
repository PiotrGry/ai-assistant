import type { UtcTimestamp } from "./task-domain.js";

export const WORKER_AVAILABILITY_SCHEMA_VERSION = 1 as const;
export const WORKER_AVAILABILITY_STATES = Object.freeze(["available", "unavailable", "cooldown", "unknown"] as const);
export const WORKER_RECOVERY_SOURCES = Object.freeze(["provider_retry_after", "provider_reset", "bounded_default", "manual"] as const);
export const WORKER_AVAILABILITY_LIMITS = Object.freeze({
  identity: 128,
  reason: 512,
  metadataValue: 256,
  maximumRetryAfterMs: 7 * 24 * 60 * 60 * 1_000,
} as const);

export type WorkerAvailabilityState = (typeof WORKER_AVAILABILITY_STATES)[number];
export type WorkerRecoverySource = (typeof WORKER_RECOVERY_SOURCES)[number];

export interface WorkerProviderRecoveryMetadata {
  readonly source: WorkerRecoverySource;
  readonly retryAfterMs?: number;
  readonly resetAt?: UtcTimestamp;
  readonly quotaBucket?: string;
  readonly providerStatusCode?: string;
}

export interface WorkerAvailabilityInput {
  readonly workerId: string;
  readonly provider: string;
  readonly state: WorkerAvailabilityState;
  readonly startedAt: UtcTimestamp;
  readonly expiresAt?: UtcTimestamp;
  readonly reason?: string;
  readonly providerMetadata?: WorkerProviderRecoveryMetadata;
}

export interface WorkerAvailabilityRecord extends WorkerAvailabilityInput {
  readonly schemaVersion: typeof WORKER_AVAILABILITY_SCHEMA_VERSION;
  readonly sequence: number;
}

export interface WorkerAvailabilityEvaluation {
  readonly workerId: string;
  readonly provider: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly recordedState: WorkerAvailabilityState | "missing";
  readonly evaluatedAt: UtcTimestamp;
  readonly cooldownUntil?: UtcTimestamp;
  readonly reason?: string;
  readonly record?: WorkerAvailabilityRecord;
}

function timestamp(value: unknown, label: string): UtcTimestamp {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value as UtcTimestamp;
}

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > WORKER_AVAILABILITY_LIMITS.identity || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

export function normalizeWorkerProviderRecoveryMetadata(value: WorkerProviderRecoveryMetadata | undefined): WorkerProviderRecoveryMetadata | undefined {
  if (value === undefined) return undefined;
  if (!WORKER_RECOVERY_SOURCES.includes(value.source)) throw new Error("Worker recovery metadata source is invalid.");
  if (value.retryAfterMs !== undefined && (!Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs <= 0 || value.retryAfterMs > WORKER_AVAILABILITY_LIMITS.maximumRetryAfterMs)) throw new Error("Worker retry-after duration is invalid.");
  const resetAt = value.resetAt === undefined ? undefined : timestamp(value.resetAt, "Worker provider reset timestamp");
  const quotaBucket = value.quotaBucket === undefined ? undefined : bounded(value.quotaBucket, "Worker quota bucket", WORKER_AVAILABILITY_LIMITS.metadataValue);
  const providerStatusCode = value.providerStatusCode === undefined ? undefined : bounded(value.providerStatusCode, "Worker provider status code", WORKER_AVAILABILITY_LIMITS.metadataValue);
  return Object.freeze({
    source: value.source,
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: value.retryAfterMs }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(quotaBucket === undefined ? {} : { quotaBucket }),
    ...(providerStatusCode === undefined ? {} : { providerStatusCode }),
  });
}

export function normalizeWorkerAvailabilityInput(value: WorkerAvailabilityInput): WorkerAvailabilityInput {
  if (!WORKER_AVAILABILITY_STATES.includes(value.state)) throw new Error("Worker availability state is invalid.");
  const startedAt = timestamp(value.startedAt, "Worker availability start timestamp");
  const expiresAt = value.expiresAt === undefined ? undefined : timestamp(value.expiresAt, "Worker availability expiry timestamp");
  const reason = value.reason === undefined ? undefined : bounded(value.reason, "Worker availability reason", WORKER_AVAILABILITY_LIMITS.reason);
  const providerMetadata = normalizeWorkerProviderRecoveryMetadata(value.providerMetadata);
  if (value.state === "cooldown") {
    if (expiresAt === undefined || reason === undefined || Date.parse(expiresAt) <= Date.parse(startedAt)) throw new Error("Worker cooldown requires a future expiry and reason.");
  } else if (expiresAt !== undefined) {
    throw new Error("Only a Worker cooldown may have an expiry timestamp.");
  }
  if ((value.state === "unavailable" || value.state === "unknown") && reason === undefined) throw new Error("Unavailable or unknown Worker state requires a reason.");
  if (providerMetadata?.resetAt !== undefined && expiresAt !== undefined && Date.parse(providerMetadata.resetAt) > Date.parse(expiresAt)) throw new Error("Provider reset timestamp must not be later than cooldown expiry.");
  return Object.freeze({
    workerId: identity(value.workerId, "Worker ID"),
    provider: identity(value.provider, "Worker provider"),
    state: value.state,
    startedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(reason === undefined ? {} : { reason }),
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
  });
}

export function validateWorkerAvailabilityRecord(value: WorkerAvailabilityRecord): boolean {
  try {
    const normalized = normalizeWorkerAvailabilityInput(value);
    return value.schemaVersion === WORKER_AVAILABILITY_SCHEMA_VERSION && Number.isSafeInteger(value.sequence) && value.sequence > 0 && JSON.stringify(normalized) === JSON.stringify({ workerId: value.workerId, provider: value.provider, state: value.state, startedAt: value.startedAt, ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }), ...(value.reason === undefined ? {} : { reason: value.reason }), ...(value.providerMetadata === undefined ? {} : { providerMetadata: value.providerMetadata }) });
  } catch {
    return false;
  }
}

export function evaluateWorkerAvailability(record: WorkerAvailabilityRecord | undefined, evaluatedAtValue: UtcTimestamp, identityValue?: { readonly workerId: string; readonly provider: string }): WorkerAvailabilityEvaluation {
  const evaluatedAt = timestamp(evaluatedAtValue, "Worker availability evaluation timestamp");
  if (record === undefined) {
    if (identityValue === undefined) throw new Error("Worker availability identity is required when no record exists.");
    return Object.freeze({ workerId: identity(identityValue.workerId, "Worker ID"), provider: identity(identityValue.provider, "Worker provider"), availability: "unknown", recordedState: "missing", evaluatedAt, reason: "No durable Worker availability state has been recorded." });
  }
  if (!validateWorkerAvailabilityRecord(record)) throw new Error("Worker availability record is invalid.");
  if (record.state === "cooldown") {
    const active = Date.parse(evaluatedAt) < Date.parse(record.expiresAt!);
    return Object.freeze({ workerId: record.workerId, provider: record.provider, availability: active ? "unavailable" : "available", recordedState: record.state, evaluatedAt, ...(active ? { cooldownUntil: record.expiresAt } : {}), reason: active ? (record.reason ?? "Worker cooldown is active.") : "Worker cooldown has expired.", record });
  }
  return Object.freeze({ workerId: record.workerId, provider: record.provider, availability: record.state, recordedState: record.state, evaluatedAt, ...(record.reason === undefined ? {} : { reason: record.reason }), record });
}
