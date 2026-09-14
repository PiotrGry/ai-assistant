import assert from "node:assert/strict";
import test from "node:test";

import {
  CapabilityEnforcementGate,
  enforceMutatingToolInvocation,
  enforceWorkerInvocation,
  type CapabilityAuditDecision,
  type CapabilityAuditSink,
  type CapabilityGateRequest,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const taskId = "gate-task-1" as TaskId;
const now = "2026-09-14T20:00:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const branch = "task/capability-gate";
const worktree = "/tmp/pirx-capability-gate";

class FakeAudit implements CapabilityAuditSink {
  readonly decisions: CapabilityAuditDecision[] = [];
  throwOnRecord = false;
  abortOnRecord?: AbortController;

  record(decision: CapabilityAuditDecision): void {
    if (this.throwOnRecord) throw new Error("audit unavailable");
    this.decisions.push(decision);
    this.abortOnRecord?.abort();
  }
}

function request(overrides: Partial<CapabilityGateRequest> = {}): CapabilityGateRequest {
  return {
    taskId,
    workerId: "worker-1",
    grantTaskId: taskId,
    grantWorkerId: "worker-1",
    action: "repository.read",
    requiredCapabilities: ["repository.read"],
    workerGrants: ["repository.read"],
    repository,
    assignedBranch: branch,
    assignedWorktree: worktree,
    resourceScope: { repository, branch, worktree },
    correlationId: "corr-1",
    evaluatedAt: now,
    ...overrides,
  };
}

test("allows one invocation and emits a structured allow audit", async () => {
  const audit = new FakeAudit();
  const gate = new CapabilityEnforcementGate(audit);
  let invocations = 0;
  const result = await gate.execute(request(), () => {
    invocations += 1;
    return "ok";
  });

  assert.equal(result.outcome, "allowed");
  if (result.outcome === "allowed") assert.equal(result.value, "ok");
  assert.equal(invocations, 1);
  assert.deepEqual(audit.decisions[0], {
    taskId,
    workerId: "worker-1",
    correlationId: "corr-1",
    action: "repository.read",
    outcome: "allowed",
    reasonCode: "ALLOWED",
    evaluatedAt: now,
    requiredCapabilities: ["repository.read"],
    grantedCapabilities: ["repository.read"],
    matchedCapabilities: ["repository.read"],
    missingCapabilities: [],
    sensitiveRequirements: [],
    resourceScope: { repository, branch, worktree },
  });
});

test("fails closed for missing grants, unknown capabilities, binding, and scope mismatches", async () => {
  for (const overrides of [
    { workerGrants: [] },
    { requiredCapabilities: ["network.admin"] },
    { grantTaskId: "other-task-1" as TaskId },
    { grantWorkerId: "worker-2" },
    { resourceScope: { repository, branch: "task/other", worktree } },
    { resourceScope: { repository, branch, worktree: "/tmp/other" } },
    { resourceScope: { repository, branch } },
  ]) {
    const audit = new FakeAudit();
    const gate = new CapabilityEnforcementGate(audit);
    let invocations = 0;
    const result = await gate.execute(request(overrides), () => {
      invocations += 1;
      return "must-not-run";
    });
    assert.notEqual(result.outcome, "allowed");
    assert.equal(invocations, 0);
    assert.equal(audit.decisions.length, 1);
    assert.equal(audit.decisions[0]?.outcome, "denied");
  }
});

test("requires approval for sensitive actions and preserves bounded redacted audit data", async () => {
  const audit = new FakeAudit();
  const gate = new CapabilityEnforcementGate(audit);
  const result = await gate.execute(request({
    action: "production.read",
    requiredCapabilities: ["production.read"],
    workerGrants: ["production.read"],
    approvals: [{
      approvalId: "approval-1",
      taskId,
      capability: "production.read",
      resourceScope: { repository, branch, worktree },
      approver: "human@example.test",
      issuedAt: "2026-09-14T19:00:00.000Z",
      expiresAt: "2026-09-14T21:00:00.000Z",
      oneUse: true,
      state: "active",
    }],
  }), () => "read-only");

  assert.equal(result.outcome, "allowed");
  assert.equal(audit.decisions[0]?.approvalReference, "approval-1");
  const serialized = JSON.stringify(audit.decisions[0]);
  assert.ok(serialized.length < 2_000);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("full prompt"), false);
});

test("does not invoke after cancellation, on audit failure, or when downstream throws", async () => {
  const cancelledAudit = new FakeAudit();
  const cancelledController = new AbortController();
  cancelledController.abort();
  let cancelledInvocations = 0;
  const cancelled = await new CapabilityEnforcementGate(cancelledAudit).execute(request({ signal: cancelledController.signal }), () => {
    cancelledInvocations += 1;
  });
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelledInvocations, 0);
  assert.equal(cancelledAudit.decisions[0]?.reasonCode, "CANCELLED");

  const failingAudit = new FakeAudit();
  failingAudit.throwOnRecord = true;
  let auditFailureInvocations = 0;
  const auditFailure = await new CapabilityEnforcementGate(failingAudit).execute(request(), () => {
    auditFailureInvocations += 1;
  });
  assert.equal(auditFailure.outcome, "denied");
  assert.equal(auditFailure.decision.reasonCode, "AUDIT_FAILURE");
  assert.equal(auditFailureInvocations, 0);

  const postAuditAudit = new FakeAudit();
  const postAuditController = new AbortController();
  postAuditAudit.abortOnRecord = postAuditController;
  let postAuditInvocations = 0;
  const postAudit = await new CapabilityEnforcementGate(postAuditAudit).execute(request({ signal: postAuditController.signal }), () => {
    postAuditInvocations += 1;
  });
  assert.equal(postAudit.outcome, "cancelled");
  assert.equal(postAuditInvocations, 0);

  const thrown = await new CapabilityEnforcementGate(new FakeAudit()).execute(request(), () => {
    throw new Error("provider failure");
  });
  assert.equal(thrown.outcome, "failed");
  assert.equal(thrown.decision.outcome, "allowed");
  assert.equal(thrown.decision.reasonCode, "INVOCATION_ERROR");
});

test("requires all composite capabilities and exposes worker/tool enforcement helpers", async () => {
  const audit = new FakeAudit();
  const gate = new CapabilityEnforcementGate(audit);
  let invocations = 0;
  const composite = await gate.execute(request({
    requiredCapabilities: ["repository.read", "tests.run"],
    workerGrants: ["repository.read"],
  }), () => {
    invocations += 1;
  });
  assert.equal(composite.outcome, "denied");
  assert.equal(invocations, 0);
  assert.deepEqual(composite.decision.missingCapabilities, ["tests.run"]);

  const worker = await enforceWorkerInvocation(gate, request({ action: "ignored", requiredCapabilities: ["repository.read"] }), () => "worker");
  assert.equal(worker.outcome, "allowed");
  assert.equal(worker.decision.action, "worker.start");
  const tool = await enforceMutatingToolInvocation(gate, request(), "repository.write", () => "tool");
  assert.equal(tool.outcome, "allowed");
  assert.equal(tool.decision.action, "repository.write");
});
