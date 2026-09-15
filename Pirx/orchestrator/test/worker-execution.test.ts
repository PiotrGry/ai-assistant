import assert from "node:assert/strict";
import test from "node:test";

import {
  CapabilityAwareWorkerExecutionPort,
  CapabilityEnforcementGate,
  createTask,
  createWorkerRequest,
  startInitialAttempt,
  type CapabilityAuditDecision,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
  type WorkerPort,
  type WorkerRequest,
  type WorkerRequestInput,
  type WorkerResult,
  type WorkerAdapterRegistry,
} from "../src/index.js";

const taskId = "execution-task" as TaskId;
const attemptId = "execution-attempt";
const now = "2026-09-15T11:00:00.000Z" as UtcTimestamp;

class Audit {
  readonly decisions: CapabilityAuditDecision[] = [];
  constructor(private readonly fail = false) {}
  record(decision: CapabilityAuditDecision): void {
    if (this.fail) throw new Error("audit secret=must-not-escape");
    this.decisions.push(decision);
  }
}

function requestInput(): WorkerRequestInput {
  const task = createTask({ id: taskId, goal: "Execute one assigned worker", scope: "capability gate", acceptanceCriteria: ["guarded"], priority: 1, risk: "low", requiredCapabilities: ["repository.read", "tests.run"], createdAt: now });
  if (!task.ok) throw new Error(task.error.message);
  const started = startInitialAttempt(task.value, [], { id: attemptId as AttemptId, worker: "worker-1", provider: "provider-1", branch: "pirx/execution", worktree: "/tmp/pirx-execution" }, now);
  if (!started.ok) throw new Error(started.error.message);
  return {
    task: started.value.task,
    attempt: started.value.attempt,
    workerId: "worker-1",
    provider: "provider-1",
    repository: { owner: "PiotrGry", repository: "ai-assistant" },
    workspace: { branch: "pirx/execution", worktree: "/tmp/pirx-execution" },
    capabilityGrant: { grantedCapabilities: ["repository.read", "tests.run"], resourceScope: { repository: "PiotrGry/ai-assistant", branch: "pirx/execution", worktree: "/tmp/pirx-execution" } },
    correlationId: "execution-correlation",
    limits: { timeoutMs: 30_000, maxOutputBytes: 10_000, maxErrorBytes: 10_000 },
  };
}

function request(overrides: Partial<WorkerRequestInput> = {}): WorkerRequest {
  const parsed = createWorkerRequest({ ...requestInput(), ...overrides });
  if (!parsed.ok) throw new Error(parsed.violations[0]?.message ?? "invalid worker fixture");
  return parsed.value;
}

function pushed(value: WorkerRequest, overrides: Record<string, unknown> = {}): WorkerResult {
  return { kind: "worker_result", schemaVersion: 1, taskId: value.taskId, attemptId: value.attemptId, correlationId: value.correlationId, outcome: "CODE_PUSHED", branch: value.workspace.branch, finalCommit: "cccccccccccccccccccccccccccccccccccccccc", ...overrides } as unknown as WorkerResult;
}

function port(audit = new Audit(), adapters: WorkerAdapterRegistry = new Map<string, WorkerPort>()): { port: CapabilityAwareWorkerExecutionPort; audit: Audit } {
  return { port: new CapabilityAwareWorkerExecutionPort(new CapabilityEnforcementGate(audit), { get: (provider) => adapters.get(provider) }, { now: () => now }), audit };
}

test("authorizes exact scope and invokes exactly one assigned provider adapter", async () => {
  const value = request();
  let calls = 0;
  const adapter: WorkerPort = { async execute(input) { calls += 1; return pushed(input); } };
  const setup = port(undefined, new Map([["provider-1", adapter]]));
  const result = await setup.port.execute(value, new AbortController().signal);
  assert.equal(result.outcome, "allowed");
  assert.equal(calls, 1);
  assert.equal(setup.audit.decisions.length, 1);
  assert.equal(setup.audit.decisions[0]?.outcome, "allowed");
  assert.equal(setup.audit.decisions[0]?.action, "repository.read");
});

