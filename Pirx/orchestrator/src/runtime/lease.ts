import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";

export type LeaseId = string & { readonly __leaseId: unique symbol };
export type LeaseOwnershipToken = string & { readonly __leaseOwnershipToken: unique symbol };
export type LeaseState = "active" | "released" | "recovered" | "uncertain";
export type LeaseRecoveryReason = "expired" | "uncertain";

export interface LeaseRecord {
  readonly id: LeaseId;
  readonly taskId: TaskId;
  readonly attemptId?: AttemptId;
  readonly workerId: string;
  readonly acquiredAt: UtcTimestamp;
  readonly renewedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly state: LeaseState;
  readonly ownershipToken: LeaseOwnershipToken;
  readonly version: number;
  readonly releasedAt?: UtcTimestamp;
  readonly recoveredAt?: UtcTimestamp;
  readonly recoveryReason?: LeaseRecoveryReason;
}

export interface LeaseAcquireInput {
  readonly id: LeaseId;
  readonly taskId: TaskId;
  readonly workerId: string;
  readonly now: UtcTimestamp;
  readonly durationMs: number;
}

export const LEASE_LIMITS = Object.freeze({
  minDurationMs: 1,
  maxDurationMs: 86_400_000,
  maxWorkerIdLength: 256,
});

export function leaseId(value: string): LeaseId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new Error("Lease ID is invalid.");
  return value as LeaseId;
}

export function leaseTimestamp(value: string): UtcTimestamp {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Lease timestamp must be canonical UTC.");
  return value as UtcTimestamp;
}

export function leaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < LEASE_LIMITS.minDurationMs || value > LEASE_LIMITS.maxDurationMs) throw new Error("Lease duration is outside the supported bounds.");
  return value;
}

export function leaseWorkerId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > LEASE_LIMITS.maxWorkerIdLength) throw new Error("Lease worker ID is invalid.");
  return normalized;
}

export function leaseExpiresAt(now: UtcTimestamp, durationMs: number): UtcTimestamp {
  leaseDuration(durationMs);
  const timestamp = Date.parse(now) + durationMs;
  if (!Number.isSafeInteger(timestamp)) throw new Error("Lease expiry is outside the supported time range.");
  return new Date(timestamp).toISOString() as UtcTimestamp;
}

export function leaseIsExpired(lease: Pick<LeaseRecord, "expiresAt">, now: UtcTimestamp): boolean {
  return Date.parse(now) >= Date.parse(lease.expiresAt);
}
