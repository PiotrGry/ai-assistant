import type { AttemptId, TaskId } from "./task-domain.js";
import { buildWorkerFailureDiagnosticSchema, type WorkerFailureDiagnostic } from "./worker-diagnostic.js";

export const WORKER_RESULT_CONTRACT_SCHEMA_VERSION = 1 as const;
export type WorkerResultContractSchemaVersion = typeof WORKER_RESULT_CONTRACT_SCHEMA_VERSION;

export const WORKER_RESULT_OUTCOMES = Object.freeze([
  "CODE_PUSHED",
  "BLOCKED",
  "FAILED",
  "QUOTA_EXHAUSTED",
  "CANCELLED",
  "UNKNOWN",
] as const);
export type WorkerResultOutcome = (typeof WORKER_RESULT_OUTCOMES)[number];
export type WorkerNonSuccessOutcome = Exclude<WorkerResultOutcome, "CODE_PUSHED">;

export interface WorkerResultBase {
  readonly kind: "worker_result";
  readonly schemaVersion: typeof WORKER_RESULT_CONTRACT_SCHEMA_VERSION;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly correlationId: string;
}

export type WorkerResult =
  | (WorkerResultBase & { readonly outcome: "CODE_PUSHED"; readonly branch: string; readonly finalCommit: string })
  | (WorkerResultBase & { readonly outcome: WorkerNonSuccessOutcome; readonly reason: string; readonly diagnostic?: WorkerFailureDiagnostic });

export const WORKER_RESULT_COMMON_FIELDS = Object.freeze([
  "kind",
  "schemaVersion",
  "taskId",
  "attemptId",
  "correlationId",
  "outcome",
] as const);

export interface WorkerResultVariantContract {
  readonly outcome: WorkerResultOutcome;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly forbidden: readonly string[];
}

const codePushed = Object.freeze({
  outcome: "CODE_PUSHED",
  required: Object.freeze([...WORKER_RESULT_COMMON_FIELDS, "branch", "finalCommit"]),
  optional: Object.freeze([]),
  forbidden: Object.freeze(["reason", "diagnostic"]),
} satisfies WorkerResultVariantContract);

const nonSuccess = (outcome: WorkerNonSuccessOutcome): WorkerResultVariantContract => Object.freeze({
  outcome,
  required: Object.freeze([...WORKER_RESULT_COMMON_FIELDS, "reason"]),
  optional: Object.freeze(["diagnostic"]),
  forbidden: Object.freeze(["branch", "finalCommit"]),
});

/** The single semantic matrix used by validation, CLI projection and instructions. */
export const WORKER_RESULT_VARIANTS = Object.freeze([
  codePushed,
  nonSuccess("BLOCKED"),
  nonSuccess("FAILED"),
  nonSuccess("QUOTA_EXHAUSTED"),
  nonSuccess("CANCELLED"),
  nonSuccess("UNKNOWN"),
] as const);

export const WORKER_RESULT_ALLOWED_FIELDS = Object.freeze([
  ...WORKER_RESULT_COMMON_FIELDS,
  "branch",
  "finalCommit",
  "reason",
  "diagnostic",
] as const);

export function workerResultVariant(outcome: unknown): WorkerResultVariantContract | undefined {
  return WORKER_RESULT_VARIANTS.find((variant) => variant.outcome === outcome);
}

function fields(fields: readonly string[]): string {
  if (fields.length === 0) return "none";
  if (fields.length === 1) return fields[0] as string;
  if (fields.length === 2) return `${fields[0]} and ${fields[1]}`;
  return `${fields.slice(0, -1).join(", ")}, and ${fields[fields.length - 1]}`;
}

function variantInstruction(variant: WorkerResultVariantContract): string {
  const conditionalRequired = variant.required.filter((field) => !WORKER_RESULT_COMMON_FIELDS.includes(field as (typeof WORKER_RESULT_COMMON_FIELDS)[number]));
  const requiredText = conditionalRequired.length === 0 ? "include no variant-specific fields" : `include ${fields(conditionalRequired)}`;
  const forbiddenText = variant.forbidden.length === 0 ? "omit no fields" : `omit ${fields(variant.forbidden)}`;
  return `${variant.outcome} requires ${fields(variant.required)}; ${variant.outcome} ${requiredText}; ${forbiddenText}; optional fields: ${fields(variant.optional)}.`;
}

/** Generated from the semantic matrix; it is intentionally explicit and bounded. */
export function workerResultContractInstruction(): string {
  const nonSuccessRequired = [...new Set(WORKER_RESULT_VARIANTS
    .filter((variant) => variant.outcome !== "CODE_PUSHED")
    .flatMap((variant) => variant.required)
    .filter((field) => !WORKER_RESULT_COMMON_FIELDS.includes(field as (typeof WORKER_RESULT_COMMON_FIELDS)[number])))];
  return [
    "FINAL RESPONSE: return exactly one JSON object matching the supplied WorkerResult schema.",
    ...WORKER_RESULT_VARIANTS.map(variantInstruction),
    `For every non-success outcome include ${fields(nonSuccessRequired)}.`,
    "Do not wrap the JSON in Markdown or add commentary.",
  ].join(" ");
}

export interface WorkerResultSchemaRequest {
  readonly taskId: string;
  readonly attemptId: string;
  readonly correlationId: string;
  readonly workspace: { readonly branch: string };
}

/**
 * Provider-compatible projection. Claude's installed CLI accepts a flat object
 * schema but not a top-level conditional union. Conditional required/forbidden
 * fields remain in the generated description and are authoritatively enforced
 * by validateWorkerResult after the process boundary.
 */
export function buildWorkerResultSchema(request: WorkerResultSchemaRequest): unknown {
  const diagnostic = buildWorkerFailureDiagnosticSchema();
  const baseProperties = {
    kind: { type: "string", const: "worker_result" },
    schemaVersion: { type: "integer", const: WORKER_RESULT_CONTRACT_SCHEMA_VERSION },
    taskId: { type: "string", const: request.taskId },
    attemptId: { type: "string", const: request.attemptId },
    correlationId: { type: "string", const: request.correlationId },
  } as const;
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: [...WORKER_RESULT_COMMON_FIELDS],
    description: workerResultContractInstruction(),
    properties: {
      ...baseProperties,
      outcome: { enum: [...WORKER_RESULT_OUTCOMES] },
      branch: { type: "string", const: request.workspace.branch },
      finalCommit: { type: "string", pattern: "^[0-9a-fA-F]{4,64}$" },
      reason: { type: "string", minLength: 1, maxLength: 1_000 },
      diagnostic,
    },
  });
}
