import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";
import type { LeaseAcquireInput, LeaseId, LeaseRecord } from "./lease.js";
import type { RunnableTaskCandidate, TaskSelectionRequest, TaskSelectionResult } from "./task-selection.js";

export type SchedulerPortResult<T> =
  | { readonly outcome: "success"; readonly value: T }
  | { readonly outcome: "conflict" | "unavailable" | "failed" | "unknown"; readonly reason: string };

export interface SchedulerClock {
  now(): UtcTimestamp;
}

export interface SchedulerSelectionPort {
  select(request: TaskSelectionRequest): TaskSelectionResult;
}

export type WorkerAvailability = "available" | "unavailable" | "unknown";
export interface SchedulerWorkerPort {
  check(candidate: RunnableTaskCandidate, workerId: string): SchedulerPortResult<WorkerAvailability>;
}

export interface SchedulerAuthorizationRequest {
  readonly taskId: TaskId;
  readonly workerId: string;
  readonly requiredCapabilities: readonly string[];
  readonly correlationId: string;
  readonly signal: AbortSignal;
}

export interface SchedulerCapabilityPort {
  authorize(request: SchedulerAuthorizationRequest): SchedulerPortResult<void> | Promise<SchedulerPortResult<void>>;
}

export interface SchedulerLeasePort {
  acquire(input: LeaseAcquireInput): SchedulerPortResult<LeaseRecord> | Promise<SchedulerPortResult<LeaseRecord>>;
  attachAttempt(lease: LeaseRecord, attemptId: AttemptId, now: UtcTimestamp): SchedulerPortResult<LeaseRecord> | Promise<SchedulerPortResult<LeaseRecord>>;
  release(lease: LeaseRecord, now: UtcTimestamp): SchedulerPortResult<LeaseRecord> | Promise<SchedulerPortResult<LeaseRecord>>;
  markUncertain(lease: LeaseRecord, now: UtcTimestamp): SchedulerPortResult<LeaseRecord> | Promise<SchedulerPortResult<LeaseRecord>>;
}

export interface SchedulerAttemptPort {
  start(taskId: TaskId, workerId: string, now: UtcTimestamp): SchedulerPortResult<{ readonly attemptId: AttemptId }> | Promise<SchedulerPortResult<{ readonly attemptId: AttemptId }>>;
}

export type WorkerExecutionResult =
  | { readonly outcome: "success"; readonly summary?: string }
  | { readonly outcome: "failed" | "cancelled" | "unknown"; readonly reason: string };

export interface SchedulerExecutionPort {
  invoke(input: { readonly candidate: RunnableTaskCandidate; readonly taskId: TaskId; readonly attemptId: AttemptId; readonly leaseId: LeaseId; readonly signal: AbortSignal }): Promise<WorkerExecutionResult>;
}

export interface SchedulerPersistenceInput {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly leaseId: LeaseId;
  readonly execution: WorkerExecutionResult;
  readonly interrupted: boolean;
  readonly now: UtcTimestamp;
}

export interface SchedulerPersistencePort {
  persist(input: SchedulerPersistenceInput): SchedulerPortResult<{ readonly checkpointRecorded: boolean }> | Promise<SchedulerPortResult<{ readonly checkpointRecorded: boolean }>>;
}

export interface SchedulerRecoveryPort {
  reconcile(now: UtcTimestamp): SchedulerPortResult<{ readonly recovered: number }> | Promise<SchedulerPortResult<{ readonly recovered: number }>>;
}

export type SchedulerCycleResult =
  | { readonly outcome: "started"; readonly taskId: TaskId; readonly leaseId: LeaseId; readonly attemptId: AttemptId; readonly execution: WorkerExecutionResult }
  | { readonly outcome: "idle"; readonly reason: "no_runnable_task" }
  | { readonly outcome: "deferred"; readonly reason: "worker_unavailable" | "lease_occupied" | "cycle_already_running" | "shutdown_requested" }
  | { readonly outcome: "blocked"; readonly taskId?: TaskId; readonly reason: string }
  | { readonly outcome: "reconciliation_required"; readonly reason: string }
  | { readonly outcome: "failed"; readonly taskId?: TaskId; readonly leaseId?: LeaseId; readonly attemptId?: AttemptId; readonly reason: string; readonly durable: boolean };

