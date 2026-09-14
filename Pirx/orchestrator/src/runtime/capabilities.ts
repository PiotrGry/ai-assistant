import type { TaskId, UtcTimestamp } from "./task-domain.js";

export const CAPABILITY_VOCABULARY = Object.freeze([
  "repository.read",
  "repository.write",
  "tests.run",
  "git.commit",
  "git.push_assigned_branch",
  "ci.read",
  "ci.logs.read",
  "application_logs.read",
  "metrics.read",
  "production.read",
] as const);

export type Capability = (typeof CAPABILITY_VOCABULARY)[number];
export const SENSITIVE_CAPABILITIES = Object.freeze(["application_logs.read", "ci.logs.read", "ci.read", "metrics.read", "production.read"] as const);
const CAPABILITY_SET = new Set<string>(CAPABILITY_VOCABULARY);
const SENSITIVE_SET = new Set<string>(SENSITIVE_CAPABILITIES);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface CapabilityResourceScope {
  readonly repository?: string;
  readonly branch?: string;
  readonly environment?: string;
}

export type CapabilityApprovalState = "active" | "used" | "revoked";
export interface CapabilityApproval {
  readonly approvalId: string;
  readonly taskId: TaskId;
  readonly capability: Capability;
  readonly resourceScope: CapabilityResourceScope;
  readonly approver: string;
  readonly issuedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly oneUse: boolean;
  readonly state: CapabilityApprovalState;
}

export interface CapabilityValidationViolation {
  readonly code: "invalid_input" | "unknown_capability" | "invalid_scope" | "invalid_approval";
  readonly field: string;
  readonly message: string;
}
export type CapabilityValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violations: readonly CapabilityValidationViolation[] };

export type CapabilityReasonCode =
  | "ALLOWED"
  | "INVALID_CAPABILITY_SET"
  | "UNKNOWN_CAPABILITY"
  | "MISSING_GRANT"
  | "INVALID_RESOURCE_SCOPE"
  | "RESOURCE_SCOPE_MISMATCH"
  | "ASSIGNED_BRANCH_REQUIRED"
  | "ASSIGNED_BRANCH_MISMATCH"
  | "SENSITIVE_APPROVAL_REQUIRED"
  | "EXPIRED_APPROVAL"
  | "REVOKED_APPROVAL"
  | "USED_APPROVAL"
  | "WRONG_TASK_APPROVAL"
  | "APPROVAL_SCOPE_MISMATCH"
  | "INVALID_APPROVAL";

export interface CapabilityApprovalRequirement {
  readonly capability: Capability;
  readonly resourceScope?: CapabilityResourceScope;
  readonly reasonCode: Exclude<CapabilityReasonCode, "ALLOWED" | "MISSING_GRANT">;
}

export interface CapabilityEvaluationInput {
  readonly taskId: TaskId;
  readonly requiredCapabilities: readonly unknown[];
  readonly workerGrants: readonly unknown[];
  readonly repository?: unknown;
  readonly assignedBranch?: unknown;
  readonly resourceScope?: unknown;
  readonly approvals?: readonly unknown[];
  readonly now: UtcTimestamp;
}

export interface CapabilityEvaluation {
  readonly outcome: "allowed" | "denied";
  readonly allowed: boolean;
  readonly requiredCapabilities: readonly Capability[];
  readonly grantedCapabilities: readonly Capability[];
  readonly missingCapabilities: readonly Capability[];
  readonly sensitiveRequirements: readonly Capability[];
  readonly approvalRequirement?: CapabilityApprovalRequirement;
  readonly approvalRequirements: readonly CapabilityApprovalRequirement[];
  readonly reasonCode: CapabilityReasonCode;
}

