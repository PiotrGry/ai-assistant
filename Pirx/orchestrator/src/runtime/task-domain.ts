export const TASK_DOMAIN_SCHEMA_VERSION = 1 as const;

export type TaskId = string & { readonly __brand: "TaskId" };
export type AttemptId = string & { readonly __brand: "AttemptId" };
export type UtcTimestamp = string & { readonly __brand: "UtcTimestamp" };

export type TaskState = "ready" | "in_progress" | "blocked" | "failed" | "completed" | "cancelled";
export type AttemptState = "running" | "terminal";
export type AttemptResult = "CODE_PUSHED" | "BLOCKED" | "FAILED" | "QUOTA_EXHAUSTED" | "CANCELLED" | "UNKNOWN";
export type TaskRisk = "low" | "medium" | "high" | "critical";
export type TaskPriority = number;

export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  ready: ["in_progress", "blocked", "cancelled"],
  in_progress: ["blocked", "failed", "completed", "cancelled"],
  blocked: ["ready", "in_progress", "cancelled"],
  failed: ["ready", "in_progress", "cancelled"],
  completed: [],
  cancelled: [],
});

export const ATTEMPT_RESULTS: readonly AttemptResult[] = Object.freeze([
  "CODE_PUSHED", "BLOCKED", "FAILED", "QUOTA_EXHAUSTED", "CANCELLED", "UNKNOWN",
]);

export interface GitHubTaskReference {
  readonly owner: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly nodeId?: string;
  readonly url?: string;
}

export interface TaskSnapshot {
  readonly kind: "task";
  readonly schemaVersion: typeof TASK_DOMAIN_SCHEMA_VERSION;
  readonly id: TaskId;
  readonly githubReference?: GitHubTaskReference;
  readonly goal: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly priority: TaskPriority;
  readonly risk: TaskRisk;
  readonly requiredCapabilities: readonly string[];
  readonly state: TaskState;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly blockingReason?: string;
  readonly completionEvidence?: TaskCompletionEvidence;
}

export interface RunningAttemptSnapshot {
  readonly kind: "attempt";
  readonly schemaVersion: typeof TASK_DOMAIN_SCHEMA_VERSION;
  readonly id: AttemptId;
  readonly taskId: TaskId;
  readonly ordinal: number;
  readonly worker: string;
  readonly provider: string;
  readonly state: "running";
  readonly startedAt: UtcTimestamp;
  readonly branch?: string;
  readonly worktree?: string;
  readonly currentCommit?: string;
  readonly checkpointReference?: string;
}

export interface TerminalAttemptSnapshot extends Omit<RunningAttemptSnapshot, "state"> {
  readonly state: "terminal";
  readonly result: AttemptResult;
  readonly endedAt: UtcTimestamp;
  readonly finalCommit?: string;
  readonly blockingReason?: string;
}

export type AttemptSnapshot = RunningAttemptSnapshot | TerminalAttemptSnapshot;

export interface TaskInput {
  readonly id: TaskId;
  readonly githubReference?: GitHubTaskReference;
  readonly goal: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly priority: TaskPriority;
  readonly risk: TaskRisk;
  readonly requiredCapabilities: readonly string[];
  readonly createdAt: UtcTimestamp;
  readonly updatedAt?: UtcTimestamp;
  readonly state?: TaskState;
  readonly blockingReason?: string;
  readonly completionEvidence?: TaskCompletionEvidence;
}

export interface StartAttemptInput {
  readonly id: AttemptId;
  readonly worker: string;
  readonly provider: string;
  readonly branch?: string;
  readonly worktree?: string;
  readonly currentCommit?: string;
  readonly checkpointReference?: string;
}

export interface RetryTaskInput extends StartAttemptInput {}

export interface TaskCompletionEvidence {
  readonly attemptId: AttemptId;
  readonly finalCommit: string;
  readonly evidenceReference: string;
}

export type TaskTransition =
  | { readonly type: "start" }
  | { readonly type: "unblock" }
  | { readonly type: "block"; readonly reason: string }
  | { readonly type: "fail"; readonly reason: string }
  | { readonly type: "cancel"; readonly reason: string }
  | { readonly type: "complete"; readonly evidence: TaskCompletionEvidence; readonly attempts: readonly AttemptSnapshot[] };

