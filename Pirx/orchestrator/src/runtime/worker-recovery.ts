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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The rate_limit_info Claude Code attaches when a limit rejects a request: on
 * a stream-json rate_limit_event, or under apiErrorParams on the synthetic
 * assistant error. An "allowed" window is not a limit.
 */
function rejectedRateLimit(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const info = record.rate_limit_info ?? (isRecord(record.apiErrorParams) ? record.apiErrorParams.rate_limit_info : undefined);
  return isRecord(info) && info.status === "rejected" ? info : undefined;
}

export function hasRejectedRateLimit(value: unknown): boolean {
  return isRecord(value) && rejectedRateLimit(value) !== undefined;
}

function unixSecondsTimestamp(value: unknown): UtcTimestamp | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) < 10_000_000_000 ? new Date((value as number) * 1_000).toISOString() as UtcTimestamp : undefined;
}

/** Reads only explicit structured provider fields; limit text goes through resetAtFromLimitText. */
export function extractProviderRecoveryMetadata(value: unknown): WorkerProviderRecoveryMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  const limit = rejectedRateLimit(record);
  const resetAt = canonicalTimestamp(record.reset_at ?? record.resetAt) ?? unixSecondsTimestamp(limit?.resetsAt);
  const retryAfterValue = record.retry_after_ms ?? record.retryAfterMs;
  const retryAfterMs = Number.isSafeInteger(retryAfterValue) && (retryAfterValue as number) > 0 && (retryAfterValue as number) <= 7 * 24 * 60 * 60 * 1_000 ? retryAfterValue as number : undefined;
  if (resetAt === undefined && retryAfterMs === undefined) return undefined;
  const quotaBucket = boundedText(record.quota_bucket ?? record.quotaBucket ?? limit?.rateLimitType);
  const providerStatusCode = boundedText(record.status_code ?? record.providerStatusCode ?? (Number.isSafeInteger(record.apiErrorStatus) ? String(record.apiErrorStatus) : undefined));
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

const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1_000;
// Real Claude Code text: "You've hit your 5-hour limit · resets 4:10pm (Europe/Warsaw)"; older builds say "session limit".
const FIVE_HOUR_LIMIT_TEXT = /\bhit your (?:session|5-hour) limit\b[^\n]*?\bresets (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^()\s]+)\))?/iu;

/**
 * The reset of a 5-hour limit from Claude Code's own text: the next time the
 * named local time occurs, in the zone the text names or else the operator
 * zone. A 5-hour window resets within 5 hours, so a time further ahead, a
 * weekly limit or an unknown zone yields nothing rather than a guess.
 */
export function resetAtFromLimitText(text: string, nowMs: number, operatorTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): WorkerProviderRecoveryMetadata | undefined {
  const match = FIVE_HOUR_LIMIT_TEXT.exec(text);
  if (match === null) return undefined;
  const hour12 = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (match[3]?.toLowerCase() === "pm" ? 12 : 0);
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-US", { timeZone: match[4] ?? operatorTimeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); }
  catch { return undefined; } // an unknown zone name
  const wall = (instant: number): Record<string, number> => Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, Number(part.value)]));
  const offset = (instant: number): number => {
    const parts = wall(instant);
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(instant / 1_000) * 1_000;
  };
  const today = wall(nowMs);
  for (let day = 0; day <= 1; day += 1) {
    const local = Date.UTC(today.year!, today.month! - 1, today.day! + day, hour, minute);
    const instant = local - offset(local - offset(local)); // second pass settles a DST change between guess and answer
    if (instant > nowMs && instant - nowMs <= FIVE_HOUR_WINDOW_MS + 60_000) return normalizeWorkerProviderRecoveryMetadata({ source: "provider_reset", resetAt: new Date(instant).toISOString() as UtcTimestamp, quotaBucket: "five_hour" });
  }
  return undefined;
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