function violation(code: CapabilityValidationViolation["code"], field: string, message: string): CapabilityValidationViolation {
  return { code, field, message };
}
function success<T>(value: T): CapabilityValidationResult<T> {
  return { ok: true, value };
}
function failure<T>(...violations: CapabilityValidationViolation[]): CapabilityValidationResult<T> {
  return { ok: false, violations: Object.freeze(violations) };
}
function canonicalText(value: unknown, field: string, max = 512): string | CapabilityValidationViolation {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) return violation("invalid_input", field, `${field} must be a non-empty bounded string.`);
  return value.trim();
}
function canonicalTimestamp(value: unknown, field: string): UtcTimestamp | CapabilityValidationViolation {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return violation("invalid_input", field, `${field} must be a canonical UTC timestamp.`);
  return value as UtcTimestamp;
}
function normalizeScope(value: unknown, field: string): CapabilityValidationResult<CapabilityResourceScope> {
  if (!isRecord(value)) return failure(violation("invalid_scope", field, `${field} must be a non-empty scope object.`));
  const allowed = new Set(["repository", "branch", "environment"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return failure(violation("invalid_scope", `${field}.${key}`, "Unknown resource scope field."));
  const values: Record<string, string> = {};
  for (const key of ["repository", "branch", "environment"] as const) {
    if (value[key] === undefined) continue;
    const parsed = canonicalText(value[key], `${field}.${key}`);
    if (typeof parsed !== "string") return failure(violation("invalid_scope", parsed.field, parsed.message));
    values[key] = parsed;
  }
  if (Object.keys(values).length === 0) return failure(violation("invalid_scope", field, `${field} must contain at least one resource.`));
  return success(Object.freeze({ ...(values.repository === undefined ? {} : { repository: values.repository }), ...(values.branch === undefined ? {} : { branch: values.branch }), ...(values.environment === undefined ? {} : { environment: values.environment }) }));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function scopeEqual(left: CapabilityResourceScope, right: CapabilityResourceScope): boolean {
  return left.repository === right.repository && left.branch === right.branch && left.environment === right.environment;
}
function normalizeList(value: unknown, field: string, allowEmpty: boolean): CapabilityValidationResult<readonly Capability[]> {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return failure(violation("invalid_input", field, `${field} must be a ${allowEmpty ? "possibly empty " : "non-empty "}array.`));
  const values = new Set<Capability>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !CAPABILITY_SET.has(item)) return failure(violation("unknown_capability", `${field}[${index}]`, "Capability is outside the closed vocabulary."));
    values.add(item as Capability);
  }
  return success(Object.freeze([...values].sort()));
}

export function normalizeCapabilitySet(value: unknown, field = "capabilities", allowEmpty = true): CapabilityValidationResult<readonly Capability[]> {
  return normalizeList(value, field, allowEmpty);
}

export function validateCapabilityApproval(value: unknown, field = "approval"): CapabilityValidationResult<CapabilityApproval> {
  if (!isRecord(value)) return failure(violation("invalid_approval", field, `${field} must be an object.`));
  const approvalId = canonicalText(value.approvalId, `${field}.approvalId`, 128);
  const taskId = canonicalText(value.taskId, `${field}.taskId`, 128);
  const capability = value.capability;
  const approver = canonicalText(value.approver, `${field}.approver`, 256);
  const issuedAt = canonicalTimestamp(value.issuedAt, `${field}.issuedAt`);
  const expiresAt = canonicalTimestamp(value.expiresAt, `${field}.expiresAt`);
  const resourceScope = normalizeScope(value.resourceScope, `${field}.resourceScope`);
  for (const parsed of [approvalId, taskId, approver, issuedAt, expiresAt]) if (typeof parsed !== "string") return failure(violation("invalid_approval", parsed.field, parsed.message));
  if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) return failure(violation("unknown_capability", `${field}.capability`, "Approval capability is outside the closed vocabulary."));
  if (typeof value.oneUse !== "boolean") return failure(violation("invalid_approval", `${field}.oneUse`, "oneUse must be boolean."));
  if (typeof value.state !== "string" || !["active", "used", "revoked"].includes(value.state)) return failure(violation("invalid_approval", `${field}.state`, "Approval state is unsupported."));
  if (!resourceScope.ok) return resourceScope;
  if (Date.parse(issuedAt as string) >= Date.parse(expiresAt as string)) return failure(violation("invalid_approval", `${field}.expiresAt`, "Approval expiry must be after issuance."));
  if (!ID_PATTERN.test(taskId as string)) return failure(violation("invalid_approval", `${field}.taskId`, "Approval Task ID is invalid."));
  return success(Object.freeze({ approvalId: approvalId as string, taskId: taskId as TaskId, capability: capability as Capability, resourceScope: resourceScope.value, approver: approver as string, issuedAt: issuedAt as UtcTimestamp, expiresAt: expiresAt as UtcTimestamp, oneUse: value.oneUse, state: value.state as CapabilityApprovalState }));
}

function denied(input: Partial<CapabilityEvaluation> & Pick<CapabilityEvaluation, "requiredCapabilities" | "grantedCapabilities" | "missingCapabilities" | "sensitiveRequirements" | "approvalRequirements">, reasonCode: CapabilityReasonCode): CapabilityEvaluation {
  return Object.freeze({ outcome: "denied", allowed: false, ...input, reasonCode });
}