export type AttemptTransition =
  | {
      readonly type: "finish";
      readonly result: AttemptResult;
      readonly finalCommit?: string;
      readonly blockingReason?: string;
      readonly currentCommit?: string;
      readonly checkpointReference?: string;
    };

export type DomainErrorCode =
  | "invalid_input"
  | "invalid_id"
  | "invalid_timestamp"
  | "invalid_enum"
  | "invalid_state"
  | "invalid_transition"
  | "invariant_violation"
  | "serialization_error";

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly field?: string;
}

export type DomainResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError };
export interface StartedAttempt {
  readonly task: TaskSnapshot;
  readonly attempt: RunningAttemptSnapshot;
}
export interface RetriedTask {
  readonly task: TaskSnapshot;
  readonly attempt: RunningAttemptSnapshot;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RISK_VALUES = new Set<TaskRisk>(["low", "medium", "high", "critical"]);
const TASK_STATES = new Set<TaskState>(["ready", "in_progress", "blocked", "failed", "completed", "cancelled"]);
const ATTEMPT_RESULT_SET = new Set<AttemptResult>(ATTEMPT_RESULTS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function ok<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}
function error(code: DomainErrorCode, message: string, field?: string): DomainResult<never> {
  return field === undefined ? { ok: false, error: { code, message } } : { ok: false, error: { code, message, field } };
}
function text(value: unknown, field: string, maxLength = 2_000): string | DomainError {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) return { code: "invalid_input", message: `${field} must be a non-empty bounded string.`, field };
  return value.trim();
}
function id(value: unknown, kind: "TaskId" | "AttemptId"): string | DomainError {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return { code: "invalid_id", message: `${kind} is invalid.`, field: "id" };
  return value;
}
function timestamp(value: unknown, field: string): UtcTimestamp | DomainError {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return { code: "invalid_timestamp", message: `${field} must be a canonical UTC ISO timestamp.`, field };
  return value as UtcTimestamp;
}
function reason(value: unknown, field: string): string | DomainError {
  return text(value, field, 1_000);
}
function arrayOfText(value: unknown, field: string, required: boolean): readonly string[] | DomainError {
  if (!Array.isArray(value)) return { code: "invalid_input", message: `${field} must be an array.`, field };
  const values: string[] = [];
  for (const item of value) {
    const parsed = text(item, field, 512);
    if (typeof parsed !== "string") return parsed;
    if (!values.includes(parsed)) values.push(parsed);
  }
  if (required && values.length === 0) return { code: "invalid_input", message: `${field} must contain at least one item.`, field };
  return Object.freeze(values);
}
function freezeReference(value: GitHubTaskReference): GitHubTaskReference {
  return Object.freeze({ ...value });
}
function freezeCompletionEvidence(value: TaskCompletionEvidence): TaskCompletionEvidence {
  return Object.freeze({ ...value });
}
function freezeTask(value: TaskSnapshot): TaskSnapshot {
  if (value.githubReference !== undefined) freezeReference(value.githubReference);
  if (value.completionEvidence !== undefined) freezeCompletionEvidence(value.completionEvidence);
  Object.freeze(value.acceptanceCriteria);
  Object.freeze(value.requiredCapabilities);
  return Object.freeze(value);
}
function freezeAttempt<T extends AttemptSnapshot>(value: T): T {
  return Object.freeze(value);
}
function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && TASK_STATES.has(value as TaskState);
}
function isAttemptResult(value: unknown): value is AttemptResult {
  return typeof value === "string" && ATTEMPT_RESULT_SET.has(value as AttemptResult);
}
function laterThanOrEqual(next: UtcTimestamp, previous: UtcTimestamp): boolean {
  return Date.parse(next) >= Date.parse(previous);
}
function safeOptionalText(value: unknown, field: string, maxLength = 1_000): DomainResult<string | undefined> {
  if (value === undefined) return ok(undefined);
  const parsed = text(value, field, maxLength);
  return typeof parsed === "string" ? ok(parsed) : { ok: false, error: parsed };
}
function validateGitHubReference(value: unknown): DomainResult<GitHubTaskReference | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return error("invalid_input", "githubReference must be an object.", "githubReference");
  const owner = text(value.owner, "githubReference.owner", 100);
  const repository = text(value.repository, "githubReference.repository", 100);
  if (typeof owner !== "string") return { ok: false, error: owner };
  if (typeof repository !== "string") return { ok: false, error: repository };
  if (!Number.isSafeInteger(value.issueNumber) || (value.issueNumber as number) <= 0) return error("invalid_input", "issueNumber must be a positive integer.", "githubReference.issueNumber");
  const nodeId = safeOptionalText(value.nodeId, "githubReference.nodeId", 256);
  const url = safeOptionalText(value.url, "githubReference.url", 2_048);
  if (!nodeId.ok) return nodeId;
  if (!url.ok) return url;
  if ((nodeId.value === undefined) !== (url.value === undefined)) return error("invariant_violation", "nodeId and url must be supplied together.", "githubReference");
  if (url.value !== undefined) {
    try {
      const parsed = new URL(url.value);
      if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" || parsed.pathname !== `/${owner}/${repository}/issues/${String(value.issueNumber)}`) return error("invalid_input", "githubReference.url must be the canonical HTTPS GitHub Issue URL.", "githubReference.url");
    } catch {
      return error("invalid_input", "githubReference.url must be a valid canonical URL.", "githubReference.url");
    }
  }
  return ok(freezeReference({ owner, repository, issueNumber: value.issueNumber as number, ...(nodeId.value === undefined ? {} : { nodeId: nodeId.value, url: url.value as string }) }));
}
function validTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100;
}
function validateCompletionEvidence(value: unknown): DomainResult<TaskCompletionEvidence | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return error("invalid_input", "completionEvidence must be an object.", "completionEvidence");
  const attempt = id(value.attemptId, "AttemptId");
  const commit = text(value.finalCommit, "completionEvidence.finalCommit", 256);
  const reference = text(value.evidenceReference, "completionEvidence.evidenceReference", 1_000);
  if (typeof attempt !== "string") return { ok: false, error: attempt };
  if (typeof commit !== "string") return { ok: false, error: commit };
  if (typeof reference !== "string") return { ok: false, error: reference };
  return ok(freezeCompletionEvidence({ attemptId: attempt as AttemptId, finalCommit: commit, evidenceReference: reference }));
}

