import {
  deserializeAttempt,
  deserializeTask,
  type AttemptSnapshot,
  type TaskSnapshot,
  type TaskId,
  type AttemptId,
} from "./task-domain.js";
import type { CapabilityResourceScope } from "./capabilities.js";
import { createWorkerFailureDiagnostic, isWorkerFailureError, validateWorkerFailureDiagnostic, type WorkerFailureDiagnostic } from "./worker-diagnostic.js";
import { WORKER_RESULT_ALLOWED_FIELDS, WORKER_RESULT_CONTRACT_SCHEMA_VERSION, workerResultVariant } from "./worker-result-contract.js";
import type { WorkerNonSuccessOutcome, WorkerResult } from "./worker-result-contract.js";

export { WORKER_RESULT_OUTCOMES, type WorkerNonSuccessOutcome, type WorkerResult, type WorkerResultOutcome } from "./worker-result-contract.js";

export const WORKER_CONTRACT_SCHEMA_VERSION = WORKER_RESULT_CONTRACT_SCHEMA_VERSION;
export type WorkerContractSchemaVersion = typeof WORKER_CONTRACT_SCHEMA_VERSION;

export const WORKER_CONTRACT_LIMITS = Object.freeze({
  workerId: 256,
  provider: 256,
  owner: 100,
  repository: 100,
  branch: 512,
  worktree: 1_000,
  correlationId: 256,
  resumeContextReference: 1_000,
  reason: 1_000,
  commit: 256,
  timeoutMs: 300_000,
  outputBytes: 1_048_576,
  errorBytes: 262_144,
} as const);

export interface WorkerRepositoryScope {
  readonly owner: string;
  readonly repository: string;
}

export interface WorkerWorkspaceScope {
  readonly branch: string;
  readonly worktree: string;
}

export interface WorkerCapabilityGrant {
  readonly taskId: TaskId;
  readonly workerId: string;
  readonly requiredCapabilities: readonly string[];
  readonly grantedCapabilities: readonly string[];
  readonly resourceScope: CapabilityResourceScope;
}

export interface WorkerExecutionLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxErrorBytes: number;
}

export interface WorkerRequest {
  readonly kind: "worker_request";
  readonly schemaVersion: typeof WORKER_CONTRACT_SCHEMA_VERSION;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly workerId: string;
  readonly provider: string;
  readonly repository: WorkerRepositoryScope;
  readonly workspace: WorkerWorkspaceScope;
  readonly capabilityGrant: WorkerCapabilityGrant;
  readonly correlationId: string;
  readonly limits: WorkerExecutionLimits;
  readonly resumeContextReference?: string;
}

export interface WorkerRequestInput {
  readonly task: TaskSnapshot;
  readonly attempt: AttemptSnapshot;
  readonly workerId: string;
  readonly provider: string;
  readonly repository: WorkerRepositoryScope;
  readonly workspace: WorkerWorkspaceScope;
  readonly capabilityGrant: Omit<WorkerCapabilityGrant, "taskId" | "workerId" | "requiredCapabilities"> & { readonly grantedCapabilities: readonly string[] };
  readonly correlationId: string;
  readonly limits: WorkerExecutionLimits;
  readonly resumeContextReference?: string;
}

export interface WorkerPort {
  execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult>;
}

export type WorkerViolationCode = "invalid_input" | "unsupported_version" | "binding_mismatch" | "limit_exceeded" | "invalid_result";
export interface WorkerViolation {
  readonly code: WorkerViolationCode;
  readonly field: string;
  readonly message: string;
}
export type WorkerValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violations: readonly WorkerViolation[] };