test("fails closed before adapter lookup or invocation for invalid bindings and missing capabilities", async () => {
  let calls = 0;
  const setup = port(new Audit(), { get: () => { calls += 1; return undefined; } });
  const value = request();
  for (const invalid of [
    { ...value, taskId: "other-task" },
    { ...value, workspace: { ...value.workspace, branch: "other-branch" } },
    { ...value, workspace: { ...value.workspace, worktree: "/tmp/other" } },
    { ...value, repository: { owner: "Other", repository: "repo" } },
    { ...value, capabilityGrant: { ...value.capabilityGrant, resourceScope: { ...value.capabilityGrant.resourceScope, repository: "Other/repo" } } },
  ]) {
    const result = await setup.port.execute(invalid, new AbortController().signal);
    assert.equal(result.outcome, "invalid_request");
  }
  const missing = await setup.port.execute({ ...value, capabilityGrant: { ...value.capabilityGrant, requiredCapabilities: ["unknown.capability"], grantedCapabilities: ["unknown.capability"] } }, new AbortController().signal);
  assert.equal(missing.outcome, "denied");
  assert.equal(calls, 0);
});

test("denies unsupported providers, audit failures, and pre-cancelled execution without an adapter call", async () => {
  let calls = 0;
  const value = request();
  const unsupported = port(new Audit(), { get: () => { calls += 1; return undefined; } });
  const unsupportedResult = await unsupported.port.execute(value, new AbortController().signal);
  assert.equal(unsupportedResult.outcome, "unsupported_provider");
  assert.equal(calls, 1, "registry lookup is not an adapter invocation");
  const failingAudit = port(new Audit(true), new Map([["provider-1", { execute: async () => { calls += 1; return pushed(value); } }]]));
  const denied = await failingAudit.port.execute(value, new AbortController().signal);
  assert.equal(denied.outcome, "denied");
  const controller = new AbortController(); controller.abort();
  const cancelled = await unsupported.port.execute(value, controller.signal);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(calls, 1);
});

test("normalizes adapter failure and malformed or secret-bearing results without exposing provider data", async () => {
  const value = request();
  const thrown = port(new Audit(), new Map([["provider-1", { execute: async () => { throw new Error("token=top-secret prompt and raw payload"); } }]]));
  const failed = await thrown.port.execute(value, new AbortController().signal);
  assert.equal(failed.outcome, "adapter_failure");
  assert.equal(JSON.stringify(failed).includes("top-secret"), false);

  const malformed = port(new Audit(), new Map([["provider-1", { execute: async () => ({ nope: "raw provider payload" }) as never }]]));
  const invalid = await malformed.port.execute(value, new AbortController().signal);
  assert.equal(invalid.outcome, "invalid_result");
  assert.equal(JSON.stringify(invalid).includes("raw provider payload"), false);

  const secret = port(new Audit(), new Map([["provider-1", { execute: async (input) => pushed(input, { finalCommit: "token=top-secret" }) }]]));
  const rejected = await secret.port.execute(value, new AbortController().signal);
  assert.equal(rejected.outcome, "invalid_result");
  assert.equal(JSON.stringify(rejected).includes("top-secret"), false);
});

test("rejects a result bound to another Attempt or branch and preserves cancellation during execution", async () => {
  const value = request();
  const wrong = port(new Audit(), new Map([["provider-1", { execute: async (input) => pushed(input, { branch: "other-branch" }) }]]));
  const invalid = await wrong.port.execute(value, new AbortController().signal);
  assert.equal(invalid.outcome, "invalid_result");

  const controller = new AbortController();
  const adapter: WorkerPort = { async execute(_input, signal) { await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); }); throw new Error("cancelled provider process"); } };
  const running = port(new Audit(), new Map([["provider-1", adapter]]));
  const pending = running.port.execute(value, controller.signal);
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.outcome, "cancelled");
});
