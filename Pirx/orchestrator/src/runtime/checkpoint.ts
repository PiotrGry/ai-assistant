import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

export const CHECKPOINT_TRIGGERS = Object.freeze([
  "PROVIDER_QUOTA",
  "WORKER_INTERRUPTION",
  "MACHINE_RESTART",
  "EXPLICIT_PAUSE",
  "RECOVERABLE_FAILURE",
  "REQUIRED_ATTEMPT",
] as const);

export type CheckpointTrigger = (typeof CHECKPOINT_TRIGGERS)[number];
export type CheckpointId = string & { readonly __brand: "CheckpointId" };

export const CHECKPOINT_LIMITS = Object.freeze({
  id: 128,
  shortText: 512,
  longText: 2_000,
  path: 512,
  collection: 100,
  changedFiles: 200,
  evidence: 100,
  serializedBytes: 50_000,
} as const);

export interface CheckpointTestResult {
  readonly command: string;
  readonly result: string;
}

export interface CheckpointEvidence {
  readonly reference: string;
  readonly summary: string;
}

export interface Checkpoint {
  readonly kind: "checkpoint";
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly id: CheckpointId;
  readonly taskId: TaskId;
  readonly previousAttemptId: AttemptId;
  readonly trigger: CheckpointTrigger;
  readonly createdAt: UtcTimestamp;
  readonly goal: string;
  readonly currentState: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly worktree?: string;
  readonly currentCommit?: string;
  readonly completedWork: readonly string[];
  readonly remainingWork: readonly string[];
  readonly changedFiles: readonly string[];
  readonly findings: readonly string[];
  readonly hypotheses: readonly string[];
  readonly tests: readonly CheckpointTestResult[];
  readonly evidence: readonly CheckpointEvidence[];
  readonly blockingReason?: string;
  readonly lastAction: string;
  readonly resumeInstruction: string;
}

export interface CheckpointInput extends Omit<Checkpoint, "kind" | "schemaVersion" | "id" | "taskId" | "previousAttemptId" | "createdAt"> {
  readonly id: CheckpointId;
  readonly taskId: TaskId;
  readonly previousAttemptId: AttemptId;
  readonly createdAt: UtcTimestamp;
}

export type CheckpointViolationCode =
  | "invalid_input"
  | "invalid_id"
  | "invalid_timestamp"
  | "invalid_enum"
  | "invariant_violation"
  | "unsupported_version"
  | "unsafe_path"
  | "conflicting_evidence"
  | "forbidden_field"
  | "limit_exceeded"
  | "serialization_error";

export interface CheckpointViolation {
  readonly code: CheckpointViolationCode;
  readonly field: string;
  readonly message: string;
}

export type CheckpointResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violations: readonly CheckpointViolation[] };

const TRIGGER_SET = new Set<string>(CHECKPOINT_TRIGGERS);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SECRET_FIELD_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key|credential)/iu;

function ok<T>(value: T): CheckpointResult<T> {
  return { ok: true, value };
}

function failure(...violations: CheckpointViolation[]): CheckpointResult<never> {
  return { ok: false, violations: Object.freeze(violations) };
}

