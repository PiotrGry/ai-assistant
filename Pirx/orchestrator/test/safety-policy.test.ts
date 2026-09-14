import assert from "node:assert/strict";
import test from "node:test";

import {
  CapabilityEnforcementGate,
  SAFETY_POLICY_MATRIX,
  SafetyEnforcementGate,
  evaluateSafetyPolicy,
  type CapabilityAuditDecision,
  type SafetyInvocationRequest,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const taskId = "safety-task-1" as TaskId;
const now = "2026-09-14T20:00:00.000Z" as UtcTimestamp;
const scope = { repository: "PiotrGry/ai-assistant", branch: "task/safety", worktree: "/tmp/pirx-safety" };

class AuditSink {
  readonly decisions: CapabilityAuditDecision[] = [];
  record(decision: CapabilityAuditDecision): void {
    this.decisions.push(decision);
  }
}

function request(action: unknown, overrides: Partial<SafetyInvocationRequest> = {}): SafetyInvocationRequest {
  return {
    taskId,
    workerId: "worker-1",
    grantTaskId: taskId,
    grantWorkerId: "worker-1",
    workerGrants: ["production.read"],
    repository: scope.repository,
    assignedBranch: scope.branch,
    assignedWorktree: scope.worktree,
    resourceScope: scope,
    correlationId: "safety-correlation-1",
    evaluatedAt: now,
    requestedAction: action,
    ...overrides,
  };
}

function productionApproval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approvalId: "safety-approval-1",
    taskId,
    capability: "production.read",
    resourceScope: scope,
    approver: "human@example.test",
    issuedAt: "2026-09-14T19:00:00.000Z",
    expiresAt: "2026-09-14T21:00:00.000Z",
    oneUse: true,
    state: "active",
    ...overrides,
  };
}

test("publishes a complete deterministic policy matrix", () => {
  assert.equal(SAFETY_POLICY_MATRIX.length, 15);
  for (const row of SAFETY_POLICY_MATRIX) {
    const result = evaluateSafetyPolicy({ taskId, requestedAction: row.action, resourceScope: scope, evaluatedAt: now });
    if (row.decision === "allow_with_gate") {
      assert.equal(result.outcome, "allowed");
      if (result.outcome === "allowed") assert.equal(result.capability, row.capability);
    } else {
      assert.equal(result.outcome, "human_action_required");
      if (result.outcome === "human_action_required") assert.equal(result.humanAction.reasonCode, "UNSUPPORTED_ACTION");
    }
  }
});

test("fails closed for unknown, ambiguous, and missing-scope requests", () => {
  const unknown = evaluateSafetyPolicy({ taskId, requestedAction: "deploy secret production", resourceScope: scope, evaluatedAt: now });
  assert.equal(unknown.outcome, "denied");
  if (unknown.outcome === "denied") assert.equal(unknown.reasonCode, "UNKNOWN_ACTION");

  const ambiguous = evaluateSafetyPolicy({ taskId, requestedAction: "production.read-and-write", resourceScope: scope, evaluatedAt: now });
  assert.equal(ambiguous.outcome, "denied");
  if (ambiguous.outcome === "denied") assert.equal(ambiguous.reasonCode, "AMBIGUOUS_ACTION");

  const missingScope = evaluateSafetyPolicy({ taskId, requestedAction: "production.read", resourceScope: { repository: scope.repository, branch: scope.branch }, evaluatedAt: now });
  assert.equal(missingScope.outcome, "denied");
  if (missingScope.outcome === "denied") {
    assert.equal(missingScope.reasonCode, "MISSING_SCOPE");
    assert.equal(missingScope.humanAction.requiredCapability, "production.read");
  }
});

