import assert from "node:assert/strict";
import test from "node:test";

import {
  createTask,
  createWorkerRequest,
  invokeWorker,
  startInitialAttempt,
  validateWorkerRequest,
  validateWorkerResult,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
  type WorkerPort,
  type WorkerRequest,
  type WorkerRequestInput,
} from "../src/index.js";

const t0 = "2026-09-15T10:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-15T10:01:00.000Z" as UtcTimestamp;
const taskId = "worker-contract-task" as TaskId;
const attemptId = "worker-contract-attempt" as AttemptId;

function requestInput(overrides: Partial<WorkerRequestInput> = {}): WorkerRequestInput {
  const created = createTask({
    id: taskId,
    githubReference: { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 115 },
    goal: "Run bounded worker work",
    scope: "provider-independent worker contract",
    acceptanceCriteria: ["validated result"],
    priority: 1,
    risk: "low",
    requiredCapabilities: ["tests.run", "repository.read"],
    createdAt: t0,
  });
  if (!created.ok) throw new Error(created.error.message);
  const started = startInitialAttempt(created.value, [], {
    id: attemptId,
    worker: "worker-1",
    provider: "test-provider",
    branch: "task/worker-contract",
    worktree: "/tmp/pirx-worker-contract",
  }, t1);
  if (!started.ok) throw new Error(started.error.message);
  return {
    task: started.value.task,
    attempt: started.value.attempt,
    workerId: "worker-1",
    provider: "test-provider",
    repository: { owner: "PiotrGry", repository: "ai-assistant" },
    workspace: { branch: "task/worker-contract", worktree: "/tmp/pirx-worker-contract" },
    capabilityGrant: {
      grantedCapabilities: ["tests.run", "repository.read"],
      resourceScope: { repository: "PiotrGry/ai-assistant", branch: "task/worker-contract", worktree: "/tmp/pirx-worker-contract" },
    },
    correlationId: "worker-contract-correlation",
    limits: { timeoutMs: 30_000, maxOutputBytes: 50_000, maxErrorBytes: 10_000 },
    ...overrides,
  };
}

function request(overrides: Partial<WorkerRequestInput> = {}): WorkerRequest {
  const result = createWorkerRequest(requestInput(overrides));
  if (!result.ok) throw new Error(result.violations[0]?.message ?? "invalid request fixture");
  return result.value;
}

function result(requestValue: WorkerRequest, outcome: "CODE_PUSHED" | "BLOCKED" | "FAILED" | "QUOTA_EXHAUSTED" | "CANCELLED" | "UNKNOWN" = "CODE_PUSHED"): Record<string, unknown> {
  return outcome === "CODE_PUSHED"
    ? { kind: "worker_result", schemaVersion: 1, taskId: requestValue.taskId, attemptId: requestValue.attemptId, correlationId: requestValue.correlationId, outcome, branch: requestValue.workspace.branch, finalCommit: "abcdef123456" }
    : { kind: "worker_result", schemaVersion: 1, taskId: requestValue.taskId, attemptId: requestValue.attemptId, correlationId: requestValue.correlationId, outcome, reason: "bounded provider result" };
}

test("creates one immutable provider-independent request bound to Task, Attempt, workspace, and grant", () => {
  const value = request();
  assert.equal(value.kind, "worker_request");
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.taskId, taskId);
  assert.equal(value.attemptId, attemptId);
  assert.deepEqual(value.repository, { owner: "PiotrGry", repository: "ai-assistant" });
  assert.deepEqual(value.workspace, { branch: "task/worker-contract", worktree: "/tmp/pirx-worker-contract" });
  assert.deepEqual(value.capabilityGrant.requiredCapabilities, ["repository.read", "tests.run"]);
  assert.deepEqual(value.capabilityGrant.grantedCapabilities, ["repository.read", "tests.run"]);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.capabilityGrant), true);
  assert.deepEqual(validateWorkerRequest(JSON.parse(JSON.stringify(value))), { ok: true, value });
});

test("rejects identity, repository, workspace, capability, and resume binding mismatches", () => {
  const base = requestInput();
  const cases: Array<[string, WorkerRequestInput]> = [
    ["attempt task", { ...base, attempt: { ...base.attempt, taskId: "other-task" as TaskId } }],
    ["worker", { ...base, workerId: "other-worker" }],
    ["provider", { ...base, provider: "other-provider" }],
    ["branch", { ...base, workspace: { ...base.workspace, branch: "task/other" } }],
    ["worktree", { ...base, workspace: { ...base.workspace, worktree: "/tmp/other" } }],
    ["repository", { ...base, repository: { owner: "Other", repository: "repo" } }],
    ["grant scope", { ...base, capabilityGrant: { ...base.capabilityGrant, resourceScope: { ...base.capabilityGrant.resourceScope, branch: "task/other" } } }],
    ["grant capability", { ...base, capabilityGrant: { ...base.capabilityGrant, grantedCapabilities: ["repository.read"] } }],
    ["resume", { ...base, attempt: { ...base.attempt, checkpointReference: "checkpoint-1" }, resumeContextReference: "checkpoint-2" }],
  ];
  for (const [name, input] of cases) {
    const checked = createWorkerRequest(input);
    assert.equal(checked.ok, false, name);
    if (!checked.ok) assert.equal(checked.violations[0]?.code, "binding_mismatch", name);
  }
});

test("rejects unknown versions, unknown fields, malformed values, and unbounded limits", () => {
  const value = request();
  assert.equal(validateWorkerRequest({ ...value, schemaVersion: 2 }).ok, false);
  assert.equal(validateWorkerRequest({ ...value, unexpected: true }).ok, false);
  assert.equal(validateWorkerRequest({ ...value, limits: { ...value.limits, timeoutMs: 300_001 } }).ok, false);
  assert.equal(validateWorkerRequest({ ...value, capabilityGrant: { ...value.capabilityGrant, grantedCapabilities: [] } }).ok, false);
  assert.equal(createWorkerRequest({ ...requestInput(), limits: { timeoutMs: 1, maxOutputBytes: 1, maxErrorBytes: 1 } }).ok, true);
});

test("validates every terminal result variant and only allows result evidence for that variant", () => {
  const value = request();
  for (const outcome of ["CODE_PUSHED", "BLOCKED", "FAILED", "QUOTA_EXHAUSTED", "CANCELLED", "UNKNOWN"] as const) {
    const checked = validateWorkerResult(result(value, outcome), value);
    assert.equal(checked.ok, true, outcome);
  }
  assert.equal(validateWorkerResult({ ...result(value), finalCommit: "" }, value).ok, false);
  assert.equal(validateWorkerResult({ ...result(value, "FAILED"), branch: value.workspace.branch }, value).ok, false);
  assert.equal(validateWorkerResult({ ...result(value), branch: "other-branch" }, value).ok, false);
  assert.equal(validateWorkerResult({ ...result(value), taskId: "other-task" }, value).ok, false);
  assert.equal(validateWorkerResult({ ...result(value), extra: true }, value).ok, false);
});

test("invokes a fake provider-independent adapter once only after validation", async () => {
  const value = request();
  let calls = 0;
  const adapter: WorkerPort = {
    async execute(input, signal) {
      calls += 1;
      assert.equal(input.provider, "test-provider");
      assert.equal(signal.aborted, false);
      return result(input) as never;
    },
  };
  const accepted = await invokeWorker(adapter, value, new AbortController().signal);
  assert.equal(accepted.ok, true);
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  const cancelled = await invokeWorker(adapter, value, controller.signal);
  assert.equal(cancelled.ok, false);
  assert.equal(calls, 1);
});
