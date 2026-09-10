import { randomUUID } from "node:crypto";

import {
  failure,
  type GitHubFailure,
  type GitHubOperationResult,
  type GitHubRemoteOutcome,
} from "./outcome.js";

export type GitHubRetryOperation = "read" | "write";

export type GitHubRetryReason =
  | "success"
  | "cancelled"
  | "non_retryable_outcome"
  | "write_not_idempotent"
  | "unknown_write_outcome"
  | "primary_rate_limit"
  | "secondary_retry_after"
  | "bounded_backoff"
  | "malformed_rate_limit_metadata"
  | "max_attempts_exhausted"
  | "total_delay_bound_exhausted";

export interface GitHubRetryPolicyOptions {
  readonly maxAttempts?: number;
  readonly maxTotalDelayMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterRatio?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal | undefined) => Promise<void>;
}

export interface GitHubRetryExecutionContext {
  readonly attempt: number;
  readonly signal?: AbortSignal;
}

export interface GitHubRetryRequest<T> {
  readonly operation: GitHubRetryOperation;
  readonly idempotent?: boolean;
  readonly correlationId?: string;
  readonly signal?: AbortSignal;
  readonly execute: (context: GitHubRetryExecutionContext) => Promise<GitHubOperationResult<T>>;
}

export interface GitHubRetryDecision<T> {
  readonly attempts: number;
  readonly nextEligibleAt?: number;
  readonly reason: GitHubRetryReason;
  readonly finalOutcome: GitHubOperationResult<T>;
}

const DEFAULTS = {
  maxAttempts: 3,
  maxTotalDelayMs: 30_000,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.2,
} as const;

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive.`);
  }
}

function cancelled(correlationId: string): GitHubFailure {
  return failure("permanent_error", "cancelled", "GitHub operation was cancelled.", correlationId, "unknown");
}

function defaultSleep(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("GitHub retry was cancelled.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("GitHub retry was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function canRetry<T>(result: GitHubOperationResult<T>, request: GitHubRetryRequest<T>): { readonly retry: boolean; readonly reason: GitHubRetryReason } {
  if (result.outcome === "success") {
    return { retry: false, reason: "success" };
  }
  if (result.outcome === "unknown") {
    return { retry: false, reason: request.operation === "write" ? "unknown_write_outcome" : "non_retryable_outcome" };
  }
  if (result.outcome !== "rate_limited" && result.outcome !== "retryable_error") {
    return { retry: false, reason: "non_retryable_outcome" };
  }
  if (request.operation === "read") {
    return { retry: true, reason: "bounded_backoff" };
  }
  if (request.idempotent !== true) {
    return { retry: false, reason: "write_not_idempotent" };
  }
  if (result.remoteOutcome !== "not_accepted") {
    return { retry: false, reason: "unknown_write_outcome" };
  }
  return { retry: true, reason: "bounded_backoff" };
}

function retryDelay<T>(
  result: GitHubOperationResult<T>,
  attempt: number,
  now: number,
  options: Required<Pick<GitHubRetryPolicyOptions, "baseDelayMs" | "maxDelayMs" | "jitterRatio">>,
  random: () => number,
): { readonly delayMs: number; readonly nextEligibleAt?: number; readonly reason: GitHubRetryReason } {
  const rate = result.outcome === "rate_limited" ? result.response?.rateLimit : undefined;
  if (rate?.remaining === 0 && rate.resetAt !== undefined && rate.resetAt > now) {
    return { delayMs: rate.resetAt - now, nextEligibleAt: rate.resetAt, reason: "primary_rate_limit" };
  }
  if (rate?.retryAfterMs !== undefined && rate.retryAfterMs > 0) {
    return { delayMs: rate.retryAfterMs, nextEligibleAt: now + rate.retryAfterMs, reason: "secondary_retry_after" };
  }
  const exponent = Math.min(attempt - 1, 30);
  const raw = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** exponent);
  const jitter = options.jitterRatio === 0 ? 1 : 1 + (Math.min(1, Math.max(0, random())) * 2 - 1) * options.jitterRatio;
  const delayMs = Math.max(1, Math.min(options.maxDelayMs, Math.round(raw * jitter)));
  const reason = rate?.warnings !== undefined && rate.warnings.length > 0 ? "malformed_rate_limit_metadata" : "bounded_backoff";
  return { delayMs, nextEligibleAt: now + delayMs, reason };
}

/**
 * Bounded retry/defer policy for GitHub reads and safe idempotent writes.
 * Defaults: at most 3 attempts, at most 30 seconds of total waiting, 500 ms
 * capped exponential backoff up to 10 seconds, with 20% jitter. The policy
 * never retries unknown mutation outcomes and never owns scheduler cooldown.
 */
export async function executeWithGitHubRetry<T>(
  request: GitHubRetryRequest<T>,
  options: GitHubRetryPolicyOptions = {},
): Promise<GitHubRetryDecision<T>> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const maxTotalDelayMs = options.maxTotalDelayMs ?? DEFAULTS.maxTotalDelayMs;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const jitterRatio = options.jitterRatio ?? DEFAULTS.jitterRatio;
  positiveInteger(maxAttempts, "maxAttempts");
  positiveFinite(maxTotalDelayMs, "maxTotalDelayMs");
  positiveFinite(baseDelayMs, "baseDelayMs");
  positiveFinite(maxDelayMs, "maxDelayMs");
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError("jitterRatio must be between 0 and 1.");
  }
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const correlationId = request.correlationId ?? randomUUID();
  let attempts = 0;
  let totalDelayMs = 0;

  while (attempts < maxAttempts) {
    if (request.signal?.aborted === true) {
      return { attempts, reason: "cancelled", finalOutcome: cancelled(correlationId) };
    }
    attempts += 1;
    let result: GitHubOperationResult<T>;
    try {
      result = await request.execute(
        request.signal === undefined
          ? { attempt: attempts }
          : { attempt: attempts, signal: request.signal },
      );
    } catch {
      const remoteOutcome: GitHubRemoteOutcome = request.operation === "write" ? "unknown" : "not_accepted";
      result = failure(request.operation === "write" ? "unknown" : "retryable_error", "network", "GitHub operation failed without a normalized result.", correlationId, remoteOutcome);
    }
    if (result.outcome === "success") {
      return { attempts, reason: "success", finalOutcome: result };
    }
    if (result.outcome === "permanent_error" && result.error.code === "cancelled") {
      return { attempts, reason: "cancelled", finalOutcome: result };
    }
    const retry = canRetry(result, request);
    if (!retry.retry) {
      return { attempts, reason: retry.reason, finalOutcome: result };
    }
    if (attempts >= maxAttempts) {
      return { attempts, reason: "max_attempts_exhausted", finalOutcome: result };
    }
    const scheduled = retryDelay(result, attempts, now(), { baseDelayMs, maxDelayMs, jitterRatio }, random);
    const remainingBudget = maxTotalDelayMs - totalDelayMs;
    if (scheduled.delayMs > remainingBudget) {
      return {
        attempts,
        ...(scheduled.nextEligibleAt === undefined ? {} : { nextEligibleAt: scheduled.nextEligibleAt }),
        reason: "total_delay_bound_exhausted",
        finalOutcome: result,
      };
    }
    totalDelayMs += scheduled.delayMs;
    try {
      await sleep(scheduled.delayMs, request.signal);
    } catch {
      return { attempts, reason: "cancelled", finalOutcome: cancelled(correlationId) };
    }
  }

  throw new Error("GitHub retry policy reached an invalid terminal state.");
}