test("allows only explicitly granted and approved read-only production inspection", async () => {
  const audit = new AuditSink();
  const gate = new SafetyEnforcementGate(new CapabilityEnforcementGate(audit));
  let invocations = 0;
  const result = await gate.execute(request("production.read", { approvals: [productionApproval()] }), () => {
    invocations += 1;
    return "inspection";
  });
  assert.equal(result.outcome, "allowed");
  if (result.outcome === "allowed") assert.equal(result.value, "inspection");
  assert.equal(invocations, 1);

  const noApproval = await gate.execute(request("production.read"), () => {
    invocations += 1;
  });
  assert.equal(noApproval.outcome, "denied");
  if (noApproval.outcome === "denied") assert.equal(noApproval.humanAction.reasonCode, "SENSITIVE_APPROVAL_REQUIRED");
  assert.equal(invocations, 1);

  const noGrant = await gate.execute(request("production.read", { workerGrants: [] }), () => {
    invocations += 1;
  });
  assert.equal(noGrant.outcome, "denied");
  if (noGrant.outcome === "denied") assert.equal(noGrant.humanAction.reasonCode, "MISSING_GRANT");
  assert.equal(invocations, 1);

  const expired = await gate.execute(request("production.read", { approvals: [productionApproval({ expiresAt: "2026-09-14T19:30:00.000Z" })] }), () => {
    invocations += 1;
  });
  assert.equal(expired.outcome, "denied");
  if (expired.outcome === "denied") assert.equal(expired.humanAction.reasonCode, "EXPIRED_APPROVAL");
  assert.equal(invocations, 1);

  for (const overrides of [
    { grantTaskId: "other-task" as TaskId },
    { grantWorkerId: "other-worker" },
    { resourceScope: { ...scope, repository: "other/repository" } },
    { resourceScope: { ...scope, worktree: "/tmp/other" } },
  ]) {
    const denied = await gate.execute(request("production.read", { ...overrides, approvals: [productionApproval()] }), () => {
      invocations += 1;
    });
    assert.equal(denied.outcome, "denied");
    assert.equal(invocations, 1);
  }
});

test("denies every sensitive mutation without an external invocation and surfaces human action", async () => {
  const audit = new AuditSink();
  const gate = new SafetyEnforcementGate(new CapabilityEnforcementGate(audit));
  let invocations = 0;
  for (const row of SAFETY_POLICY_MATRIX.filter((item) => item.class === "write")) {
    const result = await gate.execute(request(row.action), () => {
      invocations += 1;
    });
    assert.equal(result.outcome, "human_action_required");
    if (result.outcome === "human_action_required") {
      assert.equal(result.humanAction.reasonCode, "UNSUPPORTED_ACTION");
      assert.equal(result.humanAction.requestedAction, row.action);
      assert.ok(result.humanAction.nextInstruction.length <= 160);
    }
  }
  assert.equal(invocations, 0);
  assert.equal(audit.decisions.length, 0);
});

test("sanitizes human action records and keeps gate failures actionable", async () => {
  const unknown = evaluateSafetyPolicy({ taskId, requestedAction: "production.write super-secret-command", resourceScope: { repository: "PiotrGry/ai-assistant", branch: "task/safety", worktree: "/tmp/safety", token: "super-secret" }, evaluatedAt: now });
  assert.equal(unknown.outcome, "denied");
  if (unknown.outcome === "denied") {
    const serialized = JSON.stringify(unknown.humanAction);
    assert.equal(unknown.humanAction.requestedAction, "unknown");
    assert.equal(serialized.includes("super-secret"), false);
    assert.ok(serialized.length < 1_000);
  }

  const audit = new AuditSink();
  const gate = new SafetyEnforcementGate(new CapabilityEnforcementGate(audit));
  const malformedScope = await gate.execute(request("metrics.read", { resourceScope: { repository: scope.repository, branch: scope.branch } }), () => {
    throw new Error("must not run");
  });
  assert.equal(malformedScope.outcome, "denied");
  if (malformedScope.outcome === "denied") assert.equal(malformedScope.humanAction.reasonCode, "MISSING_SCOPE");
});
