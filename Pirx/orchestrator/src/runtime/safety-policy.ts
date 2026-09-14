import {
  CapabilityEnforcementGate,
  type CapabilityGateDecision,
  type CapabilityGateReasonCode,
  type CapabilityGateRequest,
  type CapabilityGateResult,
} from "./capability-gate.js";
import type { Capability, CapabilityResourceScope } from "./capabilities.js";
import type { TaskId, UtcTimestamp } from "./task-domain.js";

export const SAFETY_POLICY_SCHEMA_VERSION = 1 as const;
export const SAFETY_POLICY_ACTIONS = Object.freeze([
  "ci.read",
  "ci.logs.read",
  "ci.write",
  "workflow.modify",
  "infrastructure.read",
  "infrastructure.write",
  "cost.read",
  "cost.modify",
  "deployment.read",
  "deployment.modify",
  "application_logs.read",
  "metrics.read",
  "production.read",
  "production.write",
  "production.mutate",
] as const);

export type SafetyPolicyAction = (typeof SAFETY_POLICY_ACTIONS)[number];
export type SafetyPolicyReasonCode =
  | "ALLOWED"
  | "UNKNOWN_ACTION"
  | "AMBIGUOUS_ACTION"
  | "UNSUPPORTED_ACTION"
  | "INVALID_RESOURCE_SCOPE"
  | "MISSING_SCOPE"
  | "MISSING_GRANT"
  | "SENSITIVE_APPROVAL_REQUIRED"
  | "EXPIRED_APPROVAL"
  | "REVOKED_APPROVAL"
  | "USED_APPROVAL"
  | "WRONG_TASK_APPROVAL"
  | "APPROVAL_SCOPE_MISMATCH"
  | "AUDIT_FAILURE"
  | "CANCELLED"
  | "INVOCATION_ERROR";

export interface SafetyPolicyRow {
  readonly action: SafetyPolicyAction;
  readonly class: "read" | "write";
  readonly decision: "allow_with_gate" | "human_action_required";
  readonly capability?: Capability;
}

export const SAFETY_POLICY_MATRIX: readonly SafetyPolicyRow[] = Object.freeze([
  { action: "ci.read", class: "read", decision: "allow_with_gate", capability: "ci.read" },
  { action: "ci.logs.read", class: "read", decision: "allow_with_gate", capability: "ci.logs.read" },
  { action: "ci.write", class: "write", decision: "human_action_required" },
  { action: "workflow.modify", class: "write", decision: "human_action_required" },
  { action: "infrastructure.read", class: "read", decision: "human_action_required" },
  { action: "infrastructure.write", class: "write", decision: "human_action_required" },
  { action: "cost.read", class: "read", decision: "human_action_required" },
  { action: "cost.modify", class: "write", decision: "human_action_required" },
  { action: "deployment.read", class: "read", decision: "human_action_required" },
  { action: "deployment.modify", class: "write", decision: "human_action_required" },
  { action: "application_logs.read", class: "read", decision: "allow_with_gate", capability: "application_logs.read" },
  { action: "metrics.read", class: "read", decision: "allow_with_gate", capability: "metrics.read" },
  { action: "production.read", class: "read", decision: "allow_with_gate", capability: "production.read" },
  { action: "production.write", class: "write", decision: "human_action_required" },
  { action: "production.mutate", class: "write", decision: "human_action_required" },
]);

export interface HumanActionRecord {
  readonly schemaVersion: typeof SAFETY_POLICY_SCHEMA_VERSION;
  readonly taskId: TaskId;
  readonly requestedAction: string;
  readonly resourceScope: CapabilityResourceScope;
  readonly reasonCode: Exclude<SafetyPolicyReasonCode, "ALLOWED">;
  readonly requiredCapability?: Capability;
  readonly requiredApproval?: boolean;
  readonly nextInstruction: string;
}

export interface SafetyPolicyRequest {
  readonly taskId: TaskId;
  readonly requestedAction: unknown;
  readonly resourceScope: unknown;
  readonly evaluatedAt: UtcTimestamp;
}

