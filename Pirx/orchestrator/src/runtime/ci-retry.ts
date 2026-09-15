import { createHash } from "node:crypto";

import { createCheckpoint, type Checkpoint, type CheckpointInput } from "./checkpoint.js";
import { retryTask, type AttemptId, type AttemptSnapshot, type TaskId, type UtcTimestamp } from "./task-domain.js";
import type { CiFailureEvidenceRecord } from "./ci-evidence.js";
import type { CiCorrelationRecord } from "./ci-correlation.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";

export const CI_RETRY_SCHEMA_VERSION = 1 as const;
export const CI_RETRY_LIMITS = Object.freeze({
  failureEventId: 256,
  evidenceReference: 128,
  finding: 512,
} as const);

export type CiRetryOutcome =
  | "created"
  | "already_retried"
  | "stale"
  | "mismatch"
  | "non_failing_run"
  | "missing_evidence"
  | "conflict"
  | "blocked"
  | "storage_failure"
  | "reconciliation_required";

export interface CiRetryRequest {
  readonly schemaVersion?: typeof CI_RETRY_SCHEMA_VERSION;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly failureEventId: string;
  readonly evidenceDigest: string;
  readonly now: UtcTimestamp;
}

export interface CiRetryResult {
  readonly schemaVersion: typeof CI_RETRY_SCHEMA_VERSION;
  readonly outcome: CiRetryOutcome;
  readonly taskId: TaskId;
  readonly previousAttemptId: AttemptId;
  readonly successorAttemptId?: AttemptId;
  readonly checkpointId?: Checkpoint["id"];
  readonly message: string;
}

function result(request: CiRetryRequest, outcome: CiRetryOutcome, message: string, successorAttemptId?: AttemptId, checkpointId?: Checkpoint["id"]): CiRetryResult {
  return { schemaVersion: CI_RETRY_SCHEMA_VERSION, outcome, taskId: request.taskId, previousAttemptId: request.attemptId, ...(successorAttemptId === undefined ? {} : { successorAttemptId }), ...(checkpointId === undefined ? {} : { checkpointId }), message };
}

function storageOutcome(request: CiRetryRequest, stored: Exclude<StorageResult<unknown>, { outcome: "success" }>): CiRetryResult {
  if (stored.outcome === "not_found") return result(request, "missing_evidence", stored.message);
  if (stored.outcome === "conflict") return result(request, "conflict", stored.message);
  return result(request, "storage_failure", stored.message);
}

function validInput(request: CiRetryRequest): string | undefined {
  if (request.schemaVersion !== undefined && request.schemaVersion !== CI_RETRY_SCHEMA_VERSION) return "Unsupported CI retry schema version.";
  if (typeof request.failureEventId !== "string" || request.failureEventId.trim().length === 0 || request.failureEventId.length > CI_RETRY_LIMITS.failureEventId || /[\u0000-\u001f\u007f]/u.test(request.failureEventId)) return "Failure event identity is invalid or too large.";
  if (!/^\p{Hex_Digit}{64}$/u.test(request.evidenceDigest)) return "Evidence digest must be a SHA-256 hexadecimal digest.";
  if (typeof request.taskId !== "string" || typeof request.attemptId !== "string" || typeof request.now !== "string" || !Number.isFinite(Date.parse(request.now)) || new Date(request.now).toISOString() !== request.now) return "CI retry identity or timestamp is invalid.";
  return undefined;
}

function stableIds(eventId: string): { readonly attemptId: AttemptId; readonly checkpointId: Checkpoint["id"] } {
  const digest = createHash("sha256").update(eventId, "utf8").digest("hex").slice(0, 48);
  return { attemptId: `ci-retry-${digest}` as AttemptId, checkpointId: `ci-retry-${digest}-checkpoint` as Checkpoint["id"] };
}

function sameEvidenceCorrelation(evidence: CiFailureEvidenceRecord, correlation: CiCorrelationRecord): boolean {
  return correlation.state === "failed"
    && correlation.repository === evidence.repository
    && correlation.headBranch === evidence.headBranch
    && correlation.pushedCommit === evidence.pushedCommit
    && correlation.provider === evidence.provider
    && correlation.providerRunId === evidence.providerRunId
    && correlation.providerRunUrl === evidence.providerRunUrl
    && correlation.workflowName === evidence.workflowName
    && correlation.testedRevision === evidence.testedRevision
    && correlation.issueNumber === evidence.issueNumber
    && correlation.featurePullRequest.url === evidence.featurePullRequestUrl
    && correlation.featurePullRequest.number === evidence.featurePullRequestNumber;
}

