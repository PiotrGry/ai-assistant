import {
  CAPABILITY_VOCABULARY,
  evaluateCapabilities,
  type Capability,
  type CapabilityEvaluation,
  type CapabilityEvaluationInput,
  type CapabilityReasonCode,
  type CapabilityResourceScope,
} from "./capabilities.js";
import type { TaskId, UtcTimestamp } from "./task-domain.js";

export const CAPABILITY_ACTIONS = Object.freeze(Object.fromEntries(CAPABILITY_VOCABULARY.map((capability) => [capability, capability])) as Record<Capability, Capability>);

export type CapabilityGateReasonCode = CapabilityReasonCode | "GRANT_BINDING_MISMATCH" | "AUDIT_FAILURE" | "CANCELLED" | "EVALUATOR_ERROR" | "INVOCATION_ERROR";

export interface CapabilityAuditDecision {
  readonly taskId: TaskId;
  readonly workerId: string;
  readonly correlationId: string;
  readonly action: string;
  readonly outcome: "allowed" | "denied";
  readonly reasonCode: CapabilityGateReasonCode;
  readonly evaluatedAt: UtcTimestamp;
  readonly requiredCapabilities: readonly Capability[];
  readonly grantedCapabilities: readonly Capability[];
  readonly matchedCapabilities: readonly Capability[];
  readonly missingCapabilities: readonly Capability[];
  readonly sensitiveRequirements: readonly Capability[];
  readonly resourceScope?: CapabilityResourceScope;
  readonly approvalReference?: string;
}

export interface CapabilityAuditSink {
  record(decision: CapabilityAuditDecision): Promise<void> | void;
}

export interface CapabilityGateRequest {
  readonly taskId: TaskId;
  readonly workerId: string;
  readonly grantTaskId: TaskId;
  readonly grantWorkerId: string;
  readonly action: string;
  readonly requiredCapabilities?: readonly unknown[];
  readonly workerGrants: readonly unknown[];
  readonly repository?: unknown;
  readonly assignedBranch?: unknown;
  readonly assignedWorktree?: unknown;
  readonly resourceScope?: unknown;
  readonly approvals?: readonly unknown[];
  readonly correlationId: string;
  readonly evaluatedAt: UtcTimestamp;
  readonly signal?: AbortSignal;
}

export interface CapabilityGateDecision extends CapabilityAuditDecision {}
export type CapabilityGateResult<T> =
  | { readonly outcome: "allowed"; readonly decision: CapabilityGateDecision; readonly value: T }
  | { readonly outcome: "denied" | "cancelled" | "failed"; readonly decision: CapabilityGateDecision };

function knownCapabilities(value: readonly unknown[] | undefined): readonly Capability[] {
  return Object.freeze([...new Set(value?.filter((item): item is Capability => typeof item === "string" && CAPABILITY_VOCABULARY.includes(item as Capability)))].sort());
}
function sanitizedScope(value: unknown): CapabilityResourceScope | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields: Array<keyof CapabilityResourceScope> = ["repository", "branch", "worktree", "environment"];
  const result: Partial<Record<keyof CapabilityResourceScope, string>> = {};
  for (const field of fields) if (typeof record[field] === "string" && record[field].trim().length > 0) result[field] = record[field].trim().slice(0, 512);
  return Object.keys(result).length === 0 ? undefined : Object.freeze(result as CapabilityResourceScope);
}
function safeText(value: string): string {
  return value.trim().slice(0, 256);
}
function requirements(request: CapabilityGateRequest): readonly unknown[] {
  if (request.requiredCapabilities !== undefined) return request.requiredCapabilities;
  return [request.action];
}
function decision(request: CapabilityGateRequest, result: CapabilityEvaluation, outcome: "allowed" | "denied", reasonCode: CapabilityGateReasonCode): CapabilityGateDecision {
  const approval = request.approvals?.find((value) => typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).approvalId === "string");
  const approvalReference = approval === undefined ? undefined : String((approval as Record<string, unknown>).approvalId).slice(0, 128);
  const scope = sanitizedScope(request.resourceScope);
  return {
    taskId: request.taskId,
    workerId: safeText(request.workerId),
    correlationId: safeText(request.correlationId),
    action: safeText(request.action),
    outcome,
    reasonCode,
    evaluatedAt: request.evaluatedAt,
    requiredCapabilities: result.requiredCapabilities,
    grantedCapabilities: result.grantedCapabilities,
    matchedCapabilities: result.requiredCapabilities.filter((capability) => result.grantedCapabilities.includes(capability)),
    missingCapabilities: result.missingCapabilities,
    sensitiveRequirements: result.sensitiveRequirements,
    ...(scope === undefined ? {} : { resourceScope: scope }),
    ...(approvalReference === undefined ? {} : { approvalReference }),
  };
}
function emptyEvaluation(request: CapabilityGateRequest): CapabilityEvaluation {
  return { outcome: "denied", allowed: false, requiredCapabilities: knownCapabilities(request.requiredCapabilities), grantedCapabilities: knownCapabilities(request.workerGrants), missingCapabilities: [], sensitiveRequirements: [], approvalRequirements: [], reasonCode: "INVALID_CAPABILITY_SET" };
}