export type SafetyPolicyDecision =
  | { readonly outcome: "allowed"; readonly action: SafetyPolicyAction; readonly capability: Capability; readonly resourceScope: CapabilityResourceScope }
  | { readonly outcome: "denied" | "human_action_required"; readonly action: string; readonly reasonCode: Exclude<SafetyPolicyReasonCode, "ALLOWED">; readonly humanAction: HumanActionRecord };

export type SafetyInvocationRequest = Omit<CapabilityGateRequest, "action"> & { readonly requestedAction: unknown };
export type SafetyInvocationResult<T> =
  | { readonly outcome: "allowed"; readonly decision: CapabilityGateDecision; readonly value: T; readonly policy: Extract<SafetyPolicyDecision, { readonly outcome: "allowed" }> }
  | { readonly outcome: "denied" | "human_action_required"; readonly policy: SafetyPolicyDecision; readonly humanAction: HumanActionRecord; readonly decision?: CapabilityGateDecision }
  | { readonly outcome: "cancelled" | "failed"; readonly policy: Extract<SafetyPolicyDecision, { readonly outcome: "allowed" }>; readonly decision: CapabilityGateDecision };

const ACTION_SET = new Set<string>(SAFETY_POLICY_ACTIONS);
const POLICY_BY_ACTION = new Map<SafetyPolicyAction, SafetyPolicyRow>(SAFETY_POLICY_MATRIX.map((row) => [row.action, row]));
const MAX_TEXT = 160;

function boundedText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, MAX_TEXT) : fallback;
}

function safeScope(value: unknown): CapabilityResourceScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return Object.freeze({});
  const record = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const field of ["repository", "branch", "worktree", "environment"] as const) {
    if (typeof record[field] === "string" && record[field].trim().length > 0) result[field] = record[field].trim().slice(0, MAX_TEXT);
  }
  return Object.freeze(result as CapabilityResourceScope);
}

function validScope(value: unknown): value is CapabilityResourceScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.repository === "string" && record.repository.trim().length > 0
    && typeof record.branch === "string" && record.branch.trim().length > 0
    && typeof record.worktree === "string" && record.worktree.trim().length > 0;
}

function nextInstruction(reasonCode: Exclude<SafetyPolicyReasonCode, "ALLOWED">): string {
  if (reasonCode === "MISSING_SCOPE" || reasonCode === "INVALID_RESOURCE_SCOPE") return "Provide an exact repository, assigned branch, and assigned worktree scope, then retry.";
  if (reasonCode === "SENSITIVE_APPROVAL_REQUIRED" || reasonCode === "EXPIRED_APPROVAL" || reasonCode === "REVOKED_APPROVAL" || reasonCode === "USED_APPROVAL" || reasonCode === "WRONG_TASK_APPROVAL" || reasonCode === "APPROVAL_SCOPE_MISMATCH") return "Obtain a current approval bound to this Task, capability, and exact resource scope before retrying.";
  if (reasonCode === "MISSING_GRANT") return "Request an explicit reviewed capability grant for this Task before retrying.";
  if (reasonCode === "UNSUPPORTED_ACTION") return "Create a separately reviewed safety contract; this worker must not execute the requested mutation.";
  return "Review the requested action and provide an explicit supported contract before retrying.";
}

function humanAction(taskId: TaskId, requestedAction: unknown, resourceScope: unknown, reasonCode: Exclude<SafetyPolicyReasonCode, "ALLOWED">, capability?: Capability): HumanActionRecord {
  const action = typeof requestedAction === "string" && ACTION_SET.has(requestedAction) ? requestedAction : "unknown";
  return Object.freeze({
    schemaVersion: SAFETY_POLICY_SCHEMA_VERSION,
    taskId,
    requestedAction: boundedText(action, "unknown"),
    resourceScope: safeScope(resourceScope),
    reasonCode,
    ...(capability === undefined ? {} : { requiredCapability: capability }),
    ...(capability === undefined ? {} : { requiredApproval: true }),
    nextInstruction: nextInstruction(reasonCode),
  });
}