export type SchedulerShutdownResult =
  | { readonly outcome: "stopped"; readonly interrupted: boolean }
  | { readonly outcome: "timeout"; readonly interrupted: true };

export interface SchedulerOptions {
  readonly workerId: string;
  readonly workerCapabilities: readonly string[];
  readonly leaseDurationMs: number;
  readonly leaseIdFactory: (taskId: TaskId, now: UtcTimestamp) => LeaseId;
  readonly attemptPort: SchedulerAttemptPort;
  readonly capabilityPort: SchedulerCapabilityPort;
  readonly clock: SchedulerClock;
  readonly executionPort: SchedulerExecutionPort;
  readonly leasePort: SchedulerLeasePort;
  readonly persistencePort: SchedulerPersistencePort;
  readonly recoveryPort: SchedulerRecoveryPort;
  readonly selectionPort: SchedulerSelectionPort;
  readonly workerPort: SchedulerWorkerPort;
  readonly shutdownTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

function failed(reason: string, details: Partial<Extract<SchedulerCycleResult, { readonly outcome: "failed" }>> = {}): SchedulerCycleResult {
  return { outcome: "failed", reason: reason.slice(0, 256), durable: false, ...details };
}

export class SingleWorkerScheduler {
  readonly #options: SchedulerOptions;
  #activeCycle: Promise<SchedulerCycleResult> | undefined;
  #abortController: AbortController | undefined;
  #stopping = false;
  #recovered = false;

  public constructor(options: SchedulerOptions) {
    if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) throw new RangeError("Scheduler Lease duration must be a positive integer.");
    if (!Number.isSafeInteger(options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS) || (options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS) <= 0) throw new RangeError("Scheduler shutdown timeout must be a positive integer.");
    this.#options = options;
  }

