import assert from "node:assert/strict";
import test from "node:test";

import {
  CapabilityAwareWorkerExecutionPort,
  CapabilityEnforcementGate,
  createTask,
  createWorkerRequest,
  invokeWorker,
  startInitialAttempt,
  type AttemptId,
  type CapabilityAuditDecision,
  type TaskId,
  type UtcTimestamp,
  type WorkerPort,
  type WorkerRequest,
  type WorkerResult,
} from "../src/index.js";

export type WorkerAdapterContractScenario = "CODE_PUSHED" | "BLOCKED" | "FAILED" | "QUOTA_EXHAUSTED" | "CANCELLED" | "UNKNOWN" | "wrong_identity" | "wrong_branch" | "malformed" | "oversized" | "throw" | "secret";

export interface WorkerAdapterContractFactory {
  create(scenario: WorkerAdapterContractScenario): WorkerPort;
  invocationCount(): number;
}

export interface WorkerAdapterContractSuiteOptions {
  readonly name: string;
  readonly factory: () => WorkerAdapterContractFactory;
  readonly normalizesInvalidResults?: boolean;
}

const taskId = "adapter-contract-task" as TaskId;
const attemptId = "adapter-contract-attempt" as AttemptId;
const now = "2026-09-15T12:00:00.000Z" as UtcTimestamp;

function request(): WorkerRequest {
  const task = createTask({ id: taskId, goal: "Run adapter conformance", scope: "generic worker", acceptanceCriteria: ["contract"], priority: 1, risk: "low", requiredCapabilities: ["repository.read", "tests.run"], createdAt: now });
  if (!task.ok) throw new Error(task.error.message);
  const started = startInitialAttempt(task.value, [], { id: attemptId, worker: "contract-worker", provider: "contract-provider", branch: "pirx/adapter-contract", worktree: "/tmp/pirx-adapter-contract" }, now);
  if (!started.ok) throw new Error(started.error.message);
  const value = createWorkerRequest({
    task: started.value.task,
    attempt: started.value.attempt,
    workerId: "contract-worker",
    provider: "contract-provider",
    repository: { owner: "PiotrGry", repository: "ai-assistant" },
    workspace: { branch: "pirx/adapter-contract", worktree: "/tmp/pirx-adapter-contract" },
    capabilityGrant: { grantedCapabilities: ["repository.read", "tests.run"], resourceScope: { repository: "PiotrGry/ai-assistant", branch: "pirx/adapter-contract", worktree: "/tmp/pirx-adapter-contract" } },
    correlationId: "adapter-contract-correlation",
    limits: { timeoutMs: 30_000, maxOutputBytes: 10_000, maxErrorBytes: 10_000 },
  });
  if (!value.ok) throw new Error(value.violations[0]?.message ?? "invalid contract fixture");
  return value.value;
}

function validResult(value: WorkerRequest, scenario: WorkerAdapterContractScenario): unknown {
  if (scenario === "CODE_PUSHED") return { kind: "worker_result", schemaVersion: 1, taskId: value.taskId, attemptId: value.attemptId, correlationId: value.correlationId, outcome: scenario, branch: value.workspace.branch, finalCommit: "dddddddddddddddddddddddddddddddddddddddd" };
  if (["BLOCKED", "FAILED", "QUOTA_EXHAUSTED", "CANCELLED", "UNKNOWN"].includes(scenario)) return { kind: "worker_result", schemaVersion: 1, taskId: value.taskId, attemptId: value.attemptId, correlationId: value.correlationId, outcome: scenario, reason: "bounded adapter result" };
  if (scenario === "wrong_identity") return { kind: "worker_result", schemaVersion: 1, taskId: "other-task", attemptId: value.attemptId, correlationId: value.correlationId, outcome: "BLOCKED", reason: "wrong identity" };
  if (scenario === "wrong_branch") return { kind: "worker_result", schemaVersion: 1, taskId: value.taskId, attemptId: value.attemptId, correlationId: value.correlationId, outcome: "CODE_PUSHED", branch: "other-branch", finalCommit: "dddddddddddddddddddddddddddddddddddddddd" };
  if (scenario === "oversized") return { kind: "worker_result", schemaVersion: 1, taskId: value.taskId, attemptId: value.attemptId, correlationId: value.correlationId, outcome: "FAILED", reason: "x".repeat(1_001) };
  if (scenario === "secret") return { kind: "worker_result", schemaVersion: 1, taskId: value.taskId, attemptId: value.attemptId, correlationId: value.correlationId, outcome: "FAILED", reason: "token=contract-secret" };
  return { raw: "provider payload" };
}