function gateReason(reason: CapabilityGateReasonCode): Exclude<SafetyPolicyReasonCode, "ALLOWED"> {
  if (reason === "SENSITIVE_APPROVAL_REQUIRED" || reason === "EXPIRED_APPROVAL" || reason === "REVOKED_APPROVAL" || reason === "USED_APPROVAL" || reason === "WRONG_TASK_APPROVAL" || reason === "APPROVAL_SCOPE_MISMATCH" || reason === "MISSING_GRANT" || reason === "AUDIT_FAILURE" || reason === "CANCELLED" || reason === "INVOCATION_ERROR") return reason;
  if (reason === "INVALID_RESOURCE_SCOPE") return "INVALID_RESOURCE_SCOPE";
  return "UNSUPPORTED_ACTION";
}

export function evaluateSafetyPolicy(request: SafetyPolicyRequest): SafetyPolicyDecision {
  const action = typeof request.requestedAction === "string" ? request.requestedAction.trim() : "";
  const scope = safeScope(request.resourceScope);
  if (action.includes("read") && /(write|modify|mutate)/u.test(action)) {
    const reasonCode = "AMBIGUOUS_ACTION" as const;
    return { outcome: "denied", action: boundedText(action, "unknown"), reasonCode, humanAction: humanAction(request.taskId, action, scope, reasonCode) };
  }
  if (!ACTION_SET.has(action)) {
    const reasonCode = "UNKNOWN_ACTION" as const;
    return { outcome: "denied", action: boundedText(action, "unknown"), reasonCode, humanAction: humanAction(request.taskId, action, scope, reasonCode) };
  }
  const row = POLICY_BY_ACTION.get(action as SafetyPolicyAction);
  if (row === undefined || row.decision === "human_action_required" || row.capability === undefined) {
    const reasonCode = "UNSUPPORTED_ACTION" as const;
    return { outcome: "human_action_required", action, reasonCode, humanAction: humanAction(request.taskId, action, scope, reasonCode) };
  }
  if (!validScope(request.resourceScope)) {
    const reasonCode = "MISSING_SCOPE" as const;
    return { outcome: "denied", action, reasonCode, humanAction: humanAction(request.taskId, action, scope, reasonCode, row.capability) };
  }
  if (scope.repository === undefined || scope.branch === undefined || scope.worktree === undefined) {
    const reasonCode = "MISSING_SCOPE" as const;
    return { outcome: "denied", action, reasonCode, humanAction: humanAction(request.taskId, action, scope, reasonCode, row.capability) };
  }
  return { outcome: "allowed", action: action as SafetyPolicyAction, capability: row.capability, resourceScope: scope };
}

export class SafetyEnforcementGate {
  readonly #gate: CapabilityEnforcementGate;

  public constructor(gate: CapabilityEnforcementGate) {
    this.#gate = gate;
  }

  public async execute<T>(request: SafetyInvocationRequest, invoke: () => Promise<T> | T): Promise<SafetyInvocationResult<T>> {
    const policy = evaluateSafetyPolicy({ taskId: request.taskId, requestedAction: request.requestedAction, resourceScope: request.resourceScope, evaluatedAt: request.evaluatedAt });
    if (policy.outcome !== "allowed") return { outcome: policy.outcome, policy, humanAction: policy.humanAction };
    const gateRequest: CapabilityGateRequest = { ...request, action: policy.capability, requiredCapabilities: [policy.capability] };
    const result: CapabilityGateResult<T> = await this.#gate.execute(gateRequest, invoke);
    if (result.outcome === "allowed") return { outcome: "allowed", decision: result.decision, value: result.value, policy };
    if (result.outcome === "cancelled" || result.outcome === "failed") return { outcome: result.outcome, policy, decision: result.decision };
    const reasonCode = gateReason(result.decision.reasonCode);
    return { outcome: "denied", policy, humanAction: humanAction(request.taskId, request.requestedAction, request.resourceScope, reasonCode, policy.capability), decision: result.decision };
  }
}

export function enforceSafetyInvocation<T>(gate: SafetyEnforcementGate, request: SafetyInvocationRequest, invoke: () => Promise<T> | T): Promise<SafetyInvocationResult<T>> {
  return gate.execute(request, invoke);
}
