import { createCheckpoint, type Checkpoint, type CheckpointInput } from "./checkpoint.js";
import { transitionAttempt, transitionTask, type AttemptSnapshot, type TaskSnapshot, type UtcTimestamp } from "./task-domain.js";
import { invokeWorker, validateWorkerRequest, type WorkerPort, type WorkerRequest, type WorkerResult } from "./worker-contract.js";
import type { RuntimeSqliteStore } from "./sqlite.js";

const INVOCATION_STARTED = "worker invocation started";
const SAFE_REASON = "Worker returned a bounded terminal result.";
const UNSAFE_RESULT = "Worker result was rejected as unsafe.";
const SECRET_PATTERN = /(?:bearer\s+|authorization\s*:|password\s*=|token\s*=|secret\s*=|private[_ -]?key|connection[_ -]?string)/iu;

export type WorkerLifecycleOutcome = "terminal_recorded" | "replayed" | "projection_pending" | "reconciliation_required" | "invalid_request" | "conflict" | "cancelled" | "storage_error";
export interface WorkerLifecycleEvent { readonly eventId: string; readonly taskId: string; readonly attemptId: string; readonly sequence: number; readonly eventType: "attempt_started" | "attempt_result"; readonly timestamp: UtcTimestamp; readonly summary: string; readonly branch?: string; readonly commit?: string; }
export interface WorkerLifecycleProjectionPort { publish(event: WorkerLifecycleEvent): Promise<{ readonly outcome: string }> | { readonly outcome: string }; }
export interface WorkerLifecycleOptions { readonly now?: () => UtcTimestamp; readonly projection?: WorkerLifecycleProjectionPort; }
export type WorkerLifecycleResult =
  | { readonly outcome: "terminal_recorded" | "replayed" | "projection_pending"; readonly taskId: string; readonly attemptId: string; readonly task: TaskSnapshot; readonly attempt: AttemptSnapshot; readonly result: WorkerResult; readonly checkpointId?: string }
  | { readonly outcome: "reconciliation_required" | "invalid_request" | "conflict" | "cancelled" | "storage_error"; readonly taskId: string; readonly attemptId: string; readonly message: string };

function nowUtc(): UtcTimestamp { return new Date().toISOString() as UtcTimestamp; }
function message(value: string): string { return value.slice(0, 256); }
function requestIdentity(value: WorkerRequest, attempt: AttemptSnapshot): string | undefined {
  if (attempt.taskId !== value.taskId || attempt.worker !== value.workerId || attempt.provider !== value.provider) return "Worker request does not match the stored Attempt identity.";
  if (attempt.branch !== value.workspace.branch || attempt.worktree !== value.workspace.worktree) return "Worker request does not match the assigned Attempt workspace.";
  return undefined;
}
function resultFromAttempt(attempt: AttemptSnapshot): WorkerResult | undefined {
  if (attempt.state !== "terminal" || attempt.result === undefined) return undefined;
  const base = { kind: "worker_result" as const, schemaVersion: 1 as const, taskId: attempt.taskId, attemptId: attempt.id, correlationId: "attempt:" + attempt.id };
  return attempt.result === "CODE_PUSHED"
    ? { ...base, outcome: "CODE_PUSHED" as const, branch: attempt.branch!, finalCommit: attempt.finalCommit! }
    : { ...base, outcome: attempt.result, reason: attempt.blockingReason ?? SAFE_REASON, ...(attempt.diagnostic === undefined ? {} : { diagnostic: attempt.diagnostic }) };
}
function safeWorkerResult(result: WorkerResult): WorkerResult {
  if (!SECRET_PATTERN.test(JSON.stringify(result))) return result;
  return { kind: "worker_result", schemaVersion: 1, taskId: result.taskId, attemptId: result.attemptId, correlationId: result.correlationId, outcome: "UNKNOWN", reason: UNSAFE_RESULT };
}
function checkpointTrigger(result: WorkerResult): CheckpointInput["trigger"] {
  return result.outcome === "QUOTA_EXHAUSTED" ? "PROVIDER_QUOTA" : result.outcome === "CANCELLED" ? "WORKER_INTERRUPTION" : "RECOVERABLE_FAILURE";
}
function buildCheckpoint(task: TaskSnapshot, attempt: AttemptSnapshot, result: WorkerResult, at: UtcTimestamp): Checkpoint | undefined {
  if (result.outcome === "CODE_PUSHED" || attempt.state !== "terminal") return undefined;
  const workspace = task.githubReference !== undefined && attempt.branch !== undefined && attempt.worktree !== undefined && attempt.currentCommit !== undefined
    ? { repository: task.githubReference.owner + "/" + task.githubReference.repository, branch: attempt.branch, worktree: attempt.worktree, currentCommit: attempt.currentCommit }
    : {};
  const created = createCheckpoint({
    id: ("worker-" + attempt.id + "-checkpoint") as CheckpointInput["id"],
    taskId: task.id, previousAttemptId: attempt.id, trigger: checkpointTrigger(result), createdAt: at,
    goal: task.goal, currentState: task.state,
    ...workspace,
    completedWork: [], remainingWork: ["resume the assigned Task after human or scheduler review"], changedFiles: [], findings: [], hypotheses: [], tests: [],
    evidence: [{ reference: "attempt:" + attempt.id, summary: "Worker terminal outcome was durably recorded." }],
    ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    blockingReason: result.outcome === "CANCELLED" ? "Worker execution was cancelled." : result.reason,
    lastAction: "recorded worker terminal outcome", resumeInstruction: "Resume only after the durable checkpoint and workspace are validated.",
  });
  return created.ok ? created.value : undefined;
}
function taskAfterResult(task: TaskSnapshot, result: WorkerResult, at: UtcTimestamp): ReturnType<typeof transitionTask> {
  if (result.outcome === "CODE_PUSHED") return { ok: true, value: task };
  const reason = result.outcome === "CANCELLED" ? "Worker execution was cancelled." : result.reason;
  const transition = result.outcome === "BLOCKED" ? { type: "block" as const, reason } : result.outcome === "CANCELLED" ? { type: "cancel" as const, reason } : { type: "fail" as const, reason };
  return transitionTask(task, "in_progress", transition, at);
}