  public get stopping(): boolean { return this.#stopping; }
  public get active(): boolean { return this.#activeCycle !== undefined; }

  public cycle(): Promise<SchedulerCycleResult> {
    if (this.#activeCycle !== undefined) return Promise.resolve({ outcome: "deferred", reason: "cycle_already_running" });
    if (this.#stopping) return Promise.resolve({ outcome: "deferred", reason: "shutdown_requested" });
    const running = this.#runCycle();
    this.#activeCycle = running;
    void running.then(() => {
      if (this.#activeCycle === running) this.#activeCycle = undefined;
    }, () => {
      if (this.#activeCycle === running) this.#activeCycle = undefined;
    });
    return running;
  }

  public async recover(): Promise<SchedulerCycleResult> {
    if (this.#stopping) return { outcome: "deferred", reason: "shutdown_requested" };
    const result = await this.#options.recoveryPort.reconcile(this.#options.clock.now());
    if (result.outcome !== "success") return { outcome: "reconciliation_required", reason: `recovery:${result.reason}` };
    this.#recovered = true;
    return { outcome: "idle", reason: "no_runnable_task" };
  }

  public async shutdown(): Promise<SchedulerShutdownResult> {
    this.#stopping = true;
    this.#abortController?.abort();
    const active = this.#activeCycle;
    if (active === undefined) return { outcome: "stopped", interrupted: false };
    const timeout = this.#options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([active.then(() => "complete" as const), new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeout); })]);
      return result === "timeout" ? { outcome: "timeout", interrupted: true } : { outcome: "stopped", interrupted: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #runCycle(): Promise<SchedulerCycleResult> {
    if (!this.#recovered) {
      const recovery = await this.#options.recoveryPort.reconcile(this.#options.clock.now());
      if (recovery.outcome !== "success") return { outcome: "reconciliation_required", reason: `recovery:${recovery.reason}` };
      this.#recovered = true;
    }
    if (this.#stopping) return { outcome: "deferred", reason: "shutdown_requested" };
    const now = this.#options.clock.now();
    const selected = this.#options.selectionPort.select({ evaluatedAt: now, worker: { workerId: this.#options.workerId, capabilities: this.#options.workerCapabilities } });
    if (selected.outcome === "no_runnable_task") return { outcome: "idle", reason: "no_runnable_task" };
    if (selected.outcome === "reconciliation_required") return { outcome: "reconciliation_required", reason: selected.reasons.join(",").slice(0, 256) };
    const candidate = selected.candidate;
    const availability = this.#options.workerPort.check(candidate, this.#options.workerId);
    if (availability.outcome !== "success") return failed(`worker_check:${availability.reason}`, { taskId: candidate.task.id });
    if (availability.value === "unknown") return { outcome: "reconciliation_required", reason: "worker_availability_unknown" };
    if (availability.value === "unavailable") return { outcome: "deferred", reason: "worker_unavailable" };
    const controller = new AbortController();
    this.#abortController = controller;
    const correlationId = `${candidate.task.id}:${now}`.slice(0, 256);
    const authorization = await this.#options.capabilityPort.authorize({ taskId: candidate.task.id, workerId: this.#options.workerId, requiredCapabilities: candidate.task.requiredCapabilities, correlationId, signal: controller.signal });
    if (authorization.outcome !== "success") {
      this.#abortController = undefined;
      return { outcome: "blocked", taskId: candidate.task.id, reason: `authorization:${authorization.reason}` };
    }
    if (this.#stopping || controller.signal.aborted) {
      this.#abortController = undefined;
      return { outcome: "deferred", reason: "shutdown_requested" };
    }
    const leaseInput: LeaseAcquireInput = { id: this.#options.leaseIdFactory(candidate.task.id, now), taskId: candidate.task.id, workerId: this.#options.workerId, now, durationMs: this.#options.leaseDurationMs };
    const acquired = await this.#options.leasePort.acquire(leaseInput);
    if (acquired.outcome !== "success") {
      this.#abortController = undefined;
      return acquired.outcome === "conflict" || acquired.outcome === "unavailable" ? { outcome: "deferred", reason: "lease_occupied" } : failed(`lease_acquire:${acquired.reason}`, { taskId: candidate.task.id });
    }
    const lease = acquired.value;
    const started = await this.#options.attemptPort.start(candidate.task.id, this.#options.workerId, now);
    if (started.outcome !== "success") return this.#afterLeaseFailure(candidate.task.id, lease, `attempt_start:${started.reason}`);
    const attempt = started.value;
    const attached = await this.#options.leasePort.attachAttempt(lease, attempt.attemptId, this.#options.clock.now());
    if (attached.outcome !== "success") return this.#afterLeaseFailure(candidate.task.id, lease, `attempt_attach:${attached.reason}`, attempt.attemptId);
    const currentLease = attached.value;
    let execution: WorkerExecutionResult;
    if (controller.signal.aborted || this.#stopping) {
      execution = { outcome: "cancelled", reason: "shutdown_interrupted" };
    } else {
      try {
        execution = await this.#options.executionPort.invoke({ candidate, taskId: candidate.task.id, attemptId: attempt.attemptId, leaseId: currentLease.id, signal: controller.signal });
      } catch (error: unknown) {
        execution = { outcome: controller.signal.aborted ? "cancelled" : "unknown", reason: controller.signal.aborted ? "shutdown_interrupted" : "worker_invocation_threw" };
      }
    }
    const persisted = await this.#options.persistencePort.persist({ taskId: candidate.task.id, attemptId: attempt.attemptId, leaseId: currentLease.id, execution, interrupted: controller.signal.aborted || this.#stopping, now: this.#options.clock.now() });
    if (persisted.outcome !== "success") return this.#afterLeaseFailure(candidate.task.id, currentLease, `result_persist:${persisted.reason}`, attempt.attemptId);
    const released = await this.#options.leasePort.release(currentLease, this.#options.clock.now());
    this.#abortController = undefined;
    if (released.outcome !== "success") return this.#afterLeaseFailure(candidate.task.id, currentLease, `lease_release:${released.reason}`, attempt.attemptId);
    if (execution.outcome !== "success") return failed(`execution:${execution.reason}`, { taskId: candidate.task.id, leaseId: currentLease.id, attemptId: attempt.attemptId, durable: true });
    return { outcome: "started", taskId: candidate.task.id, leaseId: currentLease.id, attemptId: attempt.attemptId, execution };
  }

  async #afterLeaseFailure(taskId: TaskId, lease: LeaseRecord, reason: string, attemptId?: AttemptId): Promise<SchedulerCycleResult> {
    const uncertain = await this.#options.leasePort.markUncertain(lease, this.#options.clock.now());
    this.#abortController = undefined;
    return failed(reason, { taskId, leaseId: lease.id, ...(attemptId === undefined ? {} : { attemptId }), durable: uncertain.outcome === "success" });
  }
}
