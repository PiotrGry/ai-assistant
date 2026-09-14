import {
  retryTask,
  type AttemptId,
  type AttemptSnapshot,
  type RetriedTask,
  type StartAttemptInput,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "./task-domain.js";
import {
  type Checkpoint,
  type CheckpointEvidence,
  type CheckpointTestResult,
} from "./checkpoint.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";

export const RESUME_CONTEXT_SCHEMA_VERSION = 1 as const;
export const RESUME_CONTEXT_LIMITS = Object.freeze({
  serializedBytes: 12_000,
  maxItems: 50,
  maxItemCharacters: 1_000,
  maxTestCharacters: 1_000,
} as const);

export type WorkspaceReferenceStatus = "present" | "missing" | "stale";
export interface ResumeWorkspaceReference {
  readonly repository: string;
  readonly branch: string;
  readonly worktree: string;
  readonly currentCommit: string;
}
export interface WorkspaceReferenceCheck {
  readonly repository: WorkspaceReferenceStatus;
  readonly branch: WorkspaceReferenceStatus;
  readonly worktree: WorkspaceReferenceStatus;
  readonly currentCommit: WorkspaceReferenceStatus;
}
export interface WorkspaceReferencePort {
  check(reference: ResumeWorkspaceReference): WorkspaceReferenceCheck;
}

export interface ResumeContext {
  readonly kind: "resume_context";
  readonly schemaVersion: typeof RESUME_CONTEXT_SCHEMA_VERSION;
  readonly taskId: TaskId;
  readonly previousAttemptId: AttemptId;
  readonly checkpointId: Checkpoint["id"];
  readonly goal: string;
  readonly currentState: string;
  readonly completedWork: readonly string[];
  readonly remainingWork: readonly string[];
  readonly repository?: string;
  readonly branch?: string;
  readonly worktree?: string;
  readonly currentCommit?: string;
  readonly changedFiles: readonly string[];
  readonly findings: readonly string[];
  readonly hypotheses: readonly string[];
  readonly tests: readonly CheckpointTestResult[];
  readonly evidence: readonly CheckpointEvidence[];
  readonly blockingReason?: string;
  readonly lastAction: string;
  readonly resumeInstruction: string;
  readonly truncatedFields: readonly string[];
}

export type ResumeReason =
  | "TASK_NOT_FOUND"
  | "TASK_NOT_RESUMABLE"
  | "NO_CHECKPOINT"
  | "INVALID_CHECKPOINT"
  | "CHECKPOINT_NOT_LATEST_ATTEMPT"
  | "PREDECESSOR_ACTIVE"
  | "WORKSPACE_REFERENCE_MISSING"
  | "WORKSPACE_REFERENCE_STALE"
  | "WORKSPACE_CHECK_FAILED"
  | "CONTEXT_TOO_LARGE"
  | "CONCURRENT_SUCCESSOR"
  | "TASK_STORAGE_FAILURE"
  | "CHECKPOINT_STORAGE_FAILURE"
  | "ATTEMPT_STORAGE_FAILURE"
  | "SUCCESSOR_STORAGE_FAILURE";

export interface ResumeFailure {
  readonly outcome: "blocked" | "human_action_required" | "invalid_checkpoint";
  readonly reason: ResumeReason;
  readonly message: string;
  readonly field?: string;
}

export interface ResumeReady {
  readonly outcome: "ready";
  readonly context: ResumeContext;
}

export type ResumeContextResult = ResumeReady | ResumeFailure;
export interface StartedResumeAttempt {
  readonly outcome: "ready";
  readonly context: ResumeContext;
  readonly attempt: RetriedTask["attempt"];
}
export type ResumeStartResult = ResumeContextResult | StartedResumeAttempt;

function failure(outcome: ResumeFailure["outcome"], reason: ResumeReason, message: string, field?: string): ResumeFailure {
  return field === undefined ? { outcome, reason, message } : { outcome, reason, message, field };
}

function storageFailure(role: "task" | "checkpoint" | "attempt" | "successor", result: Exclude<StorageResult<unknown>, { outcome: "success" }>): ResumeFailure {
  if (result.outcome === "not_found" && role === "task") return failure("blocked", "TASK_NOT_FOUND", "Task was not found.");
  if (result.outcome === "not_found" && role === "checkpoint") return failure("blocked", "NO_CHECKPOINT", "No valid Checkpoint exists for the Task.");
  const reason: ResumeReason = role === "task" ? "TASK_STORAGE_FAILURE" : role === "checkpoint" ? "CHECKPOINT_STORAGE_FAILURE" : role === "attempt" ? "ATTEMPT_STORAGE_FAILURE" : "SUCCESSOR_STORAGE_FAILURE";
  return failure("blocked", reason, result.message);
}

function boundedList(values: readonly string[], field: string, truncated: string[]): readonly string[] {
  const result = values.slice(0, RESUME_CONTEXT_LIMITS.maxItems).map((value) => value.slice(0, RESUME_CONTEXT_LIMITS.maxItemCharacters));
  if (result.length !== values.length || result.some((value, index) => value !== values[index])) truncated.push(field);
  return Object.freeze(result);
}

function boundedTests(values: readonly CheckpointTestResult[], truncated: string[]): readonly CheckpointTestResult[] {
  const result = values.slice(0, RESUME_CONTEXT_LIMITS.maxItems).map((value) => ({ command: value.command.slice(0, RESUME_CONTEXT_LIMITS.maxTestCharacters), result: value.result.slice(0, RESUME_CONTEXT_LIMITS.maxTestCharacters) }));
  if (result.length !== values.length || result.some((value, index) => value.command !== values[index]?.command || value.result !== values[index]?.result)) truncated.push("tests");
  return Object.freeze(result);
}

function contextSize(context: ResumeContext): number {
  return new TextEncoder().encode(JSON.stringify(context)).byteLength;
}

function buildContext(task: TaskSnapshot, checkpoint: Checkpoint): ResumeContextResult {
  const truncatedFields: string[] = [];
  const context: ResumeContext = {
    kind: "resume_context",
    schemaVersion: RESUME_CONTEXT_SCHEMA_VERSION,
    taskId: task.id,
    previousAttemptId: checkpoint.previousAttemptId,
    checkpointId: checkpoint.id,
    goal: task.goal,
    currentState: checkpoint.currentState,
    completedWork: boundedList(checkpoint.completedWork, "completedWork", truncatedFields),
    remainingWork: boundedList(checkpoint.remainingWork, "remainingWork", truncatedFields),
    ...(checkpoint.repository === undefined ? {} : { repository: checkpoint.repository, branch: checkpoint.branch, worktree: checkpoint.worktree, currentCommit: checkpoint.currentCommit }),
    changedFiles: boundedList(checkpoint.changedFiles, "changedFiles", truncatedFields),
    findings: boundedList(checkpoint.findings, "findings", truncatedFields),
    hypotheses: boundedList(checkpoint.hypotheses, "hypotheses", truncatedFields),
    tests: boundedTests(checkpoint.tests, truncatedFields),
    evidence: Object.freeze(checkpoint.evidence.slice(0, RESUME_CONTEXT_LIMITS.maxItems)),
    ...(checkpoint.blockingReason === undefined ? {} : { blockingReason: checkpoint.blockingReason }),
    lastAction: checkpoint.lastAction,
    resumeInstruction: checkpoint.resumeInstruction,
    truncatedFields,
  };
  const removable: Array<keyof Pick<ResumeContext, "hypotheses" | "findings" | "completedWork" | "changedFiles" | "evidence">> = ["hypotheses", "findings", "completedWork", "changedFiles", "evidence"];
  for (const field of removable) {
    if (contextSize(context) <= RESUME_CONTEXT_LIMITS.serializedBytes) break;
    (context as unknown as Record<string, unknown>)[field] = [];
    if (!(context.truncatedFields as string[]).includes(field)) (context.truncatedFields as string[]).push(field);
  }
  if (contextSize(context) > RESUME_CONTEXT_LIMITS.serializedBytes) return failure("invalid_checkpoint", "CONTEXT_TOO_LARGE", `ResumeContext exceeds ${RESUME_CONTEXT_LIMITS.serializedBytes} bytes.`);
  return { outcome: "ready", context: Object.freeze({ ...context, truncatedFields: Object.freeze([...context.truncatedFields]) }) };
}

function workspaceFailure(check: WorkspaceReferenceCheck): ResumeFailure | undefined {
  const fields: readonly [keyof WorkspaceReferenceCheck, string][] = [["repository", "repository"], ["worktree", "worktree"], ["branch", "branch"], ["currentCommit", "currentCommit"]];
  for (const [field, label] of fields) {
    const status = check[field];
    if (status === "missing") return failure("human_action_required", "WORKSPACE_REFERENCE_MISSING", `${label} reference is missing and must be repaired by a human.`, label);
    if (status === "stale") return failure("human_action_required", "WORKSPACE_REFERENCE_STALE", `${label} reference is stale and must be repaired by a human.`, label);
    if (status !== "present") return failure("human_action_required", "WORKSPACE_CHECK_FAILED", `${label} workspace check returned an unsupported status.`, label);
  }
  return undefined;
}

function concurrentSuccessor(store: RuntimeSqliteStore, taskId: string, result: ResumeContextResult): ResumeContextResult {
  if (result.outcome === "ready" || result.reason !== "CHECKPOINT_NOT_LATEST_ATTEMPT") return result;
  const checkpoint = store.checkpoints.latestByTask(taskId);
  const attempts = store.attempts.listByTask(taskId);
  if (checkpoint.outcome === "success" && attempts.outcome === "success") {
    const latest = attempts.value[attempts.value.length - 1];
    if (latest?.predecessorAttemptId === checkpoint.value.previousAttemptId) return failure("blocked", "CONCURRENT_SUCCESSOR", "Another successor Attempt was created while resume was being prepared.");
  }
  return result;
}

export function buildResumeContext(store: RuntimeSqliteStore, taskId: string, workspace: WorkspaceReferencePort): ResumeContextResult {
  const task = store.tasks.get(taskId);
  if (task.outcome !== "success") return storageFailure("task", task);
  const checkpoint = store.checkpoints.latestByTask(taskId);
  if (checkpoint.outcome !== "success") {
    if (checkpoint.outcome === "not_found") return failure("blocked", "NO_CHECKPOINT", checkpoint.message);
    if (checkpoint.outcome === "invalid_record") return failure("invalid_checkpoint", "INVALID_CHECKPOINT", checkpoint.message);
    return storageFailure("checkpoint", checkpoint);
  }
  if (task.value.state !== "in_progress" && task.value.state !== "blocked" && task.value.state !== "failed") return failure("blocked", "TASK_NOT_RESUMABLE", `Task state ${task.value.state} cannot be resumed.`);
  const attempts = store.attempts.listByTask(taskId);
  if (attempts.outcome !== "success") return storageFailure("attempt", attempts);
  const predecessor = attempts.value.find((attempt) => attempt.id === checkpoint.value.previousAttemptId);
  const latest = attempts.value[attempts.value.length - 1];
  if (predecessor === undefined || latest?.id !== checkpoint.value.previousAttemptId) return failure("invalid_checkpoint", "CHECKPOINT_NOT_LATEST_ATTEMPT", "Checkpoint does not reference the latest Attempt of the Task.", "previousAttemptId");
  if (predecessor.state === "running") return failure("blocked", "PREDECESSOR_ACTIVE", "The predecessor Attempt is still active.");
  if (checkpoint.value.currentState !== task.value.state) return failure("invalid_checkpoint", "INVALID_CHECKPOINT", "Checkpoint currentState does not match the Task state.", "currentState");
  if (checkpoint.value.repository !== undefined) {
    try {
      const checked = workspace.check({ repository: checkpoint.value.repository, branch: checkpoint.value.branch as string, worktree: checkpoint.value.worktree as string, currentCommit: checkpoint.value.currentCommit as string });
      const blocked = workspaceFailure(checked);
      if (blocked !== undefined) return blocked;
    } catch {
      return failure("human_action_required", "WORKSPACE_CHECK_FAILED", "Workspace reference checking failed before resume.");
    }
  }
  return buildContext(task.value, checkpoint.value);
}

interface ResumeTransactionDecision {
  readonly kind: "decision";
  readonly result: ResumeContextResult;
}
interface ResumeTransactionStarted {
  readonly kind: "started";
  readonly context: ResumeContext;
  readonly attempt: RetriedTask["attempt"];
}

export function startResumedAttempt(store: RuntimeSqliteStore, taskId: string, workspace: WorkspaceReferencePort, input: Omit<StartAttemptInput, "predecessorAttemptId">, evaluatedAt: UtcTimestamp): ResumeStartResult {
  const initial = buildResumeContext(store, taskId, workspace);
  if (initial.outcome !== "ready") return concurrentSuccessor(store, taskId, initial);
  const committed = store.transaction<ResumeTransactionDecision | ResumeTransactionStarted>(({ tasks, attempts }) => {
    const current = buildResumeContext(store, taskId, workspace);
    if (current.outcome !== "ready") return { outcome: "success" as const, value: { kind: "decision" as const, result: concurrentSuccessor(store, taskId, current) } satisfies ResumeTransactionDecision };
    const task = tasks.get(taskId);
    const history = attempts.listByTask(taskId);
    if (task.outcome !== "success") return task;
    if (history.outcome !== "success") return history;
    const predecessor = history.value[history.value.length - 1];
    if (predecessor?.id !== current.context.previousAttemptId) return { outcome: "success" as const, value: { kind: "decision" as const, result: failure("blocked", "CONCURRENT_SUCCESSOR", "Another successor Attempt was created while resume was being prepared.") } satisfies ResumeTransactionDecision };
    const started = retryTask(task.value, history.value, { ...input, predecessorAttemptId: current.context.previousAttemptId, checkpointReference: current.context.checkpointId }, evaluatedAt);
    if (!started.ok) return { outcome: "success" as const, value: { kind: "decision" as const, result: failure("blocked", "CONCURRENT_SUCCESSOR", started.error.message) } satisfies ResumeTransactionDecision };
    const taskUpdate = tasks.update(started.value.task, { state: task.value.state, updatedAt: task.value.updatedAt });
    if (taskUpdate.outcome !== "success") return taskUpdate;
    const attempt = attempts.create(started.value.attempt);
    if (attempt.outcome !== "success") return attempt;
    return { outcome: "success" as const, value: { kind: "started" as const, context: current.context, attempt: started.value.attempt } satisfies ResumeTransactionStarted };
  });
  if (committed.outcome !== "success") return storageFailure("successor", committed);
  return committed.value.kind === "decision" ? committed.value.result : { outcome: "ready", context: committed.value.context, attempt: committed.value.attempt };
}