export function taskId(value: string): DomainResult<TaskId> {
  const parsed = id(value, "TaskId");
  return typeof parsed === "string" ? ok(parsed as TaskId) : { ok: false, error: parsed };
}
export function attemptId(value: string): DomainResult<AttemptId> {
  const parsed = id(value, "AttemptId");
  return typeof parsed === "string" ? ok(parsed as AttemptId) : { ok: false, error: parsed };
}
export function utcTimestamp(value: string): DomainResult<UtcTimestamp> {
  const parsed = timestamp(value, "timestamp");
  return typeof parsed === "string" ? ok(parsed) : { ok: false, error: parsed };
}

export function createTask(input: TaskInput): DomainResult<TaskSnapshot> {
  const parsedId = id(input.id, "TaskId");
  if (typeof parsedId !== "string") return { ok: false, error: parsedId };
  const goal = text(input.goal, "goal");
  const scope = text(input.scope, "scope");
  const criteria = arrayOfText(input.acceptanceCriteria, "acceptanceCriteria", true);
  const capabilities = arrayOfText(input.requiredCapabilities, "requiredCapabilities", true);
  const createdAt = timestamp(input.createdAt, "createdAt");
  const updatedAt = timestamp(input.updatedAt ?? input.createdAt, "updatedAt");
  const reference = validateGitHubReference(input.githubReference);
  if (typeof goal !== "string") return { ok: false, error: goal };
  if (typeof scope !== "string") return { ok: false, error: scope };
  if (!validTaskPriority(input.priority)) return error("invalid_input", "priority must be an integer from 0 to 100.", "priority");
  if (typeof input.risk !== "string" || !RISK_VALUES.has(input.risk)) return error("invalid_enum", "risk is unsupported.", "risk");
  if (!isTaskState(input.state ?? "ready")) return error("invalid_enum", "state is unsupported.", "state");
  if ("code" in criteria) return { ok: false, error: criteria };
  if ("code" in capabilities) return { ok: false, error: capabilities };
  if (typeof createdAt !== "string") return { ok: false, error: createdAt };
  if (typeof updatedAt !== "string") return { ok: false, error: updatedAt };
  if (!laterThanOrEqual(updatedAt, createdAt)) return error("invariant_violation", "updatedAt cannot precede createdAt.", "updatedAt");
  if (!reference.ok) return reference;
  const blocking = safeOptionalText(input.blockingReason, "blockingReason");
  if (!blocking.ok) return blocking;
  const state = input.state ?? "ready";
  const requiresReason = state === "blocked" || state === "failed" || state === "cancelled";
  if (requiresReason !== (blocking.value !== undefined)) return error("invariant_violation", "blockingReason is required for blocked, failed, and cancelled Tasks only.", "blockingReason");
  const completionEvidence = validateCompletionEvidence(input.completionEvidence);
  if (!completionEvidence.ok) return completionEvidence;
  if ((input.state ?? "ready") === "completed" && completionEvidence.value === undefined) return error("invariant_violation", "completed Task requires completionEvidence.", "completionEvidence");
  if ((input.state ?? "ready") !== "completed" && completionEvidence.value !== undefined) return error("invariant_violation", "completionEvidence requires completed state.", "completionEvidence");
  const value: TaskSnapshot = {
    kind: "task", schemaVersion: TASK_DOMAIN_SCHEMA_VERSION, id: parsedId as TaskId,
    ...(reference.value === undefined ? {} : { githubReference: reference.value }),
    goal, scope, acceptanceCriteria: criteria, priority: input.priority, risk: input.risk,
    requiredCapabilities: capabilities, state: input.state ?? "ready", createdAt, updatedAt,
    ...(blocking.value === undefined ? {} : { blockingReason: blocking.value }),
    ...(completionEvidence.value === undefined ? {} : { completionEvidence: completionEvidence.value }),
  };
  return ok(freezeTask(value));
}

