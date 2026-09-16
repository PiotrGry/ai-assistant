export const WORKER_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;

export const WORKER_FAILURE_CODES = Object.freeze([
  "spawn_failure",
  "process_failure",
  "timeout",
  "cancellation",
  "authentication",
  "quota_exhausted",
  "malformed_cli_envelope",
  "missing_structured_output",
  "invalid_structured_output",
  "worker_contract_mismatch",
  "binding_mismatch",
  "capability_denied",
  "permission_denied",
  "git_state_mismatch",
  "adapter_failure",
] as const);

export type WorkerFailureCode = (typeof WORKER_FAILURE_CODES)[number];

export interface WorkerFailureDiagnostic {
  readonly schemaVersion: typeof WORKER_DIAGNOSTIC_SCHEMA_VERSION;
  readonly code: WorkerFailureCode;
  readonly message: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
}

const MESSAGES: Readonly<Record<WorkerFailureCode, string>> = Object.freeze({
  spawn_failure: "Worker process could not be started.",
  process_failure: "Worker process ended unsuccessfully.",
  timeout: "Worker process exceeded its bounded time limit.",
  cancellation: "Worker process was cancelled.",
  authentication: "Worker authentication was not accepted.",
  quota_exhausted: "Worker provider quota was exhausted.",
  malformed_cli_envelope: "Worker CLI returned a malformed JSON envelope.",
  missing_structured_output: "Worker CLI response did not contain structured output.",
  invalid_structured_output: "Worker CLI structured output was invalid or oversized.",
  worker_contract_mismatch: "Worker result did not satisfy the bound contract.",
  binding_mismatch: "Worker identity or workspace binding did not match.",
  capability_denied: "Worker capability authorization was denied.",
  permission_denied: "Worker permission policy denied the requested operation.",
  git_state_mismatch: "Worker Git state did not match the assigned result.",
  adapter_failure: "Worker adapter failed at its process boundary.",
});

function safeNumber(value: unknown, maximum: number): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum ? value as number : undefined;
}

export function createWorkerFailureDiagnostic(code: WorkerFailureCode, details: { readonly exitCode?: number | null; readonly durationMs?: number } = {}): WorkerFailureDiagnostic {
  const exitCode = safeNumber(details.exitCode, 255);
  const durationMs = safeNumber(details.durationMs, 300_000);
  return Object.freeze({
    schemaVersion: WORKER_DIAGNOSTIC_SCHEMA_VERSION,
    code,
    message: MESSAGES[code],
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateWorkerFailureDiagnostic(value: unknown): WorkerFailureDiagnostic | undefined {
  if (!isRecord(value) || value.schemaVersion !== WORKER_DIAGNOSTIC_SCHEMA_VERSION || typeof value.code !== "string" || !WORKER_FAILURE_CODES.includes(value.code as WorkerFailureCode) || value.message !== MESSAGES[value.code as WorkerFailureCode]) return undefined;
  const exitCode = value.exitCode === undefined ? undefined : safeNumber(value.exitCode, 255);
  const durationMs = value.durationMs === undefined ? undefined : safeNumber(value.durationMs, 300_000);
  if ((value.exitCode !== undefined && exitCode === undefined) || (value.durationMs !== undefined && durationMs === undefined)) return undefined;
  const allowed = new Set(["schemaVersion", "code", "message", "exitCode", "durationMs"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  return Object.freeze({ schemaVersion: 1, code: value.code as WorkerFailureCode, message: value.message, ...(exitCode === undefined ? {} : { exitCode }), ...(durationMs === undefined ? {} : { durationMs }) });
}

export class WorkerFailureError extends Error {
  public readonly diagnostic: WorkerFailureDiagnostic;

  public constructor(diagnostic: WorkerFailureDiagnostic) {
    super(diagnostic.message);
    this.name = "WorkerFailureError";
    this.diagnostic = diagnostic;
  }
}

export function isWorkerFailureError(value: unknown): value is WorkerFailureError {
  return value instanceof WorkerFailureError;
}
