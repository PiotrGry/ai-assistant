import type { WorkerFailureDiagnostic } from "./worker-diagnostic.js";
import {
  normalizeWorkerAvailabilityInput,
  normalizeWorkerProviderRecoveryMetadata,
  type WorkerAvailabilityInput,
  type WorkerProviderRecoveryMetadata,
} from "./worker-availability.js";
import type { UtcTimestamp } from "./task-domain.js";

export const WORKER_RECOVERY_POLICY_LIMITS = Object.freeze({
  minimumCooldownMs: 1_000,
  defaultCooldownMs: 60 * 60 * 1_000,
  maximumCooldownMs: 24 * 60 * 60 * 1_000,
} as const);

export interface WorkerRecoveryPolicy {
  readonly defaultCooldownMs: number;
  readonly maximumCooldownMs: number;
}

export interface WorkerQuotaRecoveryInput {
  readonly workerId: string;
  readonly provider: string;
  readonly observedAt: UtcTimestamp;
  readonly diagnostic: WorkerFailureDiagnostic;
  readonly policy?: WorkerRecoveryPolicy;
}

function canonicalTimestamp(value: unknown): UtcTimestamp | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && !Number.isNaN(Date.parse(value)) ? value as UtcTimestamp : undefined;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : undefined;
}

function policy(value: WorkerRecoveryPolicy | undefined): WorkerRecoveryPolicy {
  const result = value ?? WORKER_RECOVERY_POLICY_LIMITS;
  if (!Number.isSafeInteger(result.defaultCooldownMs) || result.defaultCooldownMs < WORKER_RECOVERY_POLICY_LIMITS.minimumCooldownMs || !Number.isSafeInteger(result.maximumCooldownMs) || result.maximumCooldownMs < result.defaultCooldownMs || result.maximumCooldownMs > WORKER_RECOVERY_POLICY_LIMITS.maximumCooldownMs) throw new RangeError("Worker recovery policy is invalid.");
  return Object.freeze({ defaultCooldownMs: result.defaultCooldownMs, maximumCooldownMs: result.maximumCooldownMs });
}

/**
 * Reads only explicit structured provider fields. Human-readable stderr is
 * deliberately excluded because relative reset text is ambiguous across
 * dates, locales and time zones.
 */
export function extractProviderRecoveryMetadata(value: unknown): WorkerProviderRecoveryMetadata | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const resetAt = canonicalTimestamp(record.reset_at ?? record.resetAt);
  const retryAfterValue = record.retry_after_ms ?? record.retryAfterMs;
  const retryAfterMs = Number.isSafeInteger(retryAfterValue) && (retryAfterValue as number) > 0 && (retryAfterValue as number) <= 7 * 24 * 60 * 60 * 1_000 ? retryAfterValue as number : undefined;
  if (resetAt === undefined && retryAfterMs === undefined) return undefined;
  const quotaBucket = boundedText(record.quota_bucket ?? record.quotaBucket);
  const providerStatusCode = boundedText(record.status_code ?? record.providerStatusCode);
  const metadata: WorkerProviderRecoveryMetadata = {
    source: resetAt === undefined ? "provider_retry_after" : "provider_reset",
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(quotaBucket === undefined ? {} : { quotaBucket }),
    ...(providerStatusCode === undefined ? {} : { providerStatusCode }),
  };
  try {
    return normalizeWorkerProviderRecoveryMetadata(metadata);
  } catch { return undefined; }
}

export function quotaCooldownFromDiagnostic(input: WorkerQuotaRecoveryInput): WorkerAvailabilityInput | undefined {
  if (input.diagnostic.code !== "quota_exhausted") return undefined;
  const normalizedPolicy = policy(input.policy);
  const observedAtMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAtMs)) throw new RangeError("Worker quota observation timestamp is invalid.");
  const recovery = input.diagnostic.providerRecovery;
  let durationMs = normalizedPolicy.defaultCooldownMs;
  let source: WorkerProviderRecoveryMetadata["source"] = "bounded_default";
  if (recovery?.source === "provider_reset" && recovery.resetAt !== undefined) {
    const resetDuration = Date.parse(recovery.resetAt) - observedAtMs;
    if (resetDuration >= WORKER_RECOVERY_POLICY_LIMITS.minimumCooldownMs && resetDuration <= normalizedPolicy.maximumCooldownMs) {
      durationMs = resetDuration;
      source = "provider_reset";
    }
  } else if (recovery?.source === "provider_retry_after" && recovery.retryAfterMs !== undefined && recovery.retryAfterMs >= WORKER_RECOVERY_POLICY_LIMITS.minimumCooldownMs && recovery.retryAfterMs <= normalizedPolicy.maximumCooldownMs) {
    durationMs = recovery.retryAfterMs;
    source = "provider_retry_after";
  }
  const expiresAt = new Date(observedAtMs + durationMs).toISOString() as UtcTimestamp;
  const providerMetadata: WorkerProviderRecoveryMetadata = {
    source,
    ...(source === "provider_retry_after" ? { retryAfterMs: durationMs } : {}),
    ...(source === "provider_reset" ? { resetAt: expiresAt } : {}),
    ...(recovery?.quotaBucket === undefined ? {} : { quotaBucket: recovery.quotaBucket }),
    ...(recovery?.providerStatusCode === undefined ? {} : { providerStatusCode: recovery.providerStatusCode }),
  };
  return normalizeWorkerAvailabilityInput({ workerId: input.workerId, provider: input.provider, state: "cooldown", startedAt: input.observedAt, expiresAt, reason: input.diagnostic.message, providerMetadata });
}