function validateTaskSnapshot(value: unknown): DomainResult<TaskSnapshot> {
  if (!isRecord(value) || value.kind !== "task" || value.schemaVersion !== TASK_DOMAIN_SCHEMA_VERSION) return error("serialization_error", "Task snapshot schema version or kind is unsupported.");
  return createTask({
    id: value.id as TaskId,
    ...(value.githubReference === undefined ? {} : { githubReference: value.githubReference as GitHubTaskReference }),
    goal: value.goal as string, scope: value.scope as string, acceptanceCriteria: value.acceptanceCriteria as readonly string[],
    priority: value.priority as number, risk: value.risk as TaskRisk, requiredCapabilities: value.requiredCapabilities as readonly string[],
    state: value.state as TaskState, createdAt: value.createdAt as UtcTimestamp, updatedAt: value.updatedAt as UtcTimestamp,
    ...(value.blockingReason === undefined ? {} : { blockingReason: value.blockingReason as string }),
    ...(value.completionEvidence === undefined ? {} : { completionEvidence: value.completionEvidence as TaskCompletionEvidence }),
  });
}

function validateAttemptSnapshot(value: unknown): DomainResult<AttemptSnapshot> {
  if (!isRecord(value) || value.kind !== "attempt" || value.schemaVersion !== TASK_DOMAIN_SCHEMA_VERSION) return error("serialization_error", "Attempt snapshot schema version or kind is unsupported.");
  const parsedId = id(value.id, "AttemptId");
  const parsedTaskId = id(value.taskId, "TaskId");
  const worker = text(value.worker, "worker", 200);
  const provider = text(value.provider, "provider", 200);
  const startedAt = timestamp(value.startedAt, "startedAt");
  if (typeof parsedId !== "string") return { ok: false, error: parsedId };
  if (typeof parsedTaskId !== "string") return { ok: false, error: parsedTaskId };
  if (typeof worker !== "string") return { ok: false, error: worker };
  if (typeof provider !== "string") return { ok: false, error: provider };
  if (!Number.isSafeInteger(value.ordinal) || (value.ordinal as number) <= 0) return error("invariant_violation", "ordinal must be a positive integer.", "ordinal");
  if (typeof startedAt !== "string") return { ok: false, error: startedAt };
  const optionalFields: Array<[string, unknown, number]> = [["branch", value.branch, 512], ["worktree", value.worktree, 1_000], ["currentCommit", value.currentCommit, 256], ["checkpointReference", value.checkpointReference, 1_000]];
  const normalized: Record<string, string> = {};
  for (const [field, raw, max] of optionalFields) {
    const parsed = safeOptionalText(raw, field, max);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) normalized[field] = parsed.value;
  }
  const common = { kind: "attempt" as const, schemaVersion: TASK_DOMAIN_SCHEMA_VERSION, id: parsedId as AttemptId, taskId: parsedTaskId as TaskId, ordinal: value.ordinal as number, worker, provider, state: "running" as const, startedAt, ...normalized };
  if (value.state === "running") return ok(freezeAttempt(common as RunningAttemptSnapshot));
  if (value.state !== "terminal" || !isAttemptResult(value.result)) return error("invalid_enum", "Attempt state or result is unsupported.", "state");
  const endedAt = timestamp(value.endedAt, "endedAt");
  if (typeof endedAt !== "string") return { ok: false, error: endedAt };
  if (!laterThanOrEqual(endedAt, startedAt)) return error("invariant_violation", "endedAt cannot precede startedAt.", "endedAt");
  const finalCommit = safeOptionalText(value.finalCommit, "finalCommit", 256);
  const blocking = safeOptionalText(value.blockingReason, "blockingReason");
  if (!finalCommit.ok) return finalCommit;
  if (!blocking.ok) return blocking;
  if (value.result === "CODE_PUSHED" && finalCommit.value === undefined) return error("invariant_violation", "CODE_PUSHED requires finalCommit.", "finalCommit");
  if (value.result !== "CODE_PUSHED" && blocking.value === undefined) return error("invariant_violation", `${value.result} requires blockingReason.`, "blockingReason");
  return ok(freezeAttempt({ ...common, state: "terminal", result: value.result, endedAt, ...(finalCommit.value === undefined ? {} : { finalCommit: finalCommit.value }), ...(blocking.value === undefined ? {} : { blockingReason: blocking.value }) }));
}

