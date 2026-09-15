import {
  createWorkerRequest,
  type WorkerCapabilityGrant,
  type WorkerExecutionLimits,
  type WorkerRepositoryScope,
  type WorkerRequest,
  type WorkerRequestInput,
  type WorkerWorkspaceScope,
} from "./worker-contract.js";
import { type Checkpoint } from "./checkpoint.js";
import { type AttemptSnapshot, type TaskSnapshot, type TaskId, type AttemptId } from "./task-domain.js";
import type { ResumeContext } from "./resume.js";

export const CLAUDE_INPUT_SCHEMA_VERSION = 1 as const;
export const CLAUDE_RESPONSE_SCHEMA_VERSION = 1 as const;
export const CLAUDE_INPUT_LIMITS = Object.freeze({
  serializedBytes: 16_000,
  goal: 2_000,
  scope: 2_000,
  acceptanceCriteria: 40,
  acceptanceItem: 512,
  requiredList: 100,
  optionalList: 50,
  listItem: 1_000,
  tests: 50,
  testText: 1_000,
  evidence: 50,
  evidenceText: 1_000,
} as const);

export interface ClaudeInputRequest {
  readonly task: TaskSnapshot;
  readonly attempt: AttemptSnapshot;
  readonly workerId: string;
  readonly provider: string;
  readonly repository: WorkerRepositoryScope;
  readonly workspace: WorkerWorkspaceScope;
  readonly capabilityGrant: Omit<WorkerCapabilityGrant, "taskId" | "workerId" | "requiredCapabilities"> & { readonly grantedCapabilities: readonly string[] };
  readonly correlationId: string;
  readonly limits: WorkerExecutionLimits;
  readonly mode: "new" | "resume";
  readonly resumeContext?: ResumeContext;
  readonly latestCheckpoint?: Checkpoint;
}

export interface ClaudeInputResumeSection {
  readonly previousAttemptId: AttemptId;
  readonly checkpointId: string;
  readonly currentState: string;
  readonly completedWork: readonly string[];
  readonly remainingWork: readonly string[];
  readonly currentCommit?: string;
  readonly changedFiles: readonly string[];
  readonly findings: readonly string[];
  readonly hypotheses: readonly string[];
  readonly tests: readonly { readonly command: string; readonly result: string }[];
  readonly evidence: readonly { readonly reference: string; readonly summary: string }[];
  readonly blockingReason?: string;
  readonly lastAction: string;
  readonly resumeInstruction: string;
  readonly truncatedFields: readonly string[];
}

export interface ClaudeCodeInput {
  readonly kind: "claude_code_input";
  readonly schemaVersion: typeof CLAUDE_INPUT_SCHEMA_VERSION;
  readonly mode: "new" | "resume";
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly workerId: string;
  readonly provider: string;
  readonly correlationId: string;
  readonly task: { readonly goal: string; readonly scope: string; readonly acceptanceCriteria: readonly string[] };
  readonly repository: WorkerRepositoryScope;
  readonly workspace: WorkerWorkspaceScope;
  readonly capabilities: { readonly required: readonly string[]; readonly granted: readonly string[] };
  readonly limits: WorkerExecutionLimits;
  readonly responseContract: { readonly schemaVersion: typeof CLAUDE_RESPONSE_SCHEMA_VERSION; readonly requiredFields: readonly string[]; readonly outcomes: readonly string[] };
  readonly resume?: ClaudeInputResumeSection;
}

export type ClaudeInputViolationCode = "invalid_input" | "binding_mismatch" | "stale_checkpoint" | "forbidden_field" | "limit_exceeded" | "unsupported_version" | "serialization_error";
export interface ClaudeInputViolation { readonly code: ClaudeInputViolationCode; readonly field: string; readonly message: string; }
export type ClaudeInputResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly violations: readonly ClaudeInputViolation[] };

const RESPONSE_OUTCOMES = Object.freeze(["CODE_PUSHED", "BLOCKED", "FAILED", "QUOTA_EXHAUSTED", "CANCELLED", "UNKNOWN"]);
const SECRET_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key|credential|connection[_ -]?string)/iu;