function success<T>(value: T): WorkerValidationResult<T> { return { ok: true, value }; }
function failure<T = never>(...violations: WorkerViolation[]): WorkerValidationResult<T> { return { ok: false, violations: Object.freeze(violations) }; }
function violation(code: WorkerViolationCode, field: string, message: string): WorkerViolation { return { code, field, message }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isViolation(value: unknown): value is WorkerViolation { return isRecord(value) && typeof value.code === "string" && typeof value.field === "string" && typeof value.message === "string"; }
function boundedText(value: unknown, field: string, maximum: number): string | WorkerViolation {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return violation(value !== undefined && typeof value === "string" && value.length > maximum ? "limit_exceeded" : "invalid_input", field, `${field} must be a bounded text value.`);
  return value.trim();
}
function validId(value: unknown, field: string): string | WorkerViolation {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) return violation("invalid_input", field, `${field} must be an opaque Pirx identifier.`);
  return value;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): WorkerViolation | undefined {
  const allowedSet = new Set(allowed);
  return Object.keys(value).find((key) => !allowedSet.has(key)) === undefined ? undefined : violation("invalid_input", field, "Unknown fields are not accepted by the worker contract.");
}
function capabilityList(value: unknown, field: string): readonly string[] | WorkerViolation {
  if (!Array.isArray(value) || value.length === 0) return violation("invalid_input", field, `${field} must be a non-empty list.`);
  const normalized: string[] = [];
  for (const item of value) {
    const parsed = boundedText(item, field, 256);
    if (typeof parsed !== "string") return parsed;
    if (!normalized.includes(parsed)) normalized.push(parsed);
  }
  return Object.freeze(normalized.sort());
}
function repository(value: unknown): WorkerRepositoryScope | WorkerViolation {
  if (!isRecord(value)) return violation("invalid_input", "repository", "repository must be an object.");
  const keys = exactKeys(value, ["owner", "repository"], "repository"); if (keys !== undefined) return keys;
  const owner = boundedText(value.owner, "repository.owner", WORKER_CONTRACT_LIMITS.owner);
  const name = boundedText(value.repository, "repository.repository", WORKER_CONTRACT_LIMITS.repository);
  if (typeof owner !== "string") return owner;
  if (typeof name !== "string") return name;
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(name)) return violation("invalid_input", "repository", "repository names contain unsupported characters.");
  return Object.freeze({ owner, repository: name });
}
function workspace(value: unknown): WorkerWorkspaceScope | WorkerViolation {
  if (!isRecord(value)) return violation("invalid_input", "workspace", "workspace must be an object.");
  const keys = exactKeys(value, ["branch", "worktree"], "workspace"); if (keys !== undefined) return keys;
  const branch = boundedText(value.branch, "workspace.branch", WORKER_CONTRACT_LIMITS.branch);
  const worktree = boundedText(value.worktree, "workspace.worktree", WORKER_CONTRACT_LIMITS.worktree);
  if (typeof branch !== "string") return branch;
  if (typeof worktree !== "string") return worktree;
  return Object.freeze({ branch, worktree });
}
function scope(value: unknown): CapabilityResourceScope | WorkerViolation {
  if (!isRecord(value)) return violation("invalid_input", "capabilityGrant.resourceScope", "resourceScope must be an object.");
  const allowed = ["repository", "branch", "worktree", "environment"] as const;
  const keys = exactKeys(value, allowed, "capabilityGrant.resourceScope"); if (keys !== undefined) return keys;
  const normalized: Partial<Record<(typeof allowed)[number], string>> = {};
  for (const field of allowed) {
    if (value[field] === undefined) continue;
    const parsed = boundedText(value[field], `capabilityGrant.resourceScope.${field}`, 1_000);
    if (typeof parsed !== "string") return parsed;
    normalized[field] = parsed;
  }
  if (normalized.repository === undefined || normalized.branch === undefined || normalized.worktree === undefined) return violation("invalid_input", "capabilityGrant.resourceScope", "resourceScope must bind repository, branch, and worktree.");
  return Object.freeze(normalized as CapabilityResourceScope);
}
function limits(value: unknown): WorkerExecutionLimits | WorkerViolation {
  if (!isRecord(value)) return violation("invalid_input", "limits", "limits must be an object.");
  const keys = exactKeys(value, ["timeoutMs", "maxOutputBytes", "maxErrorBytes"], "limits"); if (keys !== undefined) return keys;
  const checks: Array<[string, unknown, number]> = [["timeoutMs", value.timeoutMs, WORKER_CONTRACT_LIMITS.timeoutMs], ["maxOutputBytes", value.maxOutputBytes, WORKER_CONTRACT_LIMITS.outputBytes], ["maxErrorBytes", value.maxErrorBytes, WORKER_CONTRACT_LIMITS.errorBytes]];
  const result: Record<string, number> = {};
  for (const [field, raw, maximum] of checks) {
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0 || (raw as number) > maximum) return violation("limit_exceeded", `limits.${field}`, `limits.${field} is outside the bounded execution range.`);
    result[field] = raw as number;
  }
  return Object.freeze(result as unknown as WorkerExecutionLimits);
}
function parseRequest(value: unknown): WorkerValidationResult<WorkerRequest> {
  if (!isRecord(value)) return failure(violation("invalid_input", "request", "Worker request must be an object."));
  const keys = exactKeys(value, ["kind", "schemaVersion", "taskId", "attemptId", "workerId", "provider", "repository", "workspace", "capabilityGrant", "correlationId", "limits", "resumeContextReference"], "request"); if (keys !== undefined) return failure(keys);
  if (value.kind !== "worker_request") return failure(violation("invalid_input", "kind", "Worker request kind is unsupported."));
  if (value.schemaVersion !== WORKER_CONTRACT_SCHEMA_VERSION) return failure(violation("unsupported_version", "schemaVersion", "Worker request schema version is unsupported."));
  const taskId = validId(value.taskId, "taskId"); const attemptId = validId(value.attemptId, "attemptId"); const workerId = boundedText(value.workerId, "workerId", WORKER_CONTRACT_LIMITS.workerId); const provider = boundedText(value.provider, "provider", WORKER_CONTRACT_LIMITS.provider); const correlationId = boundedText(value.correlationId, "correlationId", WORKER_CONTRACT_LIMITS.correlationId);
  if (typeof taskId !== "string") return failure(taskId); if (typeof attemptId !== "string") return failure(attemptId); if (typeof workerId !== "string") return failure(workerId); if (typeof provider !== "string") return failure(provider); if (typeof correlationId !== "string") return failure(correlationId);
  const parsedRepository = repository(value.repository); if (isViolation(parsedRepository)) return failure(parsedRepository);
  const parsedWorkspace = workspace(value.workspace); if (isViolation(parsedWorkspace)) return failure(parsedWorkspace);
  if (!isRecord(value.capabilityGrant)) return failure(violation("invalid_input", "capabilityGrant", "capabilityGrant must be an object."));
  const grantKeys = exactKeys(value.capabilityGrant, ["taskId", "workerId", "requiredCapabilities", "grantedCapabilities", "resourceScope"], "capabilityGrant"); if (grantKeys !== undefined) return failure(grantKeys);
  const grantTaskId = validId(value.capabilityGrant.taskId, "capabilityGrant.taskId"); const grantWorkerId = boundedText(value.capabilityGrant.workerId, "capabilityGrant.workerId", WORKER_CONTRACT_LIMITS.workerId); const required = capabilityList(value.capabilityGrant.requiredCapabilities, "capabilityGrant.requiredCapabilities"); const granted = capabilityList(value.capabilityGrant.grantedCapabilities, "capabilityGrant.grantedCapabilities"); const parsedScope = scope(value.capabilityGrant.resourceScope);
  if (typeof grantTaskId !== "string") return failure(grantTaskId); if (typeof grantWorkerId !== "string") return failure(grantWorkerId); if (isViolation(required)) return failure(required); if (isViolation(granted)) return failure(granted); if (isViolation(parsedScope)) return failure(parsedScope);
  if (grantTaskId !== taskId || grantWorkerId !== workerId) return failure(violation("binding_mismatch", "capabilityGrant", "Capability grant is bound to another Task or worker."));
  if (!required.every((capability) => granted.includes(capability))) return failure(violation("binding_mismatch", "capabilityGrant.grantedCapabilities", "Grant does not cover every required capability."));
  if (parsedScope.repository !== `${parsedRepository.owner}/${parsedRepository.repository}` || parsedScope.branch !== parsedWorkspace.branch || parsedScope.worktree !== parsedWorkspace.worktree) return failure(violation("binding_mismatch", "capabilityGrant.resourceScope", "Capability grant scope does not match the assigned repository and workspace."));
  const parsedLimits = limits(value.limits); if (isViolation(parsedLimits)) return failure(parsedLimits);
  const resume = value.resumeContextReference === undefined ? undefined : boundedText(value.resumeContextReference, "resumeContextReference", WORKER_CONTRACT_LIMITS.resumeContextReference);
  if (typeof resume !== "string" && resume !== undefined) return failure(resume);
  return success(Object.freeze({ kind: "worker_request", schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION, taskId: taskId as TaskId, attemptId: attemptId as AttemptId, workerId, provider, repository: parsedRepository, workspace: parsedWorkspace, capabilityGrant: Object.freeze({ taskId: grantTaskId as TaskId, workerId: grantWorkerId, requiredCapabilities: required, grantedCapabilities: granted, resourceScope: parsedScope }), correlationId, limits: parsedLimits, ...(resume === undefined ? {} : { resumeContextReference: resume }) }));
}