function validateAttemptSet(task: TaskSnapshot, attempts: readonly AttemptSnapshot[]): DomainResult<void> {
  let previousOrdinal = 0;
  let active = false;
  for (const attempt of attempts) {
    const valid = validateAttemptSnapshot(attempt);
    if (!valid.ok) return valid;
    if (attempt.taskId !== task.id) return error("invariant_violation", "Every Attempt must reference the Task.", "taskId");
    if (attempt.ordinal !== previousOrdinal + 1) return error("invariant_violation", "Attempt ordinals must be unique and contiguous.", "ordinal");
    previousOrdinal = attempt.ordinal;
    if (attempt.state === "running") {
      if (active) return error("invariant_violation", "At most one non-terminal Attempt may exist.");
      active = true;
    }
  }
  return ok(undefined);
}

function makeRunningAttempt(taskId: TaskId, ordinal: number, input: StartAttemptInput, evaluatedAt: UtcTimestamp): DomainResult<RunningAttemptSnapshot> {
  const parsedId = id(input.id, "AttemptId");
  const worker = text(input.worker, "worker", 200);
  const provider = text(input.provider, "provider", 200);
  if (typeof parsedId !== "string") return { ok: false, error: parsedId };
  if (typeof worker !== "string") return { ok: false, error: worker };
  if (typeof provider !== "string") return { ok: false, error: provider };
  const fields: Record<string, string> = {};
  for (const [field, raw, max] of [["branch", input.branch, 512], ["worktree", input.worktree, 1_000], ["currentCommit", input.currentCommit, 256], ["checkpointReference", input.checkpointReference, 1_000]] as const) {
    const parsed = safeOptionalText(raw, field, max);
    if (!parsed.ok) return parsed;
    if (parsed.value !== undefined) fields[field] = parsed.value;
  }
  return ok(freezeAttempt({ kind: "attempt", schemaVersion: TASK_DOMAIN_SCHEMA_VERSION, id: parsedId as AttemptId, taskId, ordinal, worker, provider, state: "running", startedAt: evaluatedAt, ...fields }));
}

