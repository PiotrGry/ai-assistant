import { resolve } from "node:path";

import type { LeaseAcquireInput, LeaseId, LeaseRecord } from "./lease.js";
import { CapabilityEnforcementGate, type CapabilityAuditSink } from "./capability-gate.js";
import { SingleWorkerScheduler, type SchedulerCycleResult, type SchedulerOptions, type SchedulerPortResult } from "./scheduler.js";
import { createWorkerRequest, type WorkerPort, type WorkerRequest, type WorkerRequestInput, type WorkerResult } from "./worker-contract.js";
import { CapabilityAwareWorkerExecutionPort, type WorkerAdapterRegistry } from "./worker-execution.js";
import type { WorkerFailureDiagnostic } from "./worker-diagnostic.js";
import { WorkerLifecycleCoordinator } from "./worker-lifecycle.js";
import { WorkspaceProvisioner, type WorkspaceBinding, type WorkspaceProvisionRequest } from "./workspace.js";
import type { RunnableTaskCandidate } from "./task-selection.js";
import type { AttemptId, AttemptSnapshot, TaskId, TaskSnapshot, UtcTimestamp } from "./task-domain.js";
import { RuntimeSqliteStore, type RuntimeSqliteStoreOptions, type RuntimeSqliteStore as RuntimeSqliteStoreType, type StorageResult } from "./sqlite.js";

export const PRODUCTION_RUNTIME_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_RUNTIME_LIMITS = Object.freeze({
  workerId: 128,
  provider: 128,
  repository: 512,
  repositoryRoot: 2_048,
  worktreeParent: 2_048,
  leaseDurationMs: 86_400_000,
  shutdownTimeoutMs: 120_000,
  workerTimeoutMs: 120_000,
  workerOutputBytes: 64 * 1024,
} as const);

export interface ProductionRepositoryConfig {
  readonly repository: string;
  readonly repositoryRoot: string;
  readonly baseBranch: string;
  readonly baseRevision: string;
}

export interface ProductionWorkspacePort {
  provision(request: WorkspaceProvisionRequest): Promise<{ readonly outcome: string; readonly message: string; readonly binding?: WorkspaceBinding }>;
}

export interface ProductionRuntimeOptions {
  readonly workerId: string;
  readonly provider: string;
  readonly workerCapabilities: readonly string[];
  readonly repositories: readonly ProductionRepositoryConfig[];
  readonly worktreeParent: string;
  readonly leaseDurationMs: number;
  readonly shutdownTimeoutMs?: number;
  readonly workerTimeoutMs?: number;
  readonly workerOutputBytes?: number;
  readonly workerErrorBytes?: number;
  readonly workerAdapters: WorkerAdapterRegistry;
  readonly capabilityAudit?: CapabilityAuditSink;
  readonly workspace?: ProductionWorkspacePort;
  readonly clock?: { now(): UtcTimestamp };
  readonly attemptIdFactory?: (taskId: TaskId, ordinal: number, now: UtcTimestamp) => AttemptId;
  readonly branchFactory?: (task: TaskSnapshot) => string;
}

export interface ProductionRuntimeStatus {
  readonly schemaVersion: typeof PRODUCTION_RUNTIME_SCHEMA_VERSION;
  readonly workerId: string;
  readonly provider: string;
  readonly repositoryCount: number;
  readonly active: boolean;
  readonly stopping: boolean;
  readonly recovered: boolean;
}