function violation(code: CheckpointViolationCode, field: string, message: string): CheckpointViolation {
  return { code, field, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string, maxLength: number, required = true): string | CheckpointViolation {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && value.trim().length === 0) || value.length > maxLength) {
    return violation(value !== undefined && typeof value === "string" && value.length > maxLength ? "limit_exceeded" : "invalid_input", field, `${field} must be a ${required ? "non-empty " : ""}string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined | CheckpointViolation {
  if (value === undefined) return undefined;
  const parsed = text(value, field, maxLength);
  return typeof parsed === "string" ? parsed : parsed;
}

function identifier(value: unknown, field: string): string | CheckpointViolation {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) return violation("invalid_id", field, `${field} must be an opaque identifier.`);
  return value;
}

function timestamp(value: unknown, field: string): string | CheckpointViolation {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    return violation("invalid_timestamp", field, `${field} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function listOfText(value: unknown, field: string, maxItems = CHECKPOINT_LIMITS.collection): CheckpointResult<readonly string[]> {
  if (value === undefined) return ok(Object.freeze([]));
  if (!Array.isArray(value)) return failure(violation("invalid_input", field, `${field} must be an array.`));
  if (value.length > maxItems) return failure(violation("limit_exceeded", field, `${field} has at most ${maxItems} items.`));
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = text(item, `${field}[${index}]`, CHECKPOINT_LIMITS.longText);
    if (typeof parsed !== "string") return failure(parsed);
    if (!result.includes(parsed)) result.push(parsed);
  }
  return ok(Object.freeze(result));
}

function normalizePath(value: unknown, field: string): string | CheckpointViolation {
  const parsed = text(value, field, CHECKPOINT_LIMITS.path);
  if (typeof parsed !== "string") return parsed;
  const normalized = parsed.replace(/\\/gu, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return violation("unsafe_path", field, `${field} must be relative.`);
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return violation("unsafe_path", field, `${field} must not contain path traversal.`);
  const compact = segments.filter((segment) => segment !== "." && segment !== "");
  if (compact.length === 0) return violation("unsafe_path", field, `${field} must identify a relative file.`);
  return compact.join("/");
}

function changedFiles(value: unknown): CheckpointResult<readonly string[]> {
  if (value === undefined) return ok(Object.freeze([]));
  if (!Array.isArray(value)) return failure(violation("invalid_input", "changedFiles", "changedFiles must be an array."));
  if (value.length > CHECKPOINT_LIMITS.changedFiles) return failure(violation("limit_exceeded", "changedFiles", `changedFiles has at most ${CHECKPOINT_LIMITS.changedFiles} items.`));
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = normalizePath(item, `changedFiles[${index}]`);
    if (typeof parsed !== "string") return failure(parsed);
    if (!result.includes(parsed)) result.push(parsed);
  }
  return ok(Object.freeze(result));
}

function testResults(value: unknown): CheckpointResult<readonly CheckpointTestResult[]> {
  if (value === undefined) return ok(Object.freeze([]));
  if (!Array.isArray(value)) return failure(violation("invalid_input", "tests", "tests must be an array."));
  if (value.length > CHECKPOINT_LIMITS.collection) return failure(violation("limit_exceeded", "tests", `tests has at most ${CHECKPOINT_LIMITS.collection} items.`));
  const result: CheckpointTestResult[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return failure(violation("invalid_input", `tests[${index}]`, "each test result must be an object."));
    const command = text(item.command, `tests[${index}].command`, CHECKPOINT_LIMITS.longText);
    const testResult = text(item.result, `tests[${index}].result`, CHECKPOINT_LIMITS.longText);
    if (typeof command !== "string") return failure(command);
    if (typeof testResult !== "string") return failure(testResult);
    if (!result.some((entry) => entry.command === command && entry.result === testResult)) result.push(Object.freeze({ command, result: testResult }));
  }
  return ok(Object.freeze(result));
}

function evidence(value: unknown): CheckpointResult<readonly CheckpointEvidence[]> {
  if (value === undefined) return ok(Object.freeze([]));
  if (!Array.isArray(value)) return failure(violation("invalid_input", "evidence", "evidence must be an array."));
  if (value.length > CHECKPOINT_LIMITS.evidence) return failure(violation("limit_exceeded", "evidence", `evidence has at most ${CHECKPOINT_LIMITS.evidence} items.`));
  const result: CheckpointEvidence[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return failure(violation("invalid_input", `evidence[${index}]`, "each evidence entry must be an object."));
    const reference = text(item.reference, `evidence[${index}].reference`, CHECKPOINT_LIMITS.longText);
    const summary = text(item.summary, `evidence[${index}].summary`, CHECKPOINT_LIMITS.longText);
    if (typeof reference !== "string") return failure(reference);
    if (typeof summary !== "string") return failure(summary);
    const existing = result.find((entry) => entry.reference === reference);
    if (existing !== undefined && existing.summary !== summary) return failure(violation("conflicting_evidence", `evidence[${index}].reference`, `Evidence reference ${reference} has conflicting summaries.`));
    if (existing === undefined) result.push(Object.freeze({ reference, summary }));
  }
  return ok(Object.freeze(result));
}

function forbiddenFields(value: unknown, path = "checkpoint", seen = new Set<object>()): CheckpointViolation | undefined {
  if (!isRecord(value)) return undefined;
  if (seen.has(value)) return violation("invalid_input", path, "Checkpoint must be JSON-serializable without cycles.");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SECRET_FIELD_PATTERN.test(key)) return violation("forbidden_field", childPath, `${childPath} is not allowed in a Checkpoint.`);
    const nested = forbiddenFields(child, childPath, seen);
    if (nested !== undefined) return nested;
  }
  seen.delete(value);
  return undefined;
}

function freezeCheckpoint(value: Checkpoint): Checkpoint {
  for (const item of value.tests) Object.freeze(item);
  for (const item of value.evidence) Object.freeze(item);
  Object.freeze(value.completedWork);
  Object.freeze(value.remainingWork);
  Object.freeze(value.changedFiles);
  Object.freeze(value.findings);
  Object.freeze(value.hypotheses);
  Object.freeze(value.tests);
  Object.freeze(value.evidence);
  return Object.freeze(value);
}