function failedFacts(evidence: CiFailureEvidenceRecord): readonly string[] {
  const facts: string[] = [`Workflow ${evidence.workflowName} run ${evidence.providerRunId} concluded failure.`];
  for (const job of evidence.failedJobs) {
    const steps = job.failedSteps.map((step) => step.number === undefined ? step.name : `${step.name} (#${step.number})`).join(", ");
    facts.push(`Failed job ${job.name}${steps.length === 0 ? "" : `; failed steps: ${steps}`}.`);
  }
  return Object.freeze(facts.map((fact) => fact.slice(0, CI_RETRY_LIMITS.finding)));
}

function buildCheckpoint(task: { id: TaskId; goal: string; state: string; githubReference?: { owner: string; repository: string } }, attempt: AttemptSnapshot, evidence: CiFailureEvidenceRecord, id: Checkpoint["id"], now: UtcTimestamp): Checkpoint | undefined {
  const created = createCheckpoint({
    id,
    taskId: task.id,
    previousAttemptId: attempt.id,
    trigger: "REQUIRED_ATTEMPT",
    createdAt: now,
    goal: task.goal,
    currentState: task.state,
    ...(task.githubReference === undefined || attempt.branch === undefined || attempt.worktree === undefined || attempt.currentCommit === undefined ? {} : {
      repository: `${task.githubReference.owner}/${task.githubReference.repository}`,
      branch: attempt.branch,
      worktree: attempt.worktree,
      currentCommit: attempt.currentCommit,
    }),
    completedWork: [`Attempt ${attempt.id} pushed commit ${evidence.pushedCommit}.`],
    remainingWork: ["Inspect the bounded failed-CI evidence and continue the assigned work."],
    changedFiles: [],
    findings: failedFacts(evidence),
    hypotheses: [],
    tests: [{ command: evidence.workflowName, result: `run ${evidence.providerRunId} failed for ${evidence.testedRevision}` }],
    evidence: [{ reference: `ci-evidence:${evidence.evidenceDigest}`.slice(0, CI_RETRY_LIMITS.evidenceReference), summary: `Bounded failure evidence for ${evidence.workflowName} run ${evidence.providerRunId}.` }],
    lastAction: "recorded exact failed-CI evidence for a successor Attempt",
    resumeInstruction: "Review the bounded failed-CI facts, then continue the assigned Attempt through the normal scheduler.",
  });
  return created.ok ? created.value : undefined;
}

function existingSuccessor(store: RuntimeSqliteStore, request: CiRetryRequest, evidence: CiFailureEvidenceRecord, ids: ReturnType<typeof stableIds>): CiRetryResult | undefined {
  const attempts = store.attempts.listByTask(request.taskId);
  if (attempts.outcome !== "success") return storageOutcome(request, attempts);
  const successor = attempts.value.find((attempt) => attempt.predecessorAttemptId === request.attemptId);
  if (successor === undefined) return undefined;
  const checkpoint = store.checkpoints.get(ids.checkpointId);
  if (successor.id === ids.attemptId && checkpoint.outcome === "success" && checkpoint.value.previousAttemptId === request.attemptId && checkpoint.value.evidence.some((entry) => entry.reference === `ci-evidence:${evidence.evidenceDigest}`.slice(0, CI_RETRY_LIMITS.evidenceReference))) return result(request, "already_retried", "The same failed-CI event already created this successor Attempt.", successor.id, checkpoint.value.id);
  return result(request, "reconciliation_required", "A successor Attempt exists without a matching stable retry Checkpoint and requires reconciliation.");
}

