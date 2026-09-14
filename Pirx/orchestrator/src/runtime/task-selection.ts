import type { TaskId, TaskSnapshot } from "./task-domain.js";
import type { UtcTimestamp } from "./task-domain.js";

export type DependencyProjectionState = "known" | "unknown";
export const TASK_SELECTION_REASON_CODES = Object.freeze([
  "NOT_READY",
  "BLOCKED_BY_PREREQUISITE",
  "COOLDOWN_ACTIVE",
  "MISSING_CAPABILITY",
  "ELIGIBLE",
] as const);
export type TaskSelectionReasonCode = (typeof TASK_SELECTION_REASON_CODES)[number];

export interface TaskSelectionMetadata {
  readonly taskId: TaskId;
  readonly queueOrder?: number;
  readonly cooldownUntil?: UtcTimestamp;
  readonly dependencyState: DependencyProjectionState;
  readonly synchronizedAt: UtcTimestamp;
  readonly blockers: readonly TaskId[];
}

export interface TaskSelectionMetadataInput {
  readonly taskId: TaskId;
  readonly queueOrder?: number;
  readonly cooldownUntil?: UtcTimestamp;
  readonly dependencyState: DependencyProjectionState;
  readonly synchronizedAt: UtcTimestamp;
  readonly blockers: readonly TaskId[];
}

export interface TaskSelectionWorker {
  readonly workerId: string;
  readonly capabilities: readonly string[];
}

export interface TaskSelectionRequest {
  readonly evaluatedAt: UtcTimestamp;
  readonly worker: TaskSelectionWorker;
}

export interface TaskEligibilityExplanation {
  readonly taskId: TaskId;
  readonly eligible: boolean;
  readonly reasonCode: TaskSelectionReasonCode;
  readonly priority: number;
  readonly queueOrder?: number;
  readonly missingCapabilities: readonly string[];
  readonly blockers: readonly TaskId[];
  readonly activeCooldown?: UtcTimestamp;
}

export interface RunnableTaskCandidate {
  readonly task: TaskSnapshot;
  readonly explanation: TaskEligibilityExplanation;
}

export type TaskSelectionResult =
  | { readonly outcome: "selected"; readonly candidate: RunnableTaskCandidate; readonly explanations: readonly TaskEligibilityExplanation[] }
  | { readonly outcome: "no_runnable_task"; readonly explanations: readonly TaskEligibilityExplanation[] }
  | { readonly outcome: "reconciliation_required"; readonly reasons: readonly string[]; readonly explanations: readonly TaskEligibilityExplanation[] };

export type TaskSelectionValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function validTimestamp(value: unknown): value is UtcTimestamp {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validateTaskSelectionMetadata(input: TaskSelectionMetadataInput): TaskSelectionValidationResult<TaskSelectionMetadataInput> {
  if (!validId(input.taskId)) return { ok: false, message: "Task selection metadata has an invalid Task ID." };
  if (input.queueOrder !== undefined && (!Number.isSafeInteger(input.queueOrder) || input.queueOrder <= 0)) return { ok: false, message: "Queue Order must be a positive integer when supplied." };
  if (input.cooldownUntil !== undefined && !validTimestamp(input.cooldownUntil)) return { ok: false, message: "Cooldown timestamp must be canonical UTC." };
  if (!validTimestamp(input.synchronizedAt)) return { ok: false, message: "Synchronization timestamp must be canonical UTC." };
  if (input.dependencyState !== "known" && input.dependencyState !== "unknown") return { ok: false, message: "Dependency projection state is unsupported." };
  const blockers = [...new Set(input.blockers)];
  if (blockers.some((blocker) => !validId(blocker))) return { ok: false, message: "Blocker Task ID is invalid." };
  return { ok: true, value: Object.freeze({ ...input, blockers: Object.freeze(blockers) }) };
}

export function normalizeWorkerCapabilities(capabilities: readonly string[]): TaskSelectionValidationResult<readonly string[]> {
  if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== "string" || capability.trim().length === 0)) return { ok: false, message: "Worker capabilities must be non-empty strings." };
  return { ok: true, value: Object.freeze([...new Set(capabilities.map((capability) => capability.trim()))].sort()) };
}

export function requiredCapabilities(task: TaskSnapshot): readonly string[] {
  return task.requiredCapabilities;
}

export function missingWorkerCapabilities(task: TaskSnapshot, capabilities: readonly string[]): readonly string[] {
  return Object.freeze(requiredCapabilities(task).filter((capability) => !capabilities.includes(capability)).sort());
}

export function cooldownIsActive(cooldownUntil: UtcTimestamp | undefined, evaluatedAt: UtcTimestamp): boolean {
  return cooldownUntil !== undefined && Date.parse(evaluatedAt) < Date.parse(cooldownUntil);
}