function nowUtc(): UtcTimestamp { return new Date().toISOString() as UtcTimestamp; }
function portFailure(reason: string, outcome: "conflict" | "unavailable" | "failed" | "unknown" = "failed"): SchedulerPortResult<never> { return { outcome, reason: reason.slice(0, 256) }; }
function storage<T>(value: StorageResult<T>): SchedulerPortResult<T> {
  if (value.outcome === "success") return { outcome: "success", value: value.value };
  return portFailure(value.message, value.outcome === "conflict" ? "conflict" : "failed");
}
function validText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function validRevision(value: unknown): value is string { return validText(value, 64) && /^[0-9a-f]{4,64}$/iu.test(value); }
function validBranch(value: unknown): value is string { return validText(value, 512) && !value.startsWith("-") && !value.includes("..") && !/[~^:?*[\\\s]/u.test(value) && !value.endsWith("/") && !value.endsWith("."); }
function repositoryParts(value: string): { owner: string; repository: string } | undefined {
  const match = /^([^/]+)\/([^/]+)$/u.exec(value);
  return match === null || !validText(match[1], 100) || !validText(match[2], 100) ? undefined : { owner: match[1], repository: match[2] };
}
function validateOptions(options: ProductionRuntimeOptions): void {
  if (!validText(options.workerId, PRODUCTION_RUNTIME_LIMITS.workerId) || !validText(options.provider, PRODUCTION_RUNTIME_LIMITS.provider)) throw new RangeError("Production worker identity is invalid.");
  if (!Array.isArray(options.workerCapabilities) || options.workerCapabilities.length === 0 || options.workerCapabilities.some((value) => !validText(value, 256))) throw new RangeError("Production worker capabilities must be bounded non-empty strings.");
  if (!validText(options.worktreeParent, PRODUCTION_RUNTIME_LIMITS.worktreeParent) || !resolve(options.worktreeParent).startsWith("/")) throw new RangeError("Production worktree parent must be an absolute path.");
  if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0 || options.leaseDurationMs > PRODUCTION_RUNTIME_LIMITS.leaseDurationMs) throw new RangeError("Production Lease duration is outside its bound.");
  if (!Array.isArray(options.repositories) || options.repositories.length === 0) throw new RangeError("Production repository allowlist must contain at least one repository.");
  for (const repository of options.repositories) {
    if (!validText(repository.repository, PRODUCTION_RUNTIME_LIMITS.repository) || repositoryParts(repository.repository) === undefined || !validText(repository.repositoryRoot, PRODUCTION_RUNTIME_LIMITS.repositoryRoot) || !resolve(repository.repositoryRoot).startsWith("/") || !validBranch(repository.baseBranch) || !validRevision(repository.baseRevision)) throw new RangeError("Production repository configuration is invalid.");
  }
  if (new Set(options.repositories.map((item) => item.repository)).size !== options.repositories.length) throw new RangeError("Production repository allowlist contains duplicates.");
  for (const [value, maximum, label] of [[options.shutdownTimeoutMs ?? 5_000, PRODUCTION_RUNTIME_LIMITS.shutdownTimeoutMs, "shutdown"], [options.workerTimeoutMs ?? 30_000, PRODUCTION_RUNTIME_LIMITS.workerTimeoutMs, "worker"], [options.workerOutputBytes ?? 16_384, PRODUCTION_RUNTIME_LIMITS.workerOutputBytes, "worker output"]] as const) if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`Production ${label} limit is invalid.`);
  if (options.workerErrorBytes !== undefined && (!Number.isSafeInteger(options.workerErrorBytes) || options.workerErrorBytes <= 0 || options.workerErrorBytes > PRODUCTION_RUNTIME_LIMITS.workerOutputBytes)) throw new RangeError("Production worker error limit is invalid.");
  if (typeof options.workerAdapters.get !== "function") throw new RangeError("Production worker adapter registry is required.");
}