export class CiRetryCoordinator {
  readonly #store: RuntimeSqliteStore;

  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public create(request: CiRetryRequest): CiRetryResult {
    const invalid = validInput(request);
    if (invalid !== undefined) return result(request, "mismatch", invalid);
    const evidence = this.#store.ciEvidence.getByTaskAttempt(request.taskId, request.attemptId);
    if (evidence.outcome !== "success") return storageOutcome(request, evidence);
    if (evidence.value.evidenceDigest !== request.evidenceDigest) return result(request, "mismatch", "The supplied evidence digest does not match durable evidence.");
    if (evidence.value.conclusion !== "failure" || evidence.value.testedRevision !== evidence.value.pushedCommit) return result(request, "non_failing_run", "Only a terminal failed run for the exact pushed revision can create a retry.");
    const correlation = this.#store.ciCorrelations.getByTaskAttempt(request.taskId, request.attemptId);
    if (correlation.outcome !== "success") return correlation.outcome === "not_found" ? result(request, "stale", "The CI correlation is missing.") : storageOutcome(request, correlation);
    if (correlation.value.state !== "failed") return result(request, "non_failing_run", "The durable CI correlation is not failed.");
    if (!sameEvidenceCorrelation(evidence.value, correlation.value)) return result(request, "stale", "The evidence no longer matches the durable CI correlation.");
    const task = this.#store.tasks.get(request.taskId);
    const attempt = this.#store.attempts.get(request.attemptId);
    if (task.outcome !== "success" || attempt.outcome !== "success") return result(request, "stale", "The referenced Task or Attempt is unavailable.");
    const previous = attempt.value;
    const repository = task.value.githubReference === undefined ? undefined : `${task.value.githubReference.owner}/${task.value.githubReference.repository}`;
    if (previous.taskId !== request.taskId || previous.state !== "terminal" || previous.result !== "CODE_PUSHED" || previous.finalCommit !== evidence.value.pushedCommit || previous.branch !== evidence.value.headBranch || repository !== evidence.value.repository) return result(request, "mismatch", "The failed evidence does not match the terminal CODE_PUSHED Attempt and Task repository.");
    if (task.value.state !== "in_progress" && task.value.state !== "blocked" && task.value.state !== "failed") return result(request, "blocked", `Task state ${task.value.state} is not retry-eligible.`);
    const ids = stableIds(request.failureEventId);
    const replay = existingSuccessor(this.#store, request, evidence.value, ids);
    if (replay !== undefined) return replay;
    const history = this.#store.attempts.listByTask(request.taskId);
    if (history.outcome !== "success") return storageOutcome(request, history);
    if (history.value.some((entry) => entry.state === "running")) return result(request, "blocked", "The Task already has a running Attempt.");
    const persisted = this.#store.transaction<{ readonly successorAttemptId: AttemptId; readonly checkpointId: Checkpoint["id"] }>(({ tasks, attempts, checkpoints }) => {
      const currentTask = tasks.get(request.taskId);
      const currentHistory = attempts.listByTask(request.taskId);
      if (currentTask.outcome !== "success" || currentHistory.outcome !== "success") return { outcome: "storage_error", message: "Task or Attempt history could not be read inside the retry transaction." };
      const currentPrevious = currentHistory.value.find((entry) => entry.id === request.attemptId);
      const currentSuccessor = currentHistory.value.find((entry) => entry.predecessorAttemptId === request.attemptId);
      if (currentSuccessor !== undefined) return { outcome: "conflict", message: "A concurrent retry created a successor Attempt and requires replay reconciliation." };
      if (currentPrevious?.state !== "terminal" || currentPrevious.result !== "CODE_PUSHED") return { outcome: "conflict", message: "The predecessor Attempt changed before retry creation." };
      const checkpoint = buildCheckpoint(currentTask.value, currentPrevious, evidence.value, ids.checkpointId, request.now);
      if (checkpoint === undefined) return { outcome: "conflict", message: "Failed-CI retry Checkpoint could not be validated." };
      const savedCheckpoint = checkpoints.save(checkpoint);
      if (savedCheckpoint.outcome !== "success") return savedCheckpoint;
      const retried = retryTask(currentTask.value, currentHistory.value, {
        id: ids.attemptId,
        worker: currentPrevious.worker,
        provider: currentPrevious.provider,
        predecessorAttemptId: currentPrevious.id,
        ...(currentPrevious.branch === undefined ? {} : { branch: currentPrevious.branch }),
        ...(currentPrevious.worktree === undefined ? {} : { worktree: currentPrevious.worktree }),
        ...(currentPrevious.currentCommit === undefined ? {} : { currentCommit: currentPrevious.currentCommit }),
        checkpointReference: checkpoint.id,
        progress: "retry Attempt created from exact failed-CI evidence",
      }, request.now);
      if (!retried.ok) return { outcome: "conflict", message: retried.error.message };
      const savedTask = tasks.update(retried.value.task, { state: currentTask.value.state, updatedAt: currentTask.value.updatedAt });
      if (savedTask.outcome !== "success") return savedTask;
      const savedAttempt = attempts.create(retried.value.attempt);
      if (savedAttempt.outcome !== "success") return savedAttempt;
      return { outcome: "success", value: { successorAttemptId: savedAttempt.value.id, checkpointId: savedCheckpoint.value.id } };
    });
    if (persisted.outcome !== "success") return result(request, persisted.outcome === "conflict" ? "conflict" : "storage_failure", persisted.message);
    return result(request, "created", "Created one successor Attempt from the exact failed-CI evidence.", persisted.value.successorAttemptId, persisted.value.checkpointId);
  }
}
