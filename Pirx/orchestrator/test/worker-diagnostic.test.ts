import assert from "node:assert/strict";
import test from "node:test";
import { adoptWorkerAuthoredDiagnostic, createWorkerFailureDiagnostic, validateWorkerFailureDiagnostic } from "../src/runtime/worker-diagnostic.js";

test("provider evidence survives persistence with bounded redacted text", () => {
  const diagnostic = createWorkerFailureDiagnostic("process_failure", { providerMessage: "error_max_turns: Bearer private-value token=private-value " + "x".repeat(3000) });
  assert.equal(diagnostic.providerMessage?.length, 2048);
  assert.ok(!diagnostic.providerMessage?.includes("private-value"));
  assert.equal(validateWorkerFailureDiagnostic(JSON.parse(JSON.stringify(diagnostic)))?.providerMessage, diagnostic.providerMessage);
  assert.equal(validateWorkerFailureDiagnostic({ ...diagnostic, providerMessage: "x".repeat(2049) }), undefined);
});

test("input diagnostics retain bounded field and violation code without exporting unsafe values", () => {
  const value = createWorkerFailureDiagnostic("binding_mismatch", { stage: "worker_contract", field: "resumeContext", violationCode: "stale_checkpoint" });
  assert.equal(validateWorkerFailureDiagnostic(value)?.violationCode, "stale_checkpoint");
  assert.equal(createWorkerFailureDiagnostic("binding_mismatch", { violationCode: "unsafe value with spaces" }).violationCode, undefined);
  assert.equal(validateWorkerFailureDiagnostic({ ...value, violationCode: "unsafe value with spaces" }), undefined);
});


test("redacts secret values in JSON evidence before persistence", () => {
  for (const providerMessage of [
    JSON.stringify({ error: { password: "fixture-password", api_key: "fixture-key", message: "useful error code" } }),
    'provider returned {"password":"fixture-password","message":"useful error code"}',
  ]) {
    const diagnostic = createWorkerFailureDiagnostic("process_failure", { providerMessage });
    assert.ok(!JSON.stringify(diagnostic).includes("fixture-password"));
    assert.ok(!JSON.stringify(diagnostic).includes("fixture-key"));
    assert.match(diagnostic.providerMessage ?? "", /useful error code/);
  }
});

test("diagnostics already persisted in runtime storage stay readable", () => {
  // Exact record of Attempt 5 of zdrovena#462; rewording a message breaks history reads.
  const stored = { schemaVersion: 1, code: "timeout", message: "Worker process exceeded its bounded time limit.", correlationId: "gh-462:attempt:5", durationMs: 120272, stage: "process" };
  assert.notEqual(validateWorkerFailureDiagnostic(stored), undefined);
  for (const code of ["process_failure", "binding_mismatch", "quota_exhausted"] as const) {
    assert.notEqual(validateWorkerFailureDiagnostic(JSON.parse(JSON.stringify(createWorkerFailureDiagnostic(code)))), undefined, code);
  }
});

test("observedCommit survives persistence only as a full SHA", () => {
  const pirx = createWorkerFailureDiagnostic("push_rejected", { stage: "git_state", observedCommit: "a".repeat(40) });
  assert.equal(validateWorkerFailureDiagnostic(JSON.parse(JSON.stringify(pirx)))?.observedCommit, "a".repeat(40));
  assert.equal(validateWorkerFailureDiagnostic(adoptWorkerAuthoredDiagnostic(pirx))?.observedCommit, "a".repeat(40));
  assert.equal(createWorkerFailureDiagnostic("push_rejected", { observedCommit: "abc" }).observedCommit, undefined);
  assert.equal(validateWorkerFailureDiagnostic({ ...pirx, observedCommit: "abc" }), undefined);
});
