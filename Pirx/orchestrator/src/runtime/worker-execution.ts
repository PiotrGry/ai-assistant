import {
  CapabilityEnforcementGate,
  type CapabilityGateDecision,
} from "./capability-gate.js";
import {
  validateWorkerRequest,
  validateWorkerResult,
  type WorkerPort,
  type WorkerRequest,
  type WorkerResult,
  type WorkerValidationResult,
  type WorkerViolation,
} from "./worker-contract.js";
import type { UtcTimestamp } from "./task-domain.js";
import { createWorkerFailureDiagnostic, isWorkerFailureError, type WorkerFailureDiagnostic } from "./worker-diagnostic.js";

export type CapabilityWorkerExecutionOutcome = "allowed" | "denied" | "unsupported_provider" | "cancelled" | "adapter_failure" | "invalid_request" | "invalid_result" | "unknown";

export type CapabilityWorkerExecutionResult =
  | { readonly outcome: "allowed"; readonly value: WorkerResult; readonly decision: CapabilityGateDecision }
  | { readonly outcome: "denied"; readonly decision: CapabilityGateDecision; readonly diagnostic: WorkerFailureDiagnostic }
  | { readonly outcome: "unsupported_provider"; readonly message: string; readonly decision: CapabilityGateDecision; readonly diagnostic: WorkerFailureDiagnostic }
  | { readonly outcome: "cancelled"; readonly decision?: CapabilityGateDecision; readonly diagnostic: WorkerFailureDiagnostic }
  | { readonly outcome: "adapter_failure"; readonly message: string; readonly decision: CapabilityGateDecision; readonly diagnostic: WorkerFailureDiagnostic }
  | { readonly outcome: "invalid_request"; readonly violations: readonly WorkerViolation[]; readonly diagnostic: WorkerFailureDiagnostic }
  | { readonly outcome: "invalid_result"; readonly violations: readonly WorkerViolation[]; readonly decision: CapabilityGateDecision; readonly diagnostic: WorkerFailureDiagnostic }
  | { readonly outcome: "unknown"; readonly message: string; readonly decision?: CapabilityGateDecision; readonly diagnostic: WorkerFailureDiagnostic };

export interface WorkerAdapterRegistry {
  get(provider: string): WorkerPort | undefined;
}

export interface WorkerExecutionOptions {
  readonly now?: () => UtcTimestamp;
}

function currentTimestamp(): UtcTimestamp { return new Date().toISOString() as UtcTimestamp; }
function generic(message: string): string { return message.slice(0, 256); }
function containsSecret(value: WorkerResult): boolean {
  return /(?:bearer\s+|authorization\s*:\s*|password\s*=|token\s*=|secret\s*=|private[_ -]?key|connection[_ -]?string)/iu.test(JSON.stringify(value));
}
function invalidRequest(result: WorkerValidationResult<WorkerRequest>): CapabilityWorkerExecutionResult {
  if (result.ok) return { outcome: "unknown", message: "Worker request validation returned an inconsistent result.", diagnostic: createWorkerFailureDiagnostic("binding_mismatch") };
  return { outcome: "invalid_request", violations: result.violations, diagnostic: createWorkerFailureDiagnostic("binding_mismatch") };
}
function invalidResult(result: WorkerValidationResult<WorkerResult>, decision: CapabilityGateDecision): CapabilityWorkerExecutionResult {
  if (result.ok) return { outcome: "unknown", message: "Worker result validation returned an inconsistent result.", decision, diagnostic: createWorkerFailureDiagnostic("worker_contract_mismatch") };
  return { outcome: "invalid_result", violations: result.violations, decision, diagnostic: createWorkerFailureDiagnostic(result.violations.some((item) => item.code === "binding_mismatch") ? "binding_mismatch" : "worker_contract_mismatch") };
}

export class CapabilityAwareWorkerExecutionPort {
  readonly #gate: CapabilityEnforcementGate;
  readonly #adapters: WorkerAdapterRegistry;
  readonly #now: () => UtcTimestamp;

  public constructor(gate: CapabilityEnforcementGate, adapters: WorkerAdapterRegistry, options: WorkerExecutionOptions = {}) {
    this.#gate = gate;
    this.#adapters = adapters;
    this.#now = options.now ?? currentTimestamp;
  }

  public async execute(request: unknown, signal: AbortSignal): Promise<CapabilityWorkerExecutionResult> {
    const validated = validateWorkerRequest(request);
    if (!validated.ok) return invalidRequest(validated);
    const value = validated.value;
    if (signal.aborted) return { outcome: "cancelled", diagnostic: createWorkerFailureDiagnostic("cancellation") };
    const gateResult = await this.#gate.execute({
      taskId: value.taskId,
      workerId: value.workerId,
      grantTaskId: value.capabilityGrant.taskId,
      grantWorkerId: value.capabilityGrant.workerId,
      action: value.capabilityGrant.requiredCapabilities[0] ?? "worker.start",
      requiredCapabilities: value.capabilityGrant.requiredCapabilities,
      workerGrants: value.capabilityGrant.grantedCapabilities,
      repository: `${value.repository.owner}/${value.repository.repository}`,
      assignedBranch: value.workspace.branch,
      assignedWorktree: value.workspace.worktree,
      resourceScope: value.capabilityGrant.resourceScope,
      correlationId: value.correlationId,
      evaluatedAt: this.#now(),
      signal,
    }, () => undefined);
    if (gateResult.outcome === "cancelled") return { outcome: "cancelled", decision: gateResult.decision, diagnostic: createWorkerFailureDiagnostic("cancellation") };
    if (gateResult.outcome === "failed") return { outcome: "denied", decision: gateResult.decision, diagnostic: createWorkerFailureDiagnostic("capability_denied") };
    if (gateResult.outcome !== "allowed") return { outcome: "denied", decision: gateResult.decision, diagnostic: createWorkerFailureDiagnostic("capability_denied") };
    if (signal.aborted) return { outcome: "cancelled", decision: gateResult.decision, diagnostic: createWorkerFailureDiagnostic("cancellation") };
    const adapter = this.#adapters.get(value.provider);
    if (adapter === undefined) return { outcome: "unsupported_provider", message: "No adapter is registered for the assigned provider.", decision: gateResult.decision, diagnostic: createWorkerFailureDiagnostic("adapter_failure") };
    let raw: WorkerResult;
    try { raw = await adapter.execute(value, signal); }
    catch (error: unknown) {
      const diagnostic = signal.aborted ? createWorkerFailureDiagnostic("cancellation") : isWorkerFailureError(error) ? error.diagnostic : createWorkerFailureDiagnostic("adapter_failure");
      return signal.aborted ? { outcome: "cancelled", decision: gateResult.decision, diagnostic } : { outcome: "adapter_failure", message: diagnostic.message, decision: gateResult.decision, diagnostic };
    }
    const result = validateWorkerResult(raw, value);
    if (!result.ok) return invalidResult(result, gateResult.decision);
    if (containsSecret(result.value)) return { outcome: "invalid_result", violations: [{ code: "invalid_result", field: "result", message: "Worker result contains forbidden sensitive material." }], decision: gateResult.decision, diagnostic: createWorkerFailureDiagnostic("worker_contract_mismatch") };
    return { outcome: "allowed", value: result.value, decision: gateResult.decision };
  }
}

export function executeWorkerWithCapabilities(port: CapabilityAwareWorkerExecutionPort, request: unknown, signal: AbortSignal): Promise<CapabilityWorkerExecutionResult> {
  return port.execute(request, signal);
}