export function createWorkerRequest(input: WorkerRequestInput): WorkerValidationResult<WorkerRequest> {
  let task: TaskSnapshot; let attempt: AttemptSnapshot;
  try {
    const parsedTask = deserializeTask(JSON.stringify(input.task)); const parsedAttempt = deserializeAttempt(JSON.stringify(input.attempt));
    if (!parsedTask.ok || !parsedAttempt.ok) return failure(violation("invalid_input", !parsedTask.ok ? "task" : "attempt", "Task or Attempt snapshot is malformed."));
    task = parsedTask.value; attempt = parsedAttempt.value;
  } catch { return failure(violation("invalid_input", "task", "Task or Attempt snapshot is not JSON-safe.")); }
  const workerId = boundedText(input.workerId, "workerId", WORKER_CONTRACT_LIMITS.workerId); const provider = boundedText(input.provider, "provider", WORKER_CONTRACT_LIMITS.provider); const correlationId = boundedText(input.correlationId, "correlationId", WORKER_CONTRACT_LIMITS.correlationId);
  if (typeof workerId !== "string") return failure(workerId); if (typeof provider !== "string") return failure(provider); if (typeof correlationId !== "string") return failure(correlationId);
  if (task.state !== "in_progress" || attempt.state !== "running") return failure(violation("binding_mismatch", "task/attempt", "Worker execution requires an in-progress Task and running Attempt."));
  if (attempt.taskId !== task.id || attempt.worker !== workerId || attempt.provider !== provider) return failure(violation("binding_mismatch", "task/attempt", "Task, Attempt, worker, and provider identities do not match."));
  const parsedRepository = repository(input.repository); if (isViolation(parsedRepository)) return failure(parsedRepository);
  const parsedWorkspace = workspace(input.workspace); if (isViolation(parsedWorkspace)) return failure(parsedWorkspace);
  if (!isRecord(input.capabilityGrant)) return failure(violation("invalid_input", "capabilityGrant", "capabilityGrant must be an object."));
  const parsedScope = scope(input.capabilityGrant.resourceScope); if (isViolation(parsedScope)) return failure(parsedScope);
  const parsedLimits = limits(input.limits); if (isViolation(parsedLimits)) return failure(parsedLimits);
  if (parsedWorkspace.branch !== attempt.branch || parsedWorkspace.worktree !== attempt.worktree) return failure(violation("binding_mismatch", "workspace", "Assigned workspace does not match the Attempt."));
  const repositoryName = `${parsedRepository.owner}/${parsedRepository.repository}`;
  if (task.githubReference !== undefined && `${task.githubReference.owner}/${task.githubReference.repository}` !== repositoryName) return failure(violation("binding_mismatch", "repository", "Repository does not match the Task GitHub reference."));
  if (attempt.checkpointReference !== undefined && input.resumeContextReference !== undefined && attempt.checkpointReference !== input.resumeContextReference) return failure(violation("binding_mismatch", "resumeContextReference", "Resume context does not match the Attempt checkpoint reference."));
  const candidate: WorkerRequest = { kind: "worker_request", schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION, taskId: task.id, attemptId: attempt.id, workerId, provider, repository: parsedRepository, workspace: parsedWorkspace, capabilityGrant: { taskId: task.id, workerId, requiredCapabilities: task.requiredCapabilities, grantedCapabilities: input.capabilityGrant.grantedCapabilities, resourceScope: parsedScope }, correlationId, limits: parsedLimits, ...(input.resumeContextReference === undefined ? {} : { resumeContextReference: input.resumeContextReference }) };
  const parsed = parseRequest(candidate);
  return parsed.ok ? parsed : failure(...parsed.violations);
}