function fail(...violations: ClaudeInputViolation[]): ClaudeInputResult<never> { return { ok: false, violations: Object.freeze(violations) }; }
function violation(code: ClaudeInputViolationCode, field: string, message: string): ClaudeInputViolation { return { code, field, message }; }
function isViolation(value: unknown): value is ClaudeInputViolation { return isRecord(value) && typeof value.code === "string" && typeof value.field === "string" && typeof value.message === "string"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, field: string, max: number): string | ClaudeInputViolation {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) return violation(value !== undefined && typeof value === "string" && value.length > max ? "limit_exceeded" : "invalid_input", field, `${field} is outside the bounded input contract.`);
  return value.trim();
}
function secret(value: unknown, field: string): ClaudeInputViolation | undefined {
  if (SECRET_PATTERN.test(field)) return violation("forbidden_field", field, "Secret-shaped fields are not allowed in Claude input.");
  if (typeof value === "string" && SECRET_PATTERN.test(value)) return violation("forbidden_field", field, "Secret-shaped values are not allowed in Claude input.");
  if (isRecord(value)) for (const [key, child] of Object.entries(value)) { const nested = secret(child, `${field}.${key}`); if (nested !== undefined) return nested; }
  if (Array.isArray(value)) for (const [index, child] of value.entries()) { const nested = secret(child, `${field}[${index}]`); if (nested !== undefined) return nested; }
  return undefined;
}
function list(values: readonly string[], field: string, maxItems: number, required: boolean, truncated: string[], itemMax: number = CLAUDE_INPUT_LIMITS.listItem): readonly string[] | ClaudeInputViolation {
  const bounded: string[] = [];
  for (const [index, value] of values.entries()) {
    const parsed = text(value, `${field}[${index}]`, itemMax);
    if (typeof parsed !== "string") return parsed;
    if (bounded.length < maxItems) bounded.push(parsed);
  }
  if (values.length > maxItems) {
    if (required) return violation("limit_exceeded", field, `${field} contains required data beyond the bounded limit.`);
    truncated.push(field);
  }
  return Object.freeze(bounded);
}
function tests(values: readonly { readonly command: string; readonly result: string }[], truncated: string[]): readonly { readonly command: string; readonly result: string }[] | ClaudeInputViolation {
  const output: Array<{ readonly command: string; readonly result: string }> = [];
  for (const [index, value] of values.entries()) {
    const command = text(value.command, `tests[${index}].command`, CLAUDE_INPUT_LIMITS.testText);
    const result = text(value.result, `tests[${index}].result`, CLAUDE_INPUT_LIMITS.testText);
    if (typeof command !== "string") return command;
    if (typeof result !== "string") return result;
    if (output.length < CLAUDE_INPUT_LIMITS.tests) output.push(Object.freeze({ command, result }));
  }
  if (values.length > CLAUDE_INPUT_LIMITS.tests) truncated.push("tests");
  return Object.freeze(output);
}
function evidence(values: readonly { readonly reference: string; readonly summary: string }[], truncated: string[]): readonly { readonly reference: string; readonly summary: string }[] | ClaudeInputViolation {
  const output: Array<{ readonly reference: string; readonly summary: string }> = [];
  for (const [index, value] of values.entries()) {
    const reference = text(value.reference, `evidence[${index}].reference`, CLAUDE_INPUT_LIMITS.evidenceText);
    const summary = text(value.summary, `evidence[${index}].summary`, CLAUDE_INPUT_LIMITS.evidenceText);
    if (typeof reference !== "string") return reference;
    if (typeof summary !== "string") return summary;
    if (output.length < CLAUDE_INPUT_LIMITS.evidence) output.push(Object.freeze({ reference, summary }));
  }
  if (values.length > CLAUDE_INPUT_LIMITS.evidence) truncated.push("evidence");
  return Object.freeze(output);
}
function equalJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function workerRequest(input: ClaudeInputRequest): ClaudeInputResult<WorkerRequest> {
  const candidate: WorkerRequestInput = { task: input.task, attempt: input.attempt, workerId: input.workerId, provider: input.provider, repository: input.repository, workspace: input.workspace, capabilityGrant: input.capabilityGrant, correlationId: input.correlationId, limits: input.limits };
  const parsed = createWorkerRequest(candidate);
  return parsed.ok ? parsed : fail(...parsed.violations.map((item) => violation(item.code === "unsupported_version" ? "unsupported_version" : item.code === "binding_mismatch" ? "binding_mismatch" : item.code === "limit_exceeded" ? "limit_exceeded" : "invalid_input", item.field, item.message)));
}