export function startInitialAttempt(task: TaskSnapshot, attempts: readonly AttemptSnapshot[], input: StartAttemptInput, evaluatedAt: UtcTimestamp): DomainResult<StartedAttempt> {
  const valid = validateAttemptSet(task, attempts);
  if (!valid.ok) return valid;
  if (task.state !== "ready" || attempts.length !== 0) return error("invalid_transition", "Initial Attempt requires a ready Task with no previous Attempts.");
  const attempt = makeRunningAttempt(task.id, 1, input, evaluatedAt);
  if (!attempt.ok) return attempt;
  const transitioned = transitionTask(task, task.state, { type: "start" }, evaluatedAt);
  return transitioned.ok ? ok({ task: transitioned.value, attempt: attempt.value }) : transitioned;
}

export function retryTask(task: TaskSnapshot, attempts: readonly AttemptSnapshot[], input: RetryTaskInput, evaluatedAt: UtcTimestamp): DomainResult<RetriedTask> {
  const valid = validateAttemptSet(task, attempts);
  if (!valid.ok) return valid;
  if (attempts.length === 0 || (task.state !== "in_progress" && task.state !== "blocked" && task.state !== "failed")) return error("invalid_transition", "Task is not eligible for retry.");
  if (attempts.some((attempt) => attempt.state === "running")) return error("invariant_violation", "A Task with an active Attempt cannot be retried.");
  if (!laterThanOrEqual(evaluatedAt, task.updatedAt)) return error("invalid_timestamp", "Retry evaluation time cannot precede Task updatedAt.", "evaluatedAt");
  const attempt = makeRunningAttempt(task.id, attempts.length + 1, input, evaluatedAt);
  if (!attempt.ok) return attempt;
  const taskResult = transitionTask(task, task.state, { type: "start" }, evaluatedAt);
  return taskResult.ok ? ok({ task: taskResult.value, attempt: attempt.value }) : taskResult;
}

export function transitionTask(task: TaskSnapshot, expectedState: TaskState, transition: TaskTransition, evaluatedAt: UtcTimestamp): DomainResult<TaskSnapshot> {
  if (task.state !== expectedState) return error("invariant_violation", `Expected Task state ${expectedState}, found ${task.state}.`, "expectedState");
  if (!laterThanOrEqual(evaluatedAt, task.updatedAt)) return error("invalid_timestamp", "Evaluation time cannot precede Task updatedAt.", "evaluatedAt");
  let next: TaskState;
  let nextReason: string | undefined;
  let completionEvidence: TaskCompletionEvidence | undefined;
  switch (transition.type) {
    case "start": next = "in_progress"; break;
    case "unblock": next = "ready"; break;
    case "block": next = "blocked"; nextReason = transition.reason; break;
    case "fail": next = "failed"; nextReason = transition.reason; break;
    case "cancel": next = "cancelled"; nextReason = transition.reason; break;
    case "complete": {
      const evidence = validateCompletionEvidence(transition.evidence);
      if (!evidence.ok) return evidence;
      if (evidence.value === undefined) return error("invariant_violation", "completed Task requires completionEvidence.", "completionEvidence");
      const attempts = validateAttemptSet(task, transition.attempts);
      if (!attempts.ok) return attempts;
      const { attemptId: evidenceAttemptId, finalCommit } = evidence.value;
      const backing = transition.attempts.find((attempt) => attempt.id === evidenceAttemptId);
      if (backing?.state !== "terminal" || backing.result !== "CODE_PUSHED" || backing.finalCommit !== finalCommit || transition.attempts.some((attempt) => attempt.state === "running")) {
        return error("invariant_violation", "completionEvidence must reference a terminal CODE_PUSHED Attempt of this Task with the same finalCommit.", "completionEvidence");
      }
      completionEvidence = evidence.value;
      next = "completed";
      break;
    }
    default: return error("invalid_transition", "Unknown Task transition.");
  }
  if (!TASK_TRANSITIONS[task.state].includes(next)) return error("invalid_transition", `Task cannot transition from ${task.state} to ${next}.`);
  const parsedReason = nextReason === undefined ? undefined : reason(nextReason, "blockingReason");
  if (parsedReason !== undefined && typeof parsedReason !== "string") return { ok: false, error: parsedReason };
  const { blockingReason: _oldBlockingReason, completionEvidence: _oldCompletionEvidence, ...withoutTerminalEvidence } = task;
  return ok(freezeTask({
    ...withoutTerminalEvidence,
    state: next,
    updatedAt: evaluatedAt,
    ...(parsedReason === undefined ? {} : { blockingReason: parsedReason }),
    ...(completionEvidence === undefined ? {} : { completionEvidence }),
  }));
}