class Audit {
  readonly decisions: CapabilityAuditDecision[] = [];
  record(decision: CapabilityAuditDecision): void { this.decisions.push(decision); }
}

export function registerWorkerAdapterContractSuite(options: WorkerAdapterContractSuiteOptions): void {
  test(`${options.name}: preserves every normalized terminal result`, async () => {
    const value = request();
    const factory = options.factory();
    for (const scenario of ["CODE_PUSHED", "BLOCKED", "FAILED", "QUOTA_EXHAUSTED", "CANCELLED", "UNKNOWN"] as const) {
      const adapter = factory.create(scenario);
      const result = await invokeWorker(adapter, value, new AbortController().signal);
      assert.equal(result.ok, true, scenario);
    }
    assert.equal(factory.invocationCount(), 6);
  });

  test(`${options.name}: rejects binding conflicts, malformed and oversized results`, async () => {
    const value = request();
    const factory = options.factory();
    for (const scenario of ["wrong_identity", "wrong_branch", "malformed", "oversized"] as const) {
      const result = await invokeWorker(factory.create(scenario), value, new AbortController().signal);
      assert.equal(result.ok, options.normalizesInvalidResults === true, scenario);
      if (options.normalizesInvalidResults === true && result.ok) assert.equal(result.value.outcome, scenario === "wrong_identity" || scenario === "wrong_branch" ? "BLOCKED" : "FAILED", scenario);
    }
    assert.equal(JSON.stringify(await invokeWorker(factory.create("malformed"), value, new AbortController().signal)).includes("provider payload"), false);
    assert.equal(factory.invocationCount(), 5);
  });

  test(`${options.name}: normalizes thrown adapters and cancellation`, async () => {
    const value = request();
    const factory = options.factory();
    const thrown = await invokeWorker(factory.create("throw"), value, new AbortController().signal);
    assert.equal(thrown.ok, true);
    if (thrown.ok) assert.equal("diagnostic" in thrown.value ? thrown.value.diagnostic.code : undefined, "adapter_failure");
    const controller = new AbortController(); controller.abort();
    const cancelled = await invokeWorker(factory.create("CODE_PUSHED"), value, controller.signal);
    assert.equal(cancelled.ok, false);
    assert.equal(factory.invocationCount(), 1);
  });

  test(`${options.name}: capability boundary allows exactly once and denies before invocation`, async () => {
    const value = request();
    const factory = options.factory();
    const audit = new Audit();
    const allowed = new CapabilityAwareWorkerExecutionPort(new CapabilityEnforcementGate(audit), { get: () => factory.create("CODE_PUSHED") }, { now: () => now });
    const accepted = await allowed.execute(value, new AbortController().signal);
    assert.equal(accepted.outcome, "allowed");
    assert.equal(factory.invocationCount(), 1);
    const deniedValue = { ...value, capabilityGrant: { ...value.capabilityGrant, requiredCapabilities: ["unknown.capability"], grantedCapabilities: ["unknown.capability"] } };
    const denied = await allowed.execute(deniedValue, new AbortController().signal);
    assert.equal(denied.outcome, "denied");
    assert.equal(factory.invocationCount(), 1);
  });

  test(`${options.name}: rejects secret-bearing normalized evidence at the boundary`, async () => {
    const value = request();
    const factory = options.factory();
    const port = new CapabilityAwareWorkerExecutionPort(new CapabilityEnforcementGate(new Audit()), { get: () => factory.create("secret") }, { now: () => now });
    const result = await port.execute(value, new AbortController().signal);
    assert.ok(result.outcome === "invalid_result" || result.outcome === "adapter_failure");
    assert.equal(JSON.stringify(result).includes("contract-secret"), false);
  });
}

export { validResult };