export function validateCheckpoint(value: unknown): CheckpointResult<Checkpoint> {
  const forbidden = forbiddenFields(value);
  if (forbidden !== undefined) return failure(forbidden);
  if (!isRecord(value) || value.kind !== "checkpoint") return failure(violation("invalid_input", "kind", "kind must be checkpoint."));
  if (value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) return failure(violation("unsupported_version", "schemaVersion", `Only Checkpoint schema version ${CHECKPOINT_SCHEMA_VERSION} is supported.`));
  const id = identifier(value.id, "id");
  const taskId = identifier(value.taskId, "taskId");
  const previousAttemptId = identifier(value.previousAttemptId, "previousAttemptId");
  const trigger = value.trigger;
  const createdAt = timestamp(value.createdAt, "createdAt");
  const goal = text(value.goal, "goal", CHECKPOINT_LIMITS.longText);
  const currentState = text(value.currentState, "currentState", CHECKPOINT_LIMITS.longText);
  const lastAction = text(value.lastAction, "lastAction", CHECKPOINT_LIMITS.longText);
  const resumeInstruction = text(value.resumeInstruction, "resumeInstruction", CHECKPOINT_LIMITS.longText);
  for (const parsed of [id, taskId, previousAttemptId, createdAt, goal, currentState, lastAction, resumeInstruction]) {
    if (typeof parsed !== "string") return failure(parsed);
  }
  if (typeof trigger !== "string" || !TRIGGER_SET.has(trigger)) return failure(violation("invalid_enum", "trigger", "trigger is unsupported."));
  const repository = optionalText(value.repository, "repository", CHECKPOINT_LIMITS.shortText);
  const branch = optionalText(value.branch, "branch", CHECKPOINT_LIMITS.shortText);
  const worktree = optionalText(value.worktree, "worktree", CHECKPOINT_LIMITS.shortText);
  const currentCommit = optionalText(value.currentCommit, "currentCommit", CHECKPOINT_LIMITS.shortText);
  for (const parsed of [repository, branch, worktree, currentCommit]) {
    if (parsed !== undefined && typeof parsed !== "string") return failure(parsed);
  }
  const workspace = [repository, branch, worktree, currentCommit];
  if (workspace.some((field) => field !== undefined) && workspace.some((field) => field === undefined)) return failure(violation("invariant_violation", "workspace", "repository, branch, worktree, and currentCommit must be supplied together."));
  const completedWork = listOfText(value.completedWork, "completedWork");
  const remainingWork = listOfText(value.remainingWork, "remainingWork");
  const findings = listOfText(value.findings, "findings");
  const hypotheses = listOfText(value.hypotheses, "hypotheses");
  const files = changedFiles(value.changedFiles);
  const tests = testResults(value.tests);
  const evidenceEntries = evidence(value.evidence);
  if (!completedWork.ok) return completedWork;
  if (!remainingWork.ok) return remainingWork;
  if (!findings.ok) return findings;
  if (!hypotheses.ok) return hypotheses;
  if (!files.ok) return files;
  if (!tests.ok) return tests;
  if (!evidenceEntries.ok) return evidenceEntries;
  if (remainingWork.value.length === 0) return failure(violation("invalid_input", "remainingWork", "remainingWork must contain at least one item."));
  const blockingReason = optionalText(value.blockingReason, "blockingReason", CHECKPOINT_LIMITS.longText);
  if (blockingReason !== undefined && typeof blockingReason !== "string") return failure(blockingReason);
  const checkpoint: Checkpoint = {
    kind: "checkpoint",
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    id: id as CheckpointId,
    taskId: taskId as TaskId,
    previousAttemptId: previousAttemptId as AttemptId,
    trigger: trigger as CheckpointTrigger,
    createdAt: createdAt as UtcTimestamp,
    goal: goal as string,
    currentState: currentState as string,
    ...(repository === undefined ? {} : { repository: repository as string, branch: branch as string, worktree: worktree as string, currentCommit: currentCommit as string }),
    completedWork: completedWork.value,
    remainingWork: remainingWork.value,
    changedFiles: files.value,
    findings: findings.value,
    hypotheses: hypotheses.value,
    tests: tests.value,
    evidence: evidenceEntries.value,
    ...(blockingReason === undefined ? {} : { blockingReason: blockingReason as string }),
    lastAction: lastAction as string,
    resumeInstruction: resumeInstruction as string,
  };
  try {
    const serialized = JSON.stringify(checkpoint);
    if (new TextEncoder().encode(serialized).byteLength > CHECKPOINT_LIMITS.serializedBytes) return failure(violation("limit_exceeded", "checkpoint", `Serialized Checkpoint is limited to ${CHECKPOINT_LIMITS.serializedBytes} bytes.`));
  } catch {
    return failure(violation("serialization_error", "checkpoint", "Checkpoint must be JSON-serializable."));
  }
  return ok(freezeCheckpoint(checkpoint));
}

export function createCheckpoint(input: CheckpointInput): CheckpointResult<Checkpoint> {
  return validateCheckpoint({ ...input, kind: "checkpoint", schemaVersion: CHECKPOINT_SCHEMA_VERSION });
}

export function serializeCheckpoint(checkpoint: Checkpoint): string {
  return JSON.stringify(checkpoint);
}

export function deserializeCheckpoint(serialized: string): CheckpointResult<Checkpoint> {
  try {
    return validateCheckpoint(JSON.parse(serialized) as unknown);
  } catch {
    return failure(violation("serialization_error", "checkpoint", "Checkpoint is not valid JSON."));
  }
}