export function transitionAttempt(attempt: AttemptSnapshot, expectedState: AttemptState, transition: AttemptTransition, evaluatedAt: UtcTimestamp): DomainResult<TerminalAttemptSnapshot> {
  if (attempt.state !== expectedState) return error("invariant_violation", `Expected Attempt state ${expectedState}, found ${attempt.state}.`, "expectedState");
  if (attempt.state !== "running" || transition.type !== "finish") return error("invalid_transition", "Only a running Attempt can be finished.");
  if (!laterThanOrEqual(evaluatedAt, attempt.startedAt)) return error("invalid_timestamp", "Attempt end time cannot precede start time.", "evaluatedAt");
  if (!isAttemptResult(transition.result)) return error("invalid_enum", "Attempt result is unsupported.", "result");
  const finalCommit = safeOptionalText(transition.finalCommit, "finalCommit", 256);
  const blocking = safeOptionalText(transition.blockingReason, "blockingReason");
  const currentCommit = safeOptionalText(transition.currentCommit, "currentCommit", 256);
  const checkpoint = safeOptionalText(transition.checkpointReference, "checkpointReference", 1_000);
  if (!finalCommit.ok) return finalCommit;
  if (!blocking.ok) return blocking;
  if (!currentCommit.ok) return currentCommit;
  if (!checkpoint.ok) return checkpoint;
  if (transition.result === "CODE_PUSHED" && finalCommit.value === undefined) return error("invariant_violation", "CODE_PUSHED requires finalCommit.", "finalCommit");
  if (transition.result !== "CODE_PUSHED" && blocking.value === undefined) return error("invariant_violation", `${transition.result} requires blockingReason.`, "blockingReason");
  return ok(freezeAttempt({ ...attempt, state: "terminal", result: transition.result, endedAt: evaluatedAt, ...(finalCommit.value === undefined ? {} : { finalCommit: finalCommit.value }), ...(blocking.value === undefined ? {} : { blockingReason: blocking.value }), ...(currentCommit.value === undefined ? {} : { currentCommit: currentCommit.value }), ...(checkpoint.value === undefined ? {} : { checkpointReference: checkpoint.value }) }));
}

export function serializeTask(task: TaskSnapshot): string {
  return JSON.stringify(task);
}
export function serializeAttempt(attempt: AttemptSnapshot): string {
  return JSON.stringify(attempt);
}
export function deserializeTask(serialized: string): DomainResult<TaskSnapshot> {
  try { return validateTaskSnapshot(JSON.parse(serialized) as unknown); }
  catch { return error("serialization_error", "Task snapshot is not valid JSON."); }
}
export function deserializeAttempt(serialized: string): DomainResult<AttemptSnapshot> {
  try { return validateAttemptSnapshot(JSON.parse(serialized) as unknown); }
  catch { return error("serialization_error", "Attempt snapshot is not valid JSON."); }
}