export function evaluateCapabilities(input: CapabilityEvaluationInput): CapabilityEvaluation {
  const required = normalizeList(input.requiredCapabilities, "requiredCapabilities", false);
  const grants = normalizeList(input.workerGrants, "workerGrants", true);
  const empty = Object.freeze([]) as readonly Capability[];
  if (!required.ok) return denied({ requiredCapabilities: empty, grantedCapabilities: empty, missingCapabilities: empty, sensitiveRequirements: empty, approvalRequirements: [] }, required.violations[0]?.code === "unknown_capability" ? "UNKNOWN_CAPABILITY" : "INVALID_CAPABILITY_SET");
  if (!grants.ok) return denied({ requiredCapabilities: required.value, grantedCapabilities: empty, missingCapabilities: required.value, sensitiveRequirements: required.value.filter((item) => SENSITIVE_SET.has(item)), approvalRequirements: [] }, grants.violations[0]?.code === "unknown_capability" ? "UNKNOWN_CAPABILITY" : "INVALID_CAPABILITY_SET");
  const missing = required.value.filter((capability) => !grants.value.includes(capability));
  const sensitive = required.value.filter((capability) => SENSITIVE_SET.has(capability));
  const repository = input.repository === undefined ? undefined : canonicalText(input.repository, "repository");
  const branch = input.assignedBranch === undefined ? undefined : canonicalText(input.assignedBranch, "assignedBranch");
  const scope = input.resourceScope === undefined ? undefined : normalizeScope(input.resourceScope, "resourceScope");
  if (repository !== undefined && typeof repository !== "string") return denied({ requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: missing, sensitiveRequirements: sensitive, approvalRequirements: [] }, "INVALID_RESOURCE_SCOPE");
  if (branch !== undefined && typeof branch !== "string") return denied({ requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: missing, sensitiveRequirements: sensitive, approvalRequirements: [] }, "INVALID_RESOURCE_SCOPE");
  if (scope !== undefined && !scope.ok) return denied({ requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: missing, sensitiveRequirements: sensitive, approvalRequirements: [] }, "INVALID_RESOURCE_SCOPE");
  const normalizedScope = scope === undefined ? undefined : scope.value;
  if (repository !== undefined && normalizedScope?.repository !== undefined && repository !== normalizedScope.repository) return denied({ requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: missing, sensitiveRequirements: sensitive, approvalRequirements: [] }, "RESOURCE_SCOPE_MISMATCH");
  if (branch !== undefined && normalizedScope?.branch !== undefined && branch !== normalizedScope.branch) return denied({ requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: missing, sensitiveRequirements: sensitive, approvalRequirements: [] }, "ASSIGNED_BRANCH_MISMATCH");
  if (required.value.includes("git.push_assigned_branch") && branch === undefined) return denied({ requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: missing, sensitiveRequirements: sensitive, approvalRequirements: [] }, "ASSIGNED_BRANCH_REQUIRED");
  const approvals: CapabilityApproval[] = [];
  for (const [index, value] of (input.approvals ?? []).entries()) {
    const parsed = validateCapabilityApproval(value, `approvals[${index}]`);
    if (!parsed.ok) return denied({ requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: missing, sensitiveRequirements: sensitive, approvalRequirements: [] }, parsed.violations[0]?.code === "unknown_capability" ? "UNKNOWN_CAPABILITY" : "INVALID_APPROVAL");
    approvals.push(parsed.value);
  }
  const approvalRequirements: CapabilityApprovalRequirement[] = [];
  for (const capability of sensitive) {
    const requirement: CapabilityApprovalRequirement = { capability, ...(normalizedScope === undefined ? {} : { resourceScope: normalizedScope }), reasonCode: "SENSITIVE_APPROVAL_REQUIRED" };
    const approval = approvals.find((candidate) => candidate.capability === capability);
    if (normalizedScope === undefined) {
      approvalRequirements.push(requirement);
      continue;
    }
    if (approval === undefined) approvalRequirements.push(requirement);
    else if (approval.taskId !== input.taskId) approvalRequirements.push({ ...requirement, reasonCode: "WRONG_TASK_APPROVAL" });
    else if (!scopeEqual(approval.resourceScope, normalizedScope)) approvalRequirements.push({ ...requirement, reasonCode: "APPROVAL_SCOPE_MISMATCH" });
    else if (approval.state === "revoked") approvalRequirements.push({ ...requirement, reasonCode: "REVOKED_APPROVAL" });
    else if (approval.state === "used") approvalRequirements.push({ ...requirement, reasonCode: "USED_APPROVAL" });
    else if (Date.parse(input.now) >= Date.parse(approval.expiresAt)) approvalRequirements.push({ ...requirement, reasonCode: "EXPIRED_APPROVAL" });
    else if (Date.parse(input.now) < Date.parse(approval.issuedAt)) approvalRequirements.push({ ...requirement, reasonCode: "SENSITIVE_APPROVAL_REQUIRED" });
  }
  if (missing.length > 0) return denied({ requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: missing, sensitiveRequirements: sensitive, ...(approvalRequirements[0] === undefined ? {} : { approvalRequirement: approvalRequirements[0] }), approvalRequirements }, "MISSING_GRANT");
  if (approvalRequirements.length > 0) return denied({ requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: missing, sensitiveRequirements: sensitive, ...(approvalRequirements[0] === undefined ? {} : { approvalRequirement: approvalRequirements[0] }), approvalRequirements }, approvalRequirements[0]?.reasonCode ?? "SENSITIVE_APPROVAL_REQUIRED");
  return Object.freeze({ outcome: "allowed", allowed: true, requiredCapabilities: required.value, grantedCapabilities: grants.value, missingCapabilities: empty, sensitiveRequirements: sensitive, approvalRequirements: Object.freeze([]), reasonCode: "ALLOWED" as const });
}
