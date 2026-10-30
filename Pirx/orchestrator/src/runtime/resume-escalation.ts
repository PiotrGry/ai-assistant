import { createHash } from "node:crypto";

import { createCheckpoint, type CheckpointId } from "./checkpoint.js";
import { transitionTask, type AttemptId, type AttemptSnapshot, type TaskId, type UtcTimestamp } from "./task-domain.js";
import type { RuntimeSqliteStore } from "./sqlite.js";

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