export class WorkerLifecycleCoordinator {
  readonly #store: RuntimeSqliteStore;
  readonly #worker: WorkerPort;
  readonly #now: () => UtcTimestamp;
  readonly #projection: WorkerLifecycleProjectionPort | undefined;

  public constructor(store: RuntimeSqliteStore, worker: WorkerPort, options: WorkerLifecycleOptions = {}) {
    this.#store = store; this.#worker = worker; this.#now = options.now ?? nowUtc; this.#projection = options.projection;
  }

  public async execute(request: unknown, signal: AbortSignal): Promise<WorkerLifecycleResult> {
    const valid = validateWorkerRequest(request);
    if (!valid.ok) return { outcome: "invalid_request", taskId: "unknown", attemptId: "unknown", message: "Worker request failed contract validation." };
    const value = valid.value;
    const identity = this.#storedIdentity(value);
    if (identity.outcome !== "success") return identity;
    const { task, attempt } = identity.value;
    const mismatch = requestIdentity(value, attempt);
    if (mismatch !== undefined) return { outcome: "conflict", taskId: value.taskId, attemptId: value.attemptId, message: mismatch };
    if (attempt.state === "terminal") {
      const replay = resultFromAttempt(attempt);
      return replay === undefined
        ? { outcome: "storage_error", taskId: value.taskId, attemptId: value.attemptId, message: "Stored terminal Attempt is malformed." }
        : { outcome: "replayed", taskId: value.taskId, attemptId: value.attemptId, task, attempt, result: { ...replay, correlationId: value.correlationId } };
    }
    if (signal.aborted) return { outcome: "cancelled", taskId: value.taskId, attemptId: value.attemptId, message: "Worker lifecycle was cancelled before invocation." };
    if (attempt.progress === INVOCATION_STARTED) return { outcome: "reconciliation_required", taskId: value.taskId, attemptId: value.attemptId, message: "Worker invocation has an uncertain result and requires reconciliation before retry." };
    const progress = this.#store.attempts.recordProgress(attempt.id, { state: "running", startedAt: attempt.startedAt }, { progress: INVOCATION_STARTED }, this.#now());
    if (progress.outcome !== "success") return { outcome: progress.outcome === "conflict" ? "conflict" : "storage_error", taskId: value.taskId, attemptId: value.attemptId, message: message(progress.message) };
    const invoked = await invokeWorker(this.#worker, value, signal);
    const workerResult: WorkerResult = invoked.ok ? safeWorkerResult(invoked.value) : { kind: "worker_result", schemaVersion: 1, taskId: value.taskId, attemptId: value.attemptId, correlationId: value.correlationId, outcome: signal.aborted ? "CANCELLED" : "UNKNOWN", reason: signal.aborted ? "Worker execution was cancelled." : "Worker did not return a valid normalized result." };
    const recorded = this.#recordTerminal(value, workerResult);
    if (recorded.outcome !== "success") return { outcome: recorded.outcome === "conflict" ? "conflict" : "storage_error", taskId: value.taskId, attemptId: value.attemptId, message: message(recorded.message) };
    const terminal = recorded.value;
    const projectionPending = await this.#publish(terminal.task, terminal.attempt, workerResult);
    return { outcome: projectionPending ? "projection_pending" : "terminal_recorded", taskId: value.taskId, attemptId: value.attemptId, task: terminal.task, attempt: terminal.attempt, result: workerResult, ...(terminal.checkpoint === undefined ? {} : { checkpointId: terminal.checkpoint.id }) };
  }

  #storedIdentity(value: WorkerRequest) {
    const task = this.#store.tasks.get(value.taskId); const attempt = this.#store.attempts.get(value.attemptId);
    if (task.outcome !== "success" || attempt.outcome !== "success") return { outcome: "storage_error" as const, taskId: value.taskId, attemptId: value.attemptId, message: "Assigned Task or Attempt could not be read." };
    return { outcome: "success" as const, value: { task: task.value, attempt: attempt.value } };
  }