function leaseId(taskId: TaskId, now: UtcTimestamp): LeaseId {
  return `lease:${taskId}:${Date.parse(now)}`.slice(0, 128) as LeaseId;
}
function attemptId(taskId: TaskId, ordinal: number, now: UtcTimestamp): AttemptId {
  return `attempt:${taskId}:${ordinal}:${Date.parse(now)}`.slice(0, 128) as AttemptId;
}
function branch(task: TaskSnapshot): string { return `pirx/task-${task.id}`.slice(0, 512); }
function repositoryFor(task: TaskSnapshot, repositories: ReadonlyMap<string, ProductionRepositoryConfig>): ProductionRepositoryConfig | undefined {
  const reference = task.githubReference;
  return reference === undefined ? undefined : repositories.get(`${reference.owner}/${reference.repository}`);
}
function workerExecutionResult(value: Awaited<ReturnType<WorkerLifecycleCoordinator["execute"]>>): { readonly outcome: "success"; readonly summary?: string } | { readonly outcome: "failed" | "cancelled" | "unknown"; readonly reason: string } {
  if (value.outcome === "terminal_recorded" || value.outcome === "projection_pending" || value.outcome === "replayed") return value.result.outcome === "CODE_PUSHED" ? { outcome: "success", summary: "Worker lifecycle recorded CODE_PUSHED." } : value.result.outcome === "CANCELLED" ? { outcome: "cancelled", reason: value.result.reason } : { outcome: "failed", reason: value.result.reason };
  return value.outcome === "cancelled" ? { outcome: "cancelled", reason: value.message } : value.outcome === "reconciliation_required" || value.outcome === "invalid_request" || value.outcome === "conflict" || value.outcome === "storage_error" ? { outcome: "unknown", reason: value.message } : { outcome: "unknown", reason: "Worker lifecycle returned an unsupported outcome." };
}
function failureOutcome(diagnostic: WorkerFailureDiagnostic): "BLOCKED" | "FAILED" | "QUOTA_EXHAUSTED" | "CANCELLED" {
  if (diagnostic.code === "quota_exhausted") return "QUOTA_EXHAUSTED";
  if (diagnostic.code === "cancellation") return "CANCELLED";
  if (["capability_denied", "permission_denied", "authentication", "binding_mismatch"].includes(diagnostic.code)) return "BLOCKED";
  return "FAILED";
}
function capabilityFailureResult(request: WorkerRequest, execution: Awaited<ReturnType<CapabilityAwareWorkerExecutionPort["execute"]>>): WorkerResult {
  if (execution.outcome === "allowed") return execution.value;
  const diagnostic = execution.diagnostic;
  return { kind: "worker_result", schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, outcome: failureOutcome(diagnostic), reason: diagnostic.message, diagnostic };
}

export class ProductionRuntime {
  readonly #store: RuntimeSqliteStoreType;
  readonly #options: ProductionRuntimeOptions;
  readonly #repositories: ReadonlyMap<string, ProductionRepositoryConfig>;
  readonly #workspace: ProductionWorkspacePort;
  readonly #scheduler: SingleWorkerScheduler;
  readonly #lifecycle: WorkerLifecycleCoordinator;
  readonly #clock: { now(): UtcTimestamp };
  #recovered = false;

