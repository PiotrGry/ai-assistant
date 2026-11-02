import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerFailureDiagnostic, validateWorkerFailureDiagnostic } from "../src/runtime/worker-diagnostic.js";

test("input diagnostics retain bounded field and violation code without exporting unsafe values", () => {
  const value = createWorkerFailureDiagnostic("binding_mismatch", { stage: "worker_contract", field: "resumeContext", violationCode: "stale_checkpoint" });
  assert.equal(validateWorkerFailureDiagnostic(value)?.violationCode, "stale_checkpoint");
  assert.equal(createWorkerFailureDiagnostic("binding_mismatch", { violationCode: "unsafe value with spaces" }).violationCode, undefined);
  assert.equal(validateWorkerFailureDiagnostic({ ...value, violationCode: "unsafe value with spaces" }), undefined);
});