export function validateWorkerRequest(value: unknown): WorkerValidationResult<WorkerRequest> { return parseRequest(value); }

export function validateWorkerResult(value: unknown, request?: Pick<WorkerRequest, "taskId" | "attemptId" | "correlationId" | "workspace">): WorkerValidationResult<WorkerResult> {
  if (!isRecord(value)) return failure(violation("invalid_result", "result", "Worker result must be an object."));
  const keys = exactKeys(value, WORKER_RESULT_ALLOWED_FIELDS, "result"); if (keys !== undefined) return failure(keys);
  if (value.kind !== "worker_result") return failure(violation("invalid_result", "kind", "Worker result kind is unsupported."));
  if (value.schemaVersion !== WORKER_CONTRACT_SCHEMA_VERSION) return failure(violation("unsupported_version", "schemaVersion", "Worker result schema version is unsupported."));
  const taskId = validId(value.taskId, "taskId"); const attemptId = validId(value.attemptId, "attemptId"); const correlationId = boundedText(value.correlationId, "correlationId", WORKER_CONTRACT_LIMITS.correlationId);
  if (typeof taskId !== "string") return failure(taskId); if (typeof attemptId !== "string") return failure(attemptId); if (typeof correlationId !== "string") return failure(correlationId);
  if (request !== undefined && (taskId !== request.taskId || attemptId !== request.attemptId || correlationId !== request.correlationId)) return failure(violation("binding_mismatch", "result", "Worker result identity does not match its request."));
  const variant = workerResultVariant(value.outcome);
  if (variant === undefined) return failure(violation("invalid_result", "outcome", "Worker result outcome is unsupported."));
  const base = { kind: "worker_result" as const, schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION, taskId: taskId as TaskId, attemptId: attemptId as AttemptId, correlationId };
  if (variant.outcome === "CODE_PUSHED") {
    if (variant.forbidden.some((field) => value[field] !== undefined)) return failure(violation("invalid_result", "result", "CODE_PUSHED cannot contain failure evidence."));
    const branch = boundedText(value.branch, "branch", WORKER_CONTRACT_LIMITS.branch); const finalCommit = boundedText(value.finalCommit, "finalCommit", WORKER_CONTRACT_LIMITS.commit);
    if (typeof branch !== "string") return failure(branch); if (typeof finalCommit !== "string") return failure(finalCommit);
    if (request !== undefined && branch !== request.workspace.branch) return failure(violation("binding_mismatch", "branch", "CODE_PUSHED branch does not match the assigned workspace."));
    return success(Object.freeze({ ...base, outcome: "CODE_PUSHED", branch, finalCommit }));
  }
  if (variant.forbidden.some((field) => value[field] !== undefined)) return failure(violation("invalid_result", "result", "Non-success results cannot contain CODE_PUSHED evidence."));
  const reason = boundedText(value.reason, "reason", WORKER_CONTRACT_LIMITS.reason);
  if (typeof reason !== "string") return failure(reason);
  if (value.diagnostic !== undefined) {
    const diagnostic = validateWorkerFailureDiagnostic(value.diagnostic);
    if (diagnostic === undefined) return failure(violation("invalid_result", "diagnostic", "Worker diagnostic is malformed or unsafe."));
    return success(Object.freeze({ ...base, outcome: value.outcome as WorkerNonSuccessOutcome, reason, diagnostic }));
  }
  return success(Object.freeze({ ...base, outcome: value.outcome as WorkerNonSuccessOutcome, reason }));
}

