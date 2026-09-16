import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKER_RESULT_COMMON_FIELDS,
  WORKER_RESULT_VARIANTS,
  buildCanonicalWorkerResultSchema,
  createWorkerFailureDiagnostic,
  validateWorkerResult,
  workerResultContractInstruction,
  type WorkerRequest,
} from "../src/index.js";

const request = {
  taskId: "contract-task",
  attemptId: "contract-attempt",
  correlationId: "contract-correlation",
  workspace: { branch: "pirx/contract" },
} as Pick<WorkerRequest, "taskId" | "attemptId" | "correlationId" | "workspace">;

function fixture(outcome: (typeof WORKER_RESULT_VARIANTS)[number]["outcome"]): Record<string, unknown> {
  const base = {
    kind: "worker_result",
    schemaVersion: 1,
    taskId: request.taskId,
    attemptId: request.attemptId,
    correlationId: request.correlationId,
    outcome,
  };
  return outcome === "CODE_PUSHED"
    ? { ...base, branch: request.workspace.branch, finalCommit: "0123456789abcdef0123456789abcdef01234567" }
    : { ...base, reason: "bounded worker outcome", diagnostic: createWorkerFailureDiagnostic("timeout", { durationMs: 12 }) };
}

test("canonical WorkerResult matrix accepts every real variant and preserves diagnostic semantics", () => {
  for (const variant of WORKER_RESULT_VARIANTS) {
    const value = fixture(variant.outcome);
    const checked = validateWorkerResult(value, request);
    assert.equal(checked.ok, true, variant.outcome);
    for (const field of variant.required) assert.equal(field in value, true, `${variant.outcome} requires ${field}`);
    for (const field of variant.forbidden) assert.equal(field in value, false, `${variant.outcome} forbids ${field}`);
  }
  assert.equal(validateWorkerResult({ ...fixture("CODE_PUSHED"), branch: null }, request).ok, false);
  assert.equal(validateWorkerResult({ ...fixture("FAILED"), diagnostic: null }, request).ok, false);
  assert.equal(validateWorkerResult({ ...fixture("FAILED"), extra: true }, request).ok, false);
});

test("CLI projection is deterministically derived without unsupported conditional schema combinators", () => {
  const schema = buildCanonicalWorkerResultSchema(request) as {
    readonly required: readonly string[];
    readonly properties: Record<string, unknown>;
    readonly description: string;
    readonly oneOf?: unknown;
    readonly anyOf?: unknown;
  };
  assert.deepEqual(schema.required, [...WORKER_RESULT_COMMON_FIELDS]);
  assert.equal(schema.oneOf, undefined);
  assert.equal(schema.anyOf, undefined);
  for (const variant of WORKER_RESULT_VARIANTS) {
    for (const field of variant.required) {
      assert.equal(field in schema.properties, true, `${variant.outcome} field ${field} is projected`);
      assert.equal(schema.description.includes(field), true, `${variant.outcome} field ${field} is documented`);
    }
    for (const field of variant.forbidden) assert.equal(schema.description.includes(field), true, `${variant.outcome} forbidden field ${field} is documented`);
  }
  assert.equal(workerResultContractInstruction(), schema.description);
});

test("canonical validation rejects success without pushed evidence and never accepts free-form text", () => {
  const success = fixture("CODE_PUSHED");
  assert.equal(validateWorkerResult({ ...success, finalCommit: undefined }, request).ok, false);
  assert.equal(validateWorkerResult({ ...success, branch: undefined }, request).ok, false);
  assert.equal(validateWorkerResult({ ...success, trailingText: "```json```" }, request).ok, false);
  assert.equal(validateWorkerResult("CODE_PUSHED", request).ok, false);
});
