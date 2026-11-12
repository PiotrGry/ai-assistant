import { createHash } from "node:crypto";

import { createCheckpoint, type CheckpointId } from "./checkpoint.js";
import { transitionTask, type AttemptId, type AttemptSnapshot, type TaskId, type UtcTimestamp } from "./task-domain.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";

export const RESUME_ESCALATION_SCHEMA_VERSION = 1 as const;
export const RESUME_ESCALATION_LIMITS = Object.freeze({ defaultMaximumFailures: 3, maximumFailures: 20 } as const);

export interface ResumeEscalationPolicy {
  readonly maximumConsecutiveFailures: number;
}

export type ResumeEscalationReason = "AMBIGUOUS_PROVIDER_STATE" | "RESUME_FAILURE_LIMIT_REACHED";

export interface ResumeEscalationEvidence {
  readonly taskId: TaskId;
  readonly latestAttemptId: AttemptId;
  readonly consecutiveResumeFailures: number;
  readonly attemptIds: readonly AttemptId[];
}

export type ResumeEscalationResult =
  | { readonly outcome: "no_action"; readonly taskId: TaskId; readonly consecutiveResumeFailures: number }
  | { readonly outcome: "escalated" | "replayed"; readonly taskId: TaskId; readonly reason: ResumeEscalationReason; readonly message: string; readonly checkpointId: CheckpointId; readonly evidence: ResumeEscalationEvidence }
  | { readonly outcome: "invalid_request" | "storage_error"; readonly taskId: TaskId; readonly message: string };

interface EscalationDecision {
  readonly reason: ResumeEscalationReason;
  readonly message: string;
  readonly failures: readonly AttemptSnapshot[];
  readonly latest: AttemptSnapshot & { readonly state: "terminal" };
}

function validPolicy(policy: ResumeEscalationPolicy): boolean {
  return Number.isSafeInteger(policy.maximumConsecutiveFailures) && policy.maximumConsecutiveFailures > 0 && policy.maximumConsecutiveFailures <= RESUME_ESCALATION_LIMITS.maximumFailures;
}

function consecutiveResumeFailures(history: readonly AttemptSnapshot[]): readonly AttemptSnapshot[] {
  const failures: AttemptSnapshot[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const attempt = history[index];
    if (attempt === undefined || attempt.predecessorAttemptId === undefined || attempt.state !== "terminal" || attempt.result === "CODE_PUSHED") break;
    failures.unshift(attempt);
  }
  return Object.freeze(failures);
}

function decision(history: readonly AttemptSnapshot[], policy: ResumeEscalationPolicy): EscalationDecision | undefined {
  const latest = history[history.length - 1];
  if (latest?.state !== "terminal") return undefined;
  const failures = consecutiveResumeFailures(history);
  if (latest.result === "UNKNOWN") return { reason: "AMBIGUOUS_PROVIDER_STATE", message: "Human action required: the latest worker result is ambiguous and cannot be retried safely.", failures, latest };
  if (failures.length >= policy.maximumConsecutiveFailures) return { reason: "RESUME_FAILURE_LIMIT_REACHED", message: `Human action required: ${failures.length} consecutive resume failures reached the configured limit of ${policy.maximumConsecutiveFailures}.`, failures, latest };
  return undefined;
}

function checkpointId(taskId: TaskId, attemptId: AttemptId, reason: ResumeEscalationReason): CheckpointId {
  return `resume-escalation-${createHash("sha256").update(`${taskId}:${attemptId}:${reason}`, "utf8").digest("hex")}` as CheckpointId;
}

function evidence(taskId: TaskId, value: EscalationDecision): ResumeEscalationEvidence {
  return Object.freeze({ taskId, latestAttemptId: value.latest.id, consecutiveResumeFailures: value.failures.length, attemptIds: Object.freeze(value.failures.map((attempt) => attempt.id)) });
}

export class ResumeEscalationCoordinator {
  readonly #store: RuntimeSqliteStore;
  readonly #policy: ResumeEscalationPolicy;

  public constructor(store: RuntimeSqliteStore, policy: ResumeEscalationPolicy = { maximumConsecutiveFailures: RESUME_ESCALATION_LIMITS.defaultMaximumFailures }) {
    if (!validPolicy(policy)) throw new RangeError("Resume escalation failure limit is invalid.");
    this.#store = store;
    this.#policy = Object.freeze({ ...policy });
  }