export class CapabilityEnforcementGate {
  readonly #audit: CapabilityAuditSink;

  public constructor(audit: CapabilityAuditSink) {
    this.#audit = audit;
  }

  public async execute<T>(request: CapabilityGateRequest, invoke: () => Promise<T> | T): Promise<CapabilityGateResult<T>> {
    const deny = async (result: CapabilityEvaluation, reasonCode: CapabilityGateReasonCode, outcome: "denied" | "cancelled" = "denied"): Promise<CapabilityGateResult<T>> => {
      const record = decision(request, result, "denied", reasonCode);
      try {
        await this.#audit.record(record);
        return { outcome, decision: record };
      } catch {
        const auditFailure = decision(request, result, "denied", "AUDIT_FAILURE");
        return { outcome: "denied", decision: auditFailure };
      }
    };
    if (request.signal?.aborted) return deny(emptyEvaluation(request), "CANCELLED", "cancelled");
    if (request.taskId !== request.grantTaskId || safeText(request.workerId) !== safeText(request.grantWorkerId)) return deny(emptyEvaluation(request), "GRANT_BINDING_MISMATCH");
    const scope = sanitizedScope(request.resourceScope);
    if (scope === undefined || scope.repository === undefined || scope.branch === undefined || scope.worktree === undefined) {
      return deny(emptyEvaluation(request), "INVALID_RESOURCE_SCOPE");
    }
    let evaluated: CapabilityEvaluation;
    try {
      const input: CapabilityEvaluationInput = {
        taskId: request.taskId,
        requiredCapabilities: requirements(request),
        workerGrants: request.workerGrants,
        ...(request.repository === undefined ? {} : { repository: request.repository }),
        ...(request.assignedBranch === undefined ? {} : { assignedBranch: request.assignedBranch }),
        ...(request.assignedWorktree === undefined ? {} : { assignedWorktree: request.assignedWorktree }),
        resourceScope: request.resourceScope,
        ...(request.approvals === undefined ? {} : { approvals: request.approvals }),
        now: request.evaluatedAt,
      };
      evaluated = evaluateCapabilities(input);
    } catch {
      return deny(emptyEvaluation(request), "EVALUATOR_ERROR");
    }
    if (evaluated.outcome !== "allowed") return deny(evaluated, evaluated.reasonCode);
    const allowedDecision = decision(request, evaluated, "allowed", "ALLOWED");
    try {
      await this.#audit.record(allowedDecision);
    } catch {
      return { outcome: "denied", decision: decision(request, evaluated, "denied", "AUDIT_FAILURE") };
    }
    if (request.signal?.aborted) return { outcome: "cancelled", decision: allowedDecision };
    try {
      return { outcome: "allowed", decision: allowedDecision, value: await invoke() };
    } catch {
      return {
        outcome: request.signal?.aborted ? "cancelled" : "failed",
        decision: request.signal?.aborted ? allowedDecision : decision(request, evaluated, "allowed", "INVOCATION_ERROR"),
      };
    }
  }
}

export function enforceWorkerInvocation<T>(gate: CapabilityEnforcementGate, request: CapabilityGateRequest, invoke: () => Promise<T> | T): Promise<CapabilityGateResult<T>> {
  return gate.execute({ ...request, action: "worker.start" }, invoke);
}

export function enforceMutatingToolInvocation<T>(gate: CapabilityEnforcementGate, request: CapabilityGateRequest, action: string, invoke: () => Promise<T> | T): Promise<CapabilityGateResult<T>> {
  return gate.execute({ ...request, action }, invoke);
}
