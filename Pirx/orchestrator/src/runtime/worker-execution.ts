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

export type CapabilityWorkerExecutionOutcome = "allowed" | "denied" | "unsupported_provider" | "cancelled" | "adapter_failure" | "invalid_request" | "invalid_result" | "unknown";

export type CapabilityWorkerExecutionResult =
  | { readonly outcome: "allowed"; readonly value: WorkerResult; readonly decision: CapabilityGateDecision }
  | { readonly outcome: "denied"; readonly decision: CapabilityGateDecision }
  | { readonly outcome: "unsupported_provider"; readonly message: string; readonly decision: CapabilityGateDecision }
  | { readonly outcome: "cancelled"; readonly decision?: CapabilityGateDecision }
  | { readonly outcome: "adapter_failure"; readonly message: string; readonly decision: CapabilityGateDecision }
  | { readonly outcome: "invalid_request"; readonly violations: readonly WorkerViolation[] }
  | { readonly outcome: "invalid_result"; readonly violations: readonly WorkerViolation[]; readonly decision: CapabilityGateDecision }
  | { readonly outcome: "unknown"; readonly message: string; readonly decision?: CapabilityGateDecision };

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
  if (result.ok) return { outcome: "unknown", message: "Worker request validation returned an inconsistent result." };
  return { outcome: "invalid_request", violations: result.violations };
}
function invalidResult(result: WorkerValidationResult<WorkerResult>, decision: CapabilityGateDecision): CapabilityWorkerExecutionResult {
  if (result.ok) return { outcome: "unknown", message: "Worker result validation returned an inconsistent result.", decision };
  return { outcome: "invalid_result", violations: result.violations, decision };
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
    if (signal.aborted) return { outcome: "cancelled" };
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
    if (gateResult.outcome === "cancelled") return { outcome: "cancelled", decision: gateResult.decision };
    if (gateResult.outcome === "failed") return { outcome: "denied", decision: gateResult.decision };
    if (gateResult.outcome !== "allowed") return { outcome: "denied", decision: gateResult.decision };
    if (signal.aborted) return { outcome: "cancelled", decision: gateResult.decision };
    const adapter = this.#adapters.get(value.provider);
    if (adapter === undefined) return { outcome: "unsupported_provider", message: "No adapter is registered for the assigned provider.", decision: gateResult.decision };
    let raw: WorkerResult;
    try { raw = await adapter.execute(value, signal); }
    catch { return { outcome: signal.aborted ? "cancelled" : "adapter_failure", ...(signal.aborted ? {} : { message: "Worker adapter failed without exposing provider details." }), decision: gateResult.decision } as CapabilityWorkerExecutionResult; }
    const result = validateWorkerResult(raw, value);
    if (!result.ok) return invalidResult(result, gateResult.decision);
    if (containsSecret(result.value)) return { outcome: "invalid_result", violations: [{ code: "invalid_result", field: "result", message: "Worker result contains forbidden sensitive material." }], decision: gateResult.decision };
    return { outcome: "allowed", value: result.value, decision: gateResult.decision };
  }
}

export function executeWorkerWithCapabilities(port: CapabilityAwareWorkerExecutionPort, request: unknown, signal: AbortSignal): Promise<CapabilityWorkerExecutionResult> {
  return port.execute(request, signal);
}
