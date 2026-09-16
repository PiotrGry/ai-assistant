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

export function buildWorkerFailureDiagnosticSchema(): unknown {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "code", "message"],
    properties: {
      schemaVersion: { type: "integer", const: WORKER_DIAGNOSTIC_SCHEMA_VERSION },
      code: { enum: [...WORKER_FAILURE_CODES] },
      message: { type: "string", minLength: 1, maxLength: 256 },
      exitCode: { type: "integer", minimum: 0, maximum: 255 },
      durationMs: { type: "integer", minimum: 0, maximum: 300_000 },
      stage: { enum: ["process", "cli_envelope", "structured_output", "worker_contract", "git_state"] },
      field: { type: "string", maxLength: 128 },
      receivedType: { type: "string", maxLength: 64 },
      fieldNames: { type: "array", maxItems: 32, items: { type: "string", maxLength: 128 } },
      payloadLength: { type: "integer", minimum: 0, maximum: 1_048_576 },
      payloadDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    },
  });
}

export interface WorkerFailureDiagnostic {
  readonly schemaVersion: typeof WORKER_DIAGNOSTIC_SCHEMA_VERSION;
  readonly code: WorkerFailureCode;
  readonly message: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly stage?: "process" | "cli_envelope" | "structured_output" | "worker_contract" | "git_state";
  readonly field?: string;
  readonly receivedType?: string;
  readonly fieldNames?: readonly string[];
  readonly payloadLength?: number;
  readonly payloadDigest?: string;
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

function safeText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_.:-]+$/u.test(value) ? value : undefined;
}

function safeFields(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields = value.filter((item): item is string => safeText(item, 128) !== undefined).slice(0, 32);
  return fields.length === value.length ? Object.freeze([...fields]) : undefined;
}

export function createWorkerFailureDiagnostic(code: WorkerFailureCode, details: { readonly exitCode?: number | null; readonly durationMs?: number; readonly stage?: WorkerFailureDiagnostic["stage"]; readonly field?: string; readonly receivedType?: string; readonly fieldNames?: readonly string[]; readonly payloadLength?: number; readonly payloadDigest?: string } = {}): WorkerFailureDiagnostic {
  const exitCode = safeNumber(details.exitCode, 255);
  const durationMs = safeNumber(details.durationMs, 300_000);
  const stage = details.stage;
  const field = safeText(details.field, 128);
  const receivedType = safeText(details.receivedType, 64);
  const fieldNames = safeFields(details.fieldNames);
  const payloadLength = safeNumber(details.payloadLength, 1_048_576);
  const payloadDigest = typeof details.payloadDigest === "string" && /^[0-9a-f]{64}$/u.test(details.payloadDigest) ? details.payloadDigest : undefined;
  return Object.freeze({
    schemaVersion: WORKER_DIAGNOSTIC_SCHEMA_VERSION,
    code,
    message: MESSAGES[code],
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(stage === undefined ? {} : { stage }),
    ...(field === undefined ? {} : { field }),
    ...(receivedType === undefined ? {} : { receivedType }),
    ...(fieldNames === undefined ? {} : { fieldNames }),
    ...(payloadLength === undefined ? {} : { payloadLength }),
    ...(payloadDigest === undefined ? {} : { payloadDigest }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateWorkerFailureDiagnostic(value: unknown): WorkerFailureDiagnostic | undefined {
  if (!isRecord(value) || value.schemaVersion !== WORKER_DIAGNOSTIC_SCHEMA_VERSION || typeof value.code !== "string" || !WORKER_FAILURE_CODES.includes(value.code as WorkerFailureCode) || value.message !== MESSAGES[value.code as WorkerFailureCode]) return undefined;
  const exitCode = value.exitCode === undefined ? undefined : safeNumber(value.exitCode, 255);
  const durationMs = value.durationMs === undefined ? undefined : safeNumber(value.durationMs, 300_000);
  const stage = value.stage === undefined ? undefined : ["process", "cli_envelope", "structured_output", "worker_contract", "git_state"].includes(value.stage as string) ? value.stage as WorkerFailureDiagnostic["stage"] : undefined;
  const field = value.field === undefined ? undefined : safeText(value.field, 128);
  const receivedType = value.receivedType === undefined ? undefined : safeText(value.receivedType, 64);
  const fieldNames = value.fieldNames === undefined ? undefined : safeFields(value.fieldNames);
  const payloadLength = value.payloadLength === undefined ? undefined : safeNumber(value.payloadLength, 1_048_576);
  const payloadDigest = value.payloadDigest === undefined ? undefined : typeof value.payloadDigest === "string" && /^[0-9a-f]{64}$/u.test(value.payloadDigest) ? value.payloadDigest : undefined;
  if ((value.exitCode !== undefined && exitCode === undefined) || (value.durationMs !== undefined && durationMs === undefined)) return undefined;
  if ((value.stage !== undefined && stage === undefined) || (value.field !== undefined && field === undefined) || (value.receivedType !== undefined && receivedType === undefined) || (value.fieldNames !== undefined && fieldNames === undefined) || (value.payloadLength !== undefined && payloadLength === undefined) || (value.payloadDigest !== undefined && payloadDigest === undefined)) return undefined;
  const allowed = new Set(["schemaVersion", "code", "message", "exitCode", "durationMs", "stage", "field", "receivedType", "fieldNames", "payloadLength", "payloadDigest"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  return Object.freeze({ schemaVersion: 1, code: value.code as WorkerFailureCode, message: value.message, ...(exitCode === undefined ? {} : { exitCode }), ...(durationMs === undefined ? {} : { durationMs }), ...(stage === undefined ? {} : { stage }), ...(field === undefined ? {} : { field }), ...(receivedType === undefined ? {} : { receivedType }), ...(fieldNames === undefined ? {} : { fieldNames }), ...(payloadLength === undefined ? {} : { payloadLength }), ...(payloadDigest === undefined ? {} : { payloadDigest }) });
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