export function createClaudeCodeInput(input: ClaudeInputRequest): ClaudeInputResult<ClaudeCodeInput> {
  const forbidden = secret(input, "input");
  if (forbidden !== undefined) return fail(forbidden);
  if (input.mode !== "new" && input.mode !== "resume") return fail(violation("invalid_input", "mode", "Claude input mode is unsupported."));
  const request = workerRequest(input);
  if (!request.ok) return request;
  const value = request.value;
  if (input.mode === "new" && (input.resumeContext !== undefined || input.latestCheckpoint !== undefined)) return fail(violation("binding_mismatch", "mode", "A new Attempt cannot contain resume state."));
  if (input.mode === "resume") {
    if (input.resumeContext === undefined || input.latestCheckpoint === undefined) return fail(violation("stale_checkpoint", "resumeContext", "A resumed Attempt requires the latest validated Checkpoint and ResumeContext."));
    const context = input.resumeContext;
    const checkpoint = input.latestCheckpoint;
    if (input.attempt.predecessorAttemptId === undefined || input.attempt.predecessorAttemptId !== checkpoint.previousAttemptId || context.previousAttemptId !== checkpoint.previousAttemptId || context.checkpointId !== checkpoint.id || context.taskId !== input.task.id || checkpoint.taskId !== input.task.id || input.attempt.id === checkpoint.previousAttemptId) return fail(violation("binding_mismatch", "resumeContext", "Resume state is not bound to the current Task, predecessor Attempt, and Checkpoint."));
    if (checkpoint.currentState !== context.currentState || checkpoint.goal !== context.goal || checkpoint.lastAction !== context.lastAction || checkpoint.resumeInstruction !== context.resumeInstruction || (input.attempt.currentCommit !== undefined && context.currentCommit !== input.attempt.currentCommit)) return fail(violation("stale_checkpoint", "resumeContext", "ResumeContext does not match the latest Checkpoint or Attempt."));
  }
  const truncated: string[] = [];
  const acceptance = list(input.task.acceptanceCriteria, "acceptanceCriteria", CLAUDE_INPUT_LIMITS.acceptanceCriteria, false, truncated, CLAUDE_INPUT_LIMITS.acceptanceItem);
  if (isViolation(acceptance)) return fail(acceptance);
  const task: ClaudeCodeInput["task"] = { goal: input.task.goal, scope: input.task.scope, acceptanceCriteria: acceptance };
  let resume: ClaudeInputResumeSection | undefined;
  if (input.mode === "resume" && input.resumeContext !== undefined) {
    const context = input.resumeContext;
    const completedWork = list(context.completedWork, "completedWork", CLAUDE_INPUT_LIMITS.optionalList, false, truncated);
    const remainingWork = list(context.remainingWork, "remainingWork", CLAUDE_INPUT_LIMITS.optionalList, true, truncated);
    const changedFiles = list(context.changedFiles, "changedFiles", CLAUDE_INPUT_LIMITS.optionalList, false, truncated);
    const findings = list(context.findings, "findings", CLAUDE_INPUT_LIMITS.optionalList, false, truncated);
    const hypotheses = list(context.hypotheses, "hypotheses", CLAUDE_INPUT_LIMITS.optionalList, false, truncated);
    const testResults = tests(context.tests, truncated);
    const evidenceEntries = evidence(context.evidence, truncated);
    for (const parsed of [completedWork, remainingWork, changedFiles, findings, hypotheses, testResults, evidenceEntries]) if (isViolation(parsed)) return fail(parsed);
    resume = {
      previousAttemptId: context.previousAttemptId,
      checkpointId: context.checkpointId,
      currentState: context.currentState,
      completedWork: completedWork as readonly string[],
      remainingWork: remainingWork as readonly string[],
      ...(context.currentCommit === undefined ? {} : { currentCommit: context.currentCommit }),
      changedFiles: changedFiles as readonly string[],
      findings: findings as readonly string[],
      hypotheses: hypotheses as readonly string[],
      tests: testResults as readonly { readonly command: string; readonly result: string }[],
      evidence: evidenceEntries as readonly { readonly reference: string; readonly summary: string }[],
      ...(context.blockingReason === undefined ? {} : { blockingReason: context.blockingReason }),
      lastAction: context.lastAction,
      resumeInstruction: context.resumeInstruction,
      truncatedFields: Object.freeze([...new Set([...context.truncatedFields, ...truncated])]),
    };
  }
  let output: ClaudeCodeInput = Object.freeze({
    kind: "claude_code_input",
    schemaVersion: CLAUDE_INPUT_SCHEMA_VERSION,
    mode: input.mode,
    taskId: value.taskId,
    attemptId: value.attemptId,
    workerId: value.workerId,
    provider: value.provider,
    correlationId: value.correlationId,
    task: Object.freeze(task),
    repository: value.repository,
    workspace: value.workspace,
    capabilities: Object.freeze({ required: value.capabilityGrant.requiredCapabilities, granted: value.capabilityGrant.grantedCapabilities }),
    limits: value.limits,
    responseContract: Object.freeze({ schemaVersion: CLAUDE_RESPONSE_SCHEMA_VERSION, requiredFields: Object.freeze(["kind", "schemaVersion", "taskId", "attemptId", "correlationId", "outcome"]), outcomes: RESPONSE_OUTCOMES }),
    ...(resume === undefined ? {} : { resume: Object.freeze(resume) }),
  });
  try {
    const dropOrder: readonly (keyof ClaudeInputResumeSection)[] = ["hypotheses", "findings", "completedWork", "changedFiles", "evidence"];
    for (const field of dropOrder) {
      if (new TextEncoder().encode(JSON.stringify(output)).byteLength <= CLAUDE_INPUT_LIMITS.serializedBytes || output.resume === undefined) break;
      const resumeValue = output.resume;
      output = Object.freeze({ ...output, resume: Object.freeze({ ...resumeValue, [field]: [], truncatedFields: Object.freeze([...new Set([...resumeValue.truncatedFields, field])]) }) });
    }
    if (new TextEncoder().encode(JSON.stringify(output)).byteLength > CLAUDE_INPUT_LIMITS.serializedBytes) return fail(violation("limit_exceeded", "input", `Claude input exceeds ${CLAUDE_INPUT_LIMITS.serializedBytes} bytes.`));
    return { ok: true, value: output };
  } catch { return fail(violation("serialization_error", "input", "Claude input could not be serialized.")); }
}

export function serializeClaudeCodeInput(input: ClaudeCodeInput): string { return JSON.stringify(input); }

export function validateClaudeCodeInput(value: unknown): ClaudeInputResult<ClaudeCodeInput> {
  if (!isRecord(value) || value.kind !== "claude_code_input") return fail(violation("invalid_input", "kind", "Claude input envelope is invalid."));
  if (value.schemaVersion !== CLAUDE_INPUT_SCHEMA_VERSION) return fail(violation("unsupported_version", "schemaVersion", "Claude input schema version is unsupported."));
  if (secret(value, "input") !== undefined) return fail(secret(value, "input")!);
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > CLAUDE_INPUT_LIMITS.serializedBytes) return fail(violation("limit_exceeded", "input", "Claude input envelope is oversized."));
    return { ok: true, value: value as unknown as ClaudeCodeInput };
  } catch { return fail(violation("serialization_error", "input", "Claude input envelope is not JSON-safe.")); }
}
