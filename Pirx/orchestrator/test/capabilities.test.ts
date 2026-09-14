import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_VOCABULARY,
  evaluateCapabilities,
  normalizeCapabilitySet,
  validateCapabilityApproval,
  type CapabilityEvaluationInput,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const taskId = "capability-task-1" as TaskId;
const t0 = "2026-09-14T20:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T20:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-14T20:02:00.000Z" as UtcTimestamp;
const t3 = "2026-09-14T20:03:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const scope = { repository, environment: "production" };

function evaluation(overrides: Partial<CapabilityEvaluationInput> = {}): CapabilityEvaluationInput {
  return {
    taskId,
    requiredCapabilities: ["repository.read"],
    workerGrants: ["repository.read"],
    repository,
    assignedBranch: "task/capabilities",
    resourceScope: { repository, branch: "task/capabilities" },
    now: t1,
    ...overrides,
  };
}

function approval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalId: "approval-1",
    taskId,
    capability: "production.read",
    resourceScope: scope,
    approver: "human@example.test",
    issuedAt: t0,
    expiresAt: t2,
    oneUse: true,
    state: "active",
    ...overrides,
  };
}

test("normalizes the closed vocabulary deterministically and rejects unknown values", () => {
  const normalized = normalizeCapabilitySet(["tests.run", "repository.read", "tests.run", "git.commit"]);
  assert.deepEqual(normalized, { ok: true, value: ["git.commit", "repository.read", "tests.run"] });
  assert.deepEqual(normalizeCapabilitySet([]), { ok: true, value: [] });
  const unknown = normalizeCapabilitySet(["repository.read", "network.admin"]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.violations[0]?.code, "unknown_capability");
  assert.deepEqual(CAPABILITY_VOCABULARY, ["repository.read", "repository.write", "tests.run", "git.commit", "git.push_assigned_branch", "ci.read", "ci.logs.read", "application_logs.read", "metrics.read", "production.read"]);
});

test("allows normal code-worker grants and applies deny-by-default set comparison", () => {
  const normal = evaluateCapabilities(evaluation({
    requiredCapabilities: ["git.push_assigned_branch", "repository.write", "tests.run", "git.commit", "repository.read"],
    workerGrants: ["tests.run", "repository.read", "git.commit", "repository.write", "git.push_assigned_branch"],
  }));
  assert.equal(normal.outcome, "allowed");
  assert.equal(normal.reasonCode, "ALLOWED");
  assert.deepEqual(normal.missingCapabilities, []);

  const missing = evaluateCapabilities(evaluation({ requiredCapabilities: ["repository.write", "tests.run"], workerGrants: ["tests.run"] }));
  assert.equal(missing.outcome, "denied");
  assert.equal(missing.reasonCode, "MISSING_GRANT");
  assert.deepEqual(missing.missingCapabilities, ["repository.write"]);
});

test("enforces assigned branch, scope, and malformed input rules", () => {
  const noBranch = evaluateCapabilities(evaluation({ requiredCapabilities: ["git.push_assigned_branch"], workerGrants: ["git.push_assigned_branch"], assignedBranch: undefined }));
  assert.equal(noBranch.reasonCode, "ASSIGNED_BRANCH_REQUIRED");
  const mismatch = evaluateCapabilities(evaluation({ requiredCapabilities: ["git.push_assigned_branch"], workerGrants: ["git.push_assigned_branch"], resourceScope: { repository, branch: "task/other" } }));
  assert.equal(mismatch.reasonCode, "ASSIGNED_BRANCH_MISMATCH");
  const crossRepository = evaluateCapabilities(evaluation({ resourceScope: { repository: "other/repository", branch: "task/capabilities" } }));
  assert.equal(crossRepository.reasonCode, "RESOURCE_SCOPE_MISMATCH");
  const emptyScope = evaluateCapabilities(evaluation({ resourceScope: {} }));
  assert.equal(emptyScope.reasonCode, "INVALID_RESOURCE_SCOPE");
  const unknownGrant = evaluateCapabilities(evaluation({ workerGrants: ["repository.read", "unknown.capability"] }));
  assert.equal(unknownGrant.reasonCode, "UNKNOWN_CAPABILITY");
});

test("requires valid sensitive approvals and reports stable approval reasons", () => {
  const required = evaluateCapabilities(evaluation({ requiredCapabilities: ["production.read"], workerGrants: ["production.read"], resourceScope: scope }));
  assert.equal(required.reasonCode, "SENSITIVE_APPROVAL_REQUIRED");
  assert.deepEqual(required.sensitiveRequirements, ["production.read"]);
  assert.equal(required.approvalRequirement?.capability, "production.read");

  const valid = evaluateCapabilities(evaluation({ requiredCapabilities: ["production.read"], workerGrants: ["production.read"], resourceScope: scope, approvals: [approval()] }));
  assert.equal(valid.outcome, "allowed");

  for (const [overrides, reason] of [
    [{ expiresAt: t1 }, "EXPIRED_APPROVAL"],
    [{ state: "revoked" }, "REVOKED_APPROVAL"],
    [{ state: "used" }, "USED_APPROVAL"],
    [{ taskId: "another-task" }, "WRONG_TASK_APPROVAL"],
    [{ resourceScope: { repository: "other/repository", environment: "production" } }, "APPROVAL_SCOPE_MISMATCH"],
  ] as const) {
    const result = evaluateCapabilities(evaluation({ requiredCapabilities: ["production.read"], workerGrants: ["production.read"], resourceScope: scope, approvals: [approval(overrides)] }));
    assert.equal(result.reasonCode, reason);
  }
});

test("validates approval contracts and rejects future-issued approvals", () => {
  const valid = validateCapabilityApproval(approval());
  assert.equal(valid.ok, true);
  const malformed = validateCapabilityApproval({ ...approval(), resourceScope: {} });
  assert.equal(malformed.ok, false);
  const reversed = validateCapabilityApproval({ ...approval(), issuedAt: t2, expiresAt: t1 });
  assert.equal(reversed.ok, false);
  const future = evaluateCapabilities(evaluation({ requiredCapabilities: ["production.read"], workerGrants: ["production.read"], resourceScope: scope, approvals: [approval({ issuedAt: t2, expiresAt: t3 })] }));
  assert.equal(future.reasonCode, "SENSITIVE_APPROVAL_REQUIRED");
  assert.equal(t3 > t2, true);
});