function resultOutcome(code: WorkerFailureDiagnostic["code"]): WorkerNonSuccessOutcome {
  if (code === "quota_exhausted") return "QUOTA_EXHAUSTED";
  if (code === "cancellation") return "CANCELLED";
  if (code === "capability_denied" || code === "permission_denied" || code === "authentication" || code === "binding_mismatch") return "BLOCKED";
  return "FAILED";
}

function failureResult(request: WorkerRequest, diagnostic: WorkerFailureDiagnostic): WorkerResult {
  return { kind: "worker_result", schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION, taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, outcome: resultOutcome(diagnostic.code), reason: diagnostic.message, diagnostic };
}

export async function invokeWorker(port: WorkerPort, request: WorkerRequest, signal: AbortSignal): Promise<WorkerValidationResult<WorkerResult>> {
  const validRequest = validateWorkerRequest(request);
  if (!validRequest.ok) return validRequest;
  if (signal.aborted) return failure(violation("invalid_input", "signal", "Worker invocation was cancelled before adapter invocation."));
  try {
    const result = await port.execute(validRequest.value, signal);
    return validateWorkerResult(result, validRequest.value);
  } catch (error: unknown) {
    const diagnostic = isWorkerFailureError(error) ? error.diagnostic : createWorkerFailureDiagnostic("adapter_failure");
    return validateWorkerResult(failureResult(validRequest.value, diagnostic), validRequest.value);
  }
}