  #recordTerminal(value: WorkerRequest, result: WorkerResult) {
    return this.#store.transaction(({ tasks, attempts, checkpoints }) => {
      const task = tasks.get(value.taskId); const attempt = attempts.get(value.attemptId);
      if (task.outcome !== "success" || attempt.outcome !== "success") return { outcome: "storage_error" as const, message: "Assigned Task or Attempt could not be read while recording the result." };
      if (attempt.value.state !== "running") return { outcome: "conflict" as const, message: "Attempt changed before its terminal result was persisted." };
      const identity = requestIdentity(value, attempt.value);
      if (identity !== undefined) return { outcome: "conflict" as const, message: identity };
      const at = this.#now();
      const nextAttempt = transitionAttempt(attempt.value, "running", result.outcome === "CODE_PUSHED" ? { type: "finish", result: "CODE_PUSHED", branch: result.branch, finalCommit: result.finalCommit, currentCommit: result.finalCommit, progress: "worker invocation completed" } : { type: "finish", result: result.outcome, blockingReason: result.reason, ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }), progress: "worker invocation completed" }, at);
      if (!nextAttempt.ok) return { outcome: "conflict" as const, message: nextAttempt.error.message };
      const storedAttempt = attempts.update(nextAttempt.value, "running");
      if (storedAttempt.outcome !== "success") return storedAttempt;
      const nextTask = taskAfterResult(task.value, result, at);
      if (!nextTask.ok) return { outcome: "conflict" as const, message: nextTask.error.message };
      const storedTask = nextTask.value === task.value ? { outcome: "success" as const, value: task.value } : tasks.update(nextTask.value, { state: task.value.state, updatedAt: task.value.updatedAt });
      if (storedTask.outcome !== "success") return storedTask;
      const checkpoint = buildCheckpoint(storedTask.value, storedAttempt.value, result, at);
      if (checkpoint !== undefined) {
        const storedCheckpoint = checkpoints.save(checkpoint);
        if (storedCheckpoint.outcome !== "success") return storedCheckpoint;
      }
      return { outcome: "success" as const, value: { task: storedTask.value, attempt: storedAttempt.value, ...(checkpoint === undefined ? {} : { checkpoint }) } };
    });
  }

  async #publish(task: TaskSnapshot, attempt: AttemptSnapshot, result: WorkerResult): Promise<boolean> {
    if (this.#projection === undefined) return false;
    const events: WorkerLifecycleEvent[] = [
      { eventId: "worker:" + attempt.id + ":started", taskId: task.id, attemptId: attempt.id, sequence: 1, eventType: "attempt_started", timestamp: attempt.startedAt as UtcTimestamp, summary: "Worker Attempt started.", ...(attempt.branch === undefined ? {} : { branch: attempt.branch }) },
      { eventId: "worker:" + attempt.id + ":result", taskId: task.id, attemptId: attempt.id, sequence: 2, eventType: "attempt_result", timestamp: (attempt.state === "terminal" ? attempt.endedAt : this.#now()), summary: "Worker Attempt ended with " + result.outcome + ".", ...(attempt.branch === undefined ? {} : { branch: attempt.branch }), ...(result.outcome === "CODE_PUSHED" ? { commit: result.finalCommit } : {}) },
    ];
    let pending = false;
    for (const event of events) {
      try { const published = await this.#projection.publish(event); if (!["published", "already_published", "ignored"].includes(published.outcome)) pending = true; } catch { pending = true; }
    }
    return pending;
  }
}