  public evaluate(taskId: TaskId, evaluatedAt: UtcTimestamp): ResumeEscalationResult {
    const task = this.#store.tasks.get(taskId);
    if (task.outcome !== "success") return { outcome: task.outcome === "not_found" ? "invalid_request" : "storage_error", taskId, message: task.message };
    const history = this.#store.attempts.listByTask(taskId);
    if (history.outcome !== "success") return { outcome: "storage_error", taskId, message: history.message };
    const current = decision(history.value, this.#policy);
    if (task.value.state === "blocked" && current !== undefined && task.value.blockingReason === current.message) {
      const id = checkpointId(taskId, current.latest.id, current.reason);
      const stored = this.#store.checkpoints.get(id);
      return stored.outcome === "success"
        ? { outcome: "replayed", taskId, reason: current.reason, message: current.message, checkpointId: id, evidence: evidence(taskId, current) }
        : { outcome: "storage_error", taskId, message: stored.message };
    }
    if (task.value.state !== "failed") return { outcome: "no_action", taskId, consecutiveResumeFailures: consecutiveResumeFailures(history.value).length };
    if (current === undefined) return { outcome: "no_action", taskId, consecutiveResumeFailures: consecutiveResumeFailures(history.value).length };
    const id = checkpointId(taskId, current.latest.id, current.reason);
    const currentEvidence = evidence(taskId, current);
    const committed = this.#store.transaction(({ tasks, attempts, checkpoints }) => {
      const freshTask = tasks.get(taskId);
      const freshHistory = attempts.listByTask(taskId);
      if (freshTask.outcome !== "success") return freshTask;
      if (freshHistory.outcome !== "success") return freshHistory;
      if (freshTask.value.state === "blocked" && freshTask.value.blockingReason === current.message) {
        const stored = checkpoints.get(id);
        return stored.outcome === "success" ? { outcome: "success" as const, value: "replayed" as const } : stored;
      }
      const freshDecision = decision(freshHistory.value, this.#policy);
      if (freshDecision === undefined || freshDecision.reason !== current.reason || freshDecision.latest.id !== current.latest.id) return { outcome: "conflict" as const, message: "Resume escalation evidence changed before it could be recorded." };
      const blocked = transitionTask(freshTask.value, "failed", { type: "block", reason: freshDecision.message }, evaluatedAt);
      if (!blocked.ok) return { outcome: "conflict" as const, message: blocked.error.message };
      const storedTask = tasks.update(blocked.value, { state: freshTask.value.state, updatedAt: freshTask.value.updatedAt });
      if (storedTask.outcome !== "success") return storedTask;
      const workspace = freshTask.value.githubReference !== undefined && freshDecision.latest.branch !== undefined && freshDecision.latest.worktree !== undefined && freshDecision.latest.currentCommit !== undefined
        ? { repository: `${freshTask.value.githubReference.owner}/${freshTask.value.githubReference.repository}`, branch: freshDecision.latest.branch, worktree: freshDecision.latest.worktree, currentCommit: freshDecision.latest.currentCommit }
        : {};
      const created = createCheckpoint({
        id,
        taskId,
        previousAttemptId: freshDecision.latest.id,
        trigger: "RECOVERABLE_FAILURE",
        createdAt: evaluatedAt,
        goal: freshTask.value.goal,
        currentState: "blocked",
        ...workspace,
        completedWork: [],
        remainingWork: ["A human must inspect the bounded failure evidence and decide whether to resume."],
        changedFiles: [],
        findings: [`${freshDecision.failures.length} consecutive resume failures were recorded.`],
        hypotheses: [],
        tests: [],
        evidence: freshDecision.failures.map((attempt) => ({ reference: `attempt:${attempt.id}`, summary: `Resume Attempt ${attempt.ordinal} ended with ${attempt.state === "terminal" ? attempt.result : "an unsupported state"}.` })),
        blockingReason: freshDecision.message,
        lastAction: "stopped automatic resume and requested human action",
        resumeInstruction: "Inspect the referenced Attempt evidence, resolve uncertainty, then explicitly unblock the Task.",
      });
      if (!created.ok) return { outcome: "invalid_record" as const, message: created.violations[0]?.message ?? "Resume escalation Checkpoint is invalid." };
      const saved = checkpoints.save(created.value);
      if (saved.outcome !== "success") return saved;
      return { outcome: "success" as const, value: "escalated" as const };
    });
    if (committed.outcome !== "success") return { outcome: "storage_error", taskId, message: committed.message };
    return { outcome: committed.value, taskId, reason: current.reason, message: current.message, checkpointId: id, evidence: currentEvidence };
  }
}

export interface OperatorUnblockInput {
  readonly taskId: string;
  readonly operationId: string;
  readonly reason: string;
  readonly unblockedAt: UtcTimestamp;
}

export interface OperatorUnblockAcceptance {
  readonly taskId: TaskId;
  readonly checkpointId: CheckpointId;
  readonly replayed: boolean;
}

export function operatorUnblockCheckpointId(taskId: string, attemptId: string): CheckpointId {
  return `operator-unblock-${createHash("sha256").update(`${taskId}:${attemptId}`, "utf8").digest("hex")}` as CheckpointId;
}