  public constructor(store: RuntimeSqliteStoreType, options: ProductionRuntimeOptions) {
    validateOptions(options);
    this.#store = store;
    this.#options = options;
    this.#clock = options.clock ?? { now: nowUtc };
    this.#repositories = new Map(options.repositories.map((item) => [item.repository, Object.freeze({ ...item })]));
    this.#workspace = options.workspace ?? new WorkspaceProvisioner();
    const audit = options.capabilityAudit ?? { record: () => undefined };
    const capabilityWorker = new CapabilityAwareWorkerExecutionPort(new CapabilityEnforcementGate(audit), options.workerAdapters, { now: () => this.#clock.now() });
    const worker: WorkerPort = { execute: async (request, signal) => {
      const value = await capabilityWorker.execute(request, signal);
      if (value.outcome === "allowed") return value.value;
      return capabilityFailureResult(request, value);
    } };
    this.#lifecycle = new WorkerLifecycleCoordinator(store, worker, { now: () => this.#clock.now() });
    const schedulerOptions: SchedulerOptions = {
      workerId: options.workerId,
      workerCapabilities: options.workerCapabilities,
      leaseDurationMs: options.leaseDurationMs,
      leaseIdFactory: (taskId, now) => leaseId(taskId, now),
      clock: this.#clock,
      selectionPort: { select: (request) => this.#store.selection.select(request) },
      workerPort: { check: (candidate) => this.#workerAvailability(candidate) },
      capabilityPort: { authorize: async (request) => this.#authorize(request.taskId, request.requiredCapabilities) },
      attemptPort: { start: async (taskId, workerId, now) => this.#startAttempt(taskId, workerId, now) },
      leasePort: { acquire: async (input) => storage(this.#store.leases.acquire(input)), attachAttempt: async (lease, id, now) => storage(this.#store.leases.attachAttempt(lease.id, lease.ownershipToken, lease.version, id, now)), release: async (lease, now) => storage(this.#store.leases.release(lease.id, lease.ownershipToken, lease.version, now)), markUncertain: async (lease, now) => storage(this.#store.leases.markUncertain(lease.id, lease.ownershipToken, lease.version, now)) },
      executionPort: { invoke: async (input) => this.#invoke(input.candidate, input.attemptId, input.signal) },
      persistencePort: { persist: async (input) => this.#persist(input.taskId, input.attemptId, input.execution) },
      recoveryPort: { reconcile: async (now) => this.#reconcile(now) },
      ...(options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    };
    this.#scheduler = new SingleWorkerScheduler(schedulerOptions);
  }

  public static openWithStorage(options: ProductionRuntimeOptions, storageOptions: RuntimeSqliteStoreOptions = {}): ProductionRuntime { return new ProductionRuntime(RuntimeSqliteStore.open(storageOptions), options); }
  public get store(): RuntimeSqliteStoreType { return this.#store; }
  public get scheduler(): SingleWorkerScheduler { return this.#scheduler; }
  public get clock(): { now(): UtcTimestamp } { return this.#clock; }
  public status(): ProductionRuntimeStatus { return { schemaVersion: PRODUCTION_RUNTIME_SCHEMA_VERSION, workerId: this.#options.workerId, provider: this.#options.provider, repositoryCount: this.#repositories.size, active: this.#scheduler.active, stopping: this.#scheduler.stopping, recovered: this.#recovered }; }
  public recover(): Promise<SchedulerCycleResult> { return this.#scheduler.recover().then((value) => { if (value.outcome === "idle") this.#recovered = true; return value; }); }
  public async cycle(): Promise<SchedulerCycleResult> { const result = await this.#scheduler.cycle(); if (result.outcome !== "reconciliation_required") this.#recovered = true; return result; }
  public async shutdown(): Promise<{ readonly outcome: "stopped" | "timeout"; readonly interrupted: boolean }> { const stopped = await this.#scheduler.shutdown(); if (stopped.outcome === "stopped") this.#store.close(); return stopped; }
  public close(): void { this.#store.close(); }

  #workerAvailability(candidate: RunnableTaskCandidate): SchedulerPortResult<"available" | "unavailable" | "unknown"> {
    if (repositoryFor(candidate.task, this.#repositories) === undefined) return portFailure("Task repository is not in the production allowlist.", "failed");
    return this.#options.workerAdapters.get(this.#options.provider) === undefined ? { outcome: "success", value: "unavailable" } : { outcome: "success", value: "available" };
  }

  #authorize(taskId: TaskId, required: readonly string[]): SchedulerPortResult<void> {
    const missing = required.filter((capability) => !this.#options.workerCapabilities.includes(capability));
    return missing.length === 0 ? { outcome: "success", value: undefined } : portFailure(`Worker is missing required capabilities: ${missing.join(", ")}.`);
  }

  #startAttempt(taskId: TaskId, workerId: string, now: UtcTimestamp): SchedulerPortResult<{ readonly attemptId: AttemptId }> {
    const task = this.#store.tasks.get(taskId);
    if (task.outcome !== "success") return portFailure(task.message);
    const repository = repositoryFor(task.value, this.#repositories);
    if (repository === undefined) return portFailure("Task repository is not in the production allowlist.");
    const history = this.#store.attempts.listByTask(taskId);
    if (history.outcome !== "success") return portFailure(history.message);
    const ordinal = history.value.length + 1;
    const previous = history.value[history.value.length - 1];
    if (task.value.state !== "ready") {
      if (task.value.state !== "in_progress" || previous?.state !== "running" || previous.predecessorAttemptId === undefined || previous.checkpointReference === undefined) return portFailure("Only an explicitly checkpointed retry Attempt can be claimed by the scheduler.", "conflict");
      const predecessor = history.value.find((attempt) => attempt.id === previous.predecessorAttemptId);
      const checkpoint = this.#store.checkpoints.get(previous.checkpointReference);
      if (predecessor?.state !== "terminal" || predecessor.ordinal + 1 !== previous.ordinal || checkpoint.outcome !== "success" || checkpoint.value.taskId !== taskId || checkpoint.value.previousAttemptId !== predecessor.id) return portFailure("Retry Attempt checkpoint or predecessor does not match the durable history.", "conflict");
      if (previous.worker !== workerId || previous.provider !== this.#options.provider) return portFailure("Retry Attempt worker identity does not match the scheduler.", "conflict");
      return { outcome: "success", value: { attemptId: previous.id } };
    }
    const id = this.#options.attemptIdFactory?.(taskId, ordinal, now) ?? attemptId(taskId, ordinal, now);
    const assignedBranch = this.#options.branchFactory?.(task.value) ?? branch(task.value);
    const worktree = resolve(this.#options.worktreeParent, `pirx-${taskId}-${id}`);
    const started = this.#store.startAttempt(taskId, { id, worker: workerId, provider: this.#options.provider, ...(previous?.id === undefined ? {} : { predecessorAttemptId: previous.id }), branch: assignedBranch, worktree, ...(previous?.state === "terminal" && previous.finalCommit !== undefined ? { currentCommit: previous.finalCommit } : {}) }, now);
    if (started.outcome !== "success") return portFailure(started.message, started.outcome === "conflict" ? "conflict" : "failed");
    return { outcome: "success", value: { attemptId: started.value.attempt.id } };
  }

  async #invoke(candidate: RunnableTaskCandidate, attemptIdValue: AttemptId, signal: AbortSignal): Promise<ReturnType<typeof workerExecutionResult>> {
    const task = this.#store.tasks.get(candidate.task.id); const attempt = this.#store.attempts.get(attemptIdValue); const repository = task.outcome === "success" ? repositoryFor(task.value, this.#repositories) : undefined;
    if (task.outcome !== "success" || attempt.outcome !== "success" || repository === undefined || attempt.value.branch === undefined || attempt.value.worktree === undefined) return { outcome: "unknown", reason: "Assigned Task, Attempt, repository, or workspace identity is unavailable." };
    const workspaceRequest: WorkspaceProvisionRequest = { taskId: task.value.id, attemptId: attempt.value.id, repositoryRoot: repository.repositoryRoot, assignedBranch: attempt.value.branch, expectedBaseRevision: repository.baseRevision, worktreeParent: this.#options.worktreeParent, ...(this.#options.workerTimeoutMs === undefined ? {} : { timeoutMs: this.#options.workerTimeoutMs }), signal };
    const ownership = this.#store.workspaces.getByTaskAttempt(task.value.id, attempt.value.id);
    let binding: WorkspaceBinding | undefined;
    if (ownership.outcome === "success") binding = { schemaVersion: 1, taskId: ownership.value.taskId, attemptId: ownership.value.attemptId, repositoryRoot: ownership.value.repositoryRoot, assignedBranch: ownership.value.assignedBranch, expectedBaseRevision: ownership.value.expectedBaseRevision, worktreePath: ownership.value.worktreePath };
    else {
      const predecessor = attempt.value.predecessorAttemptId === undefined ? undefined : this.#store.workspaces.getByTask(task.value.id);
      if (predecessor?.outcome === "success") {
        if (attempt.value.predecessorAttemptId !== predecessor.value.attemptId || predecessor.value.repository !== repository.repository || predecessor.value.assignedBranch !== attempt.value.branch || predecessor.value.expectedBaseRevision !== repository.baseRevision) return { outcome: "unknown", reason: "Retry workspace ownership does not match its predecessor Attempt." };
        const transferred = this.#store.workspaces.transfer({ taskId: task.value.id, fromAttemptId: predecessor.value.attemptId, toAttemptId: attempt.value.id, transferredAt: this.#clock.now() });
        if (transferred.outcome !== "success") return { outcome: "unknown", reason: transferred.message };
        binding = { schemaVersion: 1, taskId: transferred.value.taskId, attemptId: transferred.value.attemptId, repositoryRoot: transferred.value.repositoryRoot, assignedBranch: transferred.value.assignedBranch, expectedBaseRevision: transferred.value.expectedBaseRevision, worktreePath: transferred.value.worktreePath };
      } else {
        if (predecessor !== undefined && predecessor.outcome !== "not_found") return { outcome: "unknown", reason: predecessor.message };
        const provisioned = await this.#workspace.provision(workspaceRequest);
        if (provisioned.binding === undefined || !["created", "existing_compatible"].includes(provisioned.outcome)) return { outcome: signal.aborted ? "cancelled" : "unknown", reason: provisioned.message };
        binding = provisioned.binding;
        const claimed = this.#store.workspaces.claim({ taskId: task.value.id, attemptId: attempt.value.id, repository: repository.repository, repositoryRoot: binding.repositoryRoot, assignedBranch: binding.assignedBranch, worktreePath: binding.worktreePath, expectedBaseRevision: binding.expectedBaseRevision, acquiredAt: this.#clock.now() });
        if (claimed.outcome !== "success") return { outcome: "unknown", reason: claimed.message };
      }
    }
    const input: WorkerRequestInput = { task: task.value, attempt: attempt.value, workerId: this.#options.workerId, provider: this.#options.provider, repository: repositoryParts(repository.repository)!, workspace: { branch: binding.assignedBranch, worktree: binding.worktreePath }, capabilityGrant: { grantedCapabilities: this.#options.workerCapabilities, resourceScope: { repository: repository.repository, branch: binding.assignedBranch, worktree: binding.worktreePath } }, correlationId: `${task.value.id}:${attempt.value.id}`, limits: { timeoutMs: this.#options.workerTimeoutMs ?? 30_000, maxOutputBytes: this.#options.workerOutputBytes ?? 16_384, maxErrorBytes: this.#options.workerErrorBytes ?? 16_384 }, ...(attempt.value.checkpointReference === undefined ? {} : { resumeContextReference: attempt.value.checkpointReference }) };
    const parsed = createWorkerRequest(input);
    if (!parsed.ok) return { outcome: "unknown", reason: "Production worker request failed validation." };
    return workerExecutionResult(await this.#lifecycle.execute(parsed.value, signal));
  }

  #persist(taskId: TaskId, attemptIdValue: AttemptId, execution: ReturnType<typeof workerExecutionResult>): SchedulerPortResult<{ readonly checkpointRecorded: boolean }> {
    const attempt = this.#store.attempts.get(attemptIdValue);
    if (attempt.outcome !== "success" || attempt.value.taskId !== taskId || attempt.value.state !== "terminal") return portFailure("Worker result was not durably recorded.");
    if (execution.outcome !== "success") {
      const checkpoint = this.#store.checkpoints.latestByTask(taskId);
      if (checkpoint.outcome !== "success" || checkpoint.value.previousAttemptId !== attemptIdValue) return portFailure("Terminal worker failure has no matching durable Checkpoint.");
      return { outcome: "success", value: { checkpointRecorded: true } };
    }
    return { outcome: "success", value: { checkpointRecorded: false } };
  }

  #reconcile(now: UtcTimestamp): SchedulerPortResult<{ readonly recovered: number }> {
    const recoverable = this.#store.leases.listRecoverable(now);
    if (recoverable.outcome !== "success") return portFailure(recoverable.message);
    let recovered = 0;
    for (const lease of recoverable.value) {
      const value = this.#store.leases.recover(lease.id, lease.ownershipToken, lease.version, now);
      if (value.outcome !== "success") return portFailure(value.message);
      recovered += 1;
    }
    const active = this.#store.leases.getActiveByWorker(this.#options.workerId);
    if (active.outcome === "success") return portFailure("An active Lease survived startup and requires reconciliation.", "unknown");
    if (active.outcome !== "not_found") return portFailure(active.message);
    return { outcome: "success", value: { recovered } };
  }
}