/** True when the latest Checkpoint is the operator approval for one more resume of `latestAttemptId`. */
export function isOperatorUnblockCheckpoint(checkpoint: { readonly id: string; readonly taskId: string; readonly previousAttemptId: string }, latestAttemptId: string): boolean {
  return checkpoint.previousAttemptId === latestAttemptId && checkpoint.id === operatorUnblockCheckpointId(checkpoint.taskId, latestAttemptId);
}

/**
 * Pirx refused the Attempt in its own input/contract check and never received
 * worker output (no payload digest), so nothing external can be ambiguous.
 * Unlike a worker-reported BLOCKED, a retry after a Pirx fix is safe.
 */
export function isPreWorkerBlock(attempt: AttemptSnapshot): boolean {
  return attempt.state === "terminal" && attempt.result === "BLOCKED" && attempt.diagnostic?.code === "binding_mismatch" && attempt.diagnostic.stage === "worker_contract" && attempt.diagnostic.payloadDigest === undefined;
}

/**
 * A BLOCKED Attempt an operator may retry: a pre-worker block, or a push the
 * repository rejected (e.g. a pre-push gate). Pirx never force-pushes, so
 * pushing the same commit again after the repository is fixed is safe.
 */
export function isOperatorRetryableBlock(attempt: AttemptSnapshot): boolean {
  return isPreWorkerBlock(attempt) || (attempt.state === "terminal" && attempt.result === "BLOCKED" && attempt.diagnostic?.code === "push_rejected" && attempt.diagnostic.stage === "git_state");
}

/**
 * Durably approve one more resume of a Task stopped by the resume failure
 * limit. Ambiguous results stay blocked: they need reconciliation, not retry.
 * The daemon still validates the workspace, acquires a Lease and creates the
 * successor Attempt; a further failure escalates again.
 */
export function unblockEscalatedTask(store: RuntimeSqliteStore, input: OperatorUnblockInput): StorageResult<OperatorUnblockAcceptance> {
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.operationId)) return { outcome: "invalid_record", message: "Unblock requires a bounded reason and a safe operationId." };
  return store.transaction<OperatorUnblockAcceptance>(({ tasks, attempts, checkpoints }) => {
    const task = tasks.get(input.taskId);
    if (task.outcome !== "success") return task;
    const history = attempts.listByTask(input.taskId);
    if (history.outcome !== "success") return history;
    const latest = history.value[history.value.length - 1];
    if (latest?.state !== "terminal") return { outcome: "conflict" as const, message: "Task has no terminal latest Attempt to resume from." };
    const id = operatorUnblockCheckpointId(task.value.id, latest.id);
    const existing = checkpoints.get(id);
    if (existing.outcome === "success") {
      return existing.value.evidence.some((item) => item.reference === `operation:${input.operationId}`)
        ? { outcome: "success" as const, value: { taskId: task.value.id, checkpointId: id, replayed: true } }
        : { outcome: "conflict" as const, message: "This Attempt was already unblocked by another operation." };
    }
    if (existing.outcome !== "not_found") return existing;
    if (task.value.state !== "blocked") return { outcome: "conflict" as const, message: `Task state ${task.value.state} is not blocked.` };
    const preWorker = isOperatorRetryableBlock(latest);
    if (latest.result !== "FAILED" && latest.result !== "QUOTA_EXHAUSTED" && !preWorker) return { outcome: "invalid_record" as const, message: `Latest Attempt result ${latest.result} cannot be resumed by unblock; ambiguous or blocked results need reconciliation.` };
    const escalation = checkpoints.latestByTask(task.value.id);
    if (escalation.outcome !== "success") return escalation;
    if (preWorker ? escalation.value.previousAttemptId !== latest.id : escalation.value.id !== checkpointId(task.value.id, latest.id, "RESUME_FAILURE_LIMIT_REACHED") || task.value.blockingReason !== escalation.value.blockingReason) return { outcome: "conflict" as const, message: "Task is not blocked by the resume failure limit." };
    const { kind: _kind, schemaVersion: _schemaVersion, ...base } = escalation.value;
    const created = createCheckpoint({
      ...base,
      id,
      trigger: latest.result === "QUOTA_EXHAUSTED" ? "PROVIDER_QUOTA" : "RECOVERABLE_FAILURE",
      createdAt: input.unblockedAt,
      currentState: "blocked",
      findings: [...base.findings, `Operator unblock reason: ${reason}`],
      evidence: [...base.evidence, { reference: `operation:${input.operationId}`, summary: "Operator explicitly approved one more resume Attempt." }],
      lastAction: "operator unblocked the Task after resume escalation",
      resumeInstruction: "Resume once from the latest Attempt evidence; another failure escalates again.",
    });
    if (!created.ok) return { outcome: "invalid_record" as const, message: created.violations[0]?.message ?? "Operator unblock Checkpoint is invalid." };
    const saved = checkpoints.save(created.value);
    if (saved.outcome !== "success") return saved;
    return { outcome: "success" as const, value: { taskId: task.value.id, checkpointId: id, replayed: false } };
  });
}
