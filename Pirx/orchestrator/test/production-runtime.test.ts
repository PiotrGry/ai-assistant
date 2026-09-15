import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ProductionRuntime,
  RuntimeSqliteStore,
  createCheckpoint,
  createTask,
  retryTask,
  startInitialAttempt,
  transitionAttempt,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
  type WorkerPort,
} from "../src/index.js";

const now = "2026-09-15T21:00:00.000Z" as UtcTimestamp;
const taskId = "production-runtime-task" as TaskId;
const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 194, nodeId: "issue-194", url: "https://github.com/PiotrGry/ai-assistant/issues/194" } as const;
const repository = "PiotrGry/ai-assistant";
const baseRevision = "a".repeat(40);

async function setup(adapter: WorkerPort | null = { execute: async (request) => ({ kind: "worker_result", schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, outcome: "CODE_PUSHED", branch: request.workspace.branch, finalCommit: "b".repeat(40) }) }): Promise<{ directory: string; store: RuntimeSqliteStore; runtime: ProductionRuntime; adapterCalls: { value: number } }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-production-runtime-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  const task = createTask({ id: taskId, githubReference: issue, goal: "Run assigned work", scope: "production composition", acceptanceCriteria: ["durable worker cycle"], priority: 1, risk: "low", requiredCapabilities: ["repository.write", "git.push_assigned_branch"], createdAt: now });
  if (!task.ok || store.tasks.create(task.value).outcome !== "success") throw new Error("task fixture failed");
  if (store.selection.synchronize({ taskId, queueOrder: 1, dependencyState: "known", blockers: [], synchronizedAt: now }).outcome !== "success") throw new Error("selection fixture failed");
  const adapterCalls = { value: 0 };
  const counted = adapter === null ? undefined : { execute: async (request: Parameters<WorkerPort["execute"]>[0], signal: AbortSignal) => { adapterCalls.value += 1; return adapter.execute(request, signal); } };
  const runtime = new ProductionRuntime(store, { workerId: "pirx-worker", provider: "fake-claude", workerCapabilities: ["repository.write", "git.push_assigned_branch"], repositories: [{ repository, repositoryRoot: "/repo", baseBranch: "develop", baseRevision }], worktreeParent: "/tmp/pirx-worktrees", leaseDurationMs: 60_000, workerTimeoutMs: 5_000, workerAdapters: { get: () => counted }, workspace: { provision: async (request) => ({ outcome: "created", message: "workspace ready", binding: { schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, repositoryRoot: request.repositoryRoot, assignedBranch: request.assignedBranch, expectedBaseRevision: request.expectedBaseRevision, worktreePath: resolve(request.worktreeParent, `pirx-${request.taskId}-${request.attemptId}`) } }) }, clock: { now: () => now } });
  return { directory, store, runtime, adapterCalls };
}

async function dispose(value: { directory: string; runtime: ProductionRuntime; store: RuntimeSqliteStore }): Promise<void> {
  try { if (!value.runtime.status().stopping) value.runtime.close(); } finally { await rm(value.directory, { recursive: true, force: true }); }
}

test("composes selection, Lease, Attempt, workspace, capability, worker lifecycle, persistence and release", async () => {
  const value = await setup();
  try {
    const result = await value.runtime.cycle();
    assert.equal(result.outcome, "started");
    assert.equal(value.adapterCalls.value, 1);
    assert.equal(value.runtime.status().recovered, true);
    const attempts = value.store.attempts.listByTask(taskId); assert.equal(attempts.outcome, "success");
    assert.equal(attempts.value.length, 1); assert.equal(attempts.value[0]?.state, "terminal"); assert.equal(attempts.value[0]?.result, "CODE_PUSHED");
    assert.equal(value.store.leases.getActiveByWorker("pirx-worker").outcome, "not_found");
    assert.equal(value.store.workspaces.getByAttempt(attempts.value[0]!.id).outcome, "success");
  } finally { await dispose(value); }
});

test("does not create an Attempt when the registered production provider is unavailable", async () => {
  const value = await setup(null);
  try {
    const result = await value.runtime.cycle();
    assert.deepEqual(result, { outcome: "deferred", reason: "worker_unavailable" });
    const attempts = value.store.attempts.listByTask(taskId); assert.equal(attempts.outcome, "success"); if (attempts.outcome === "success") assert.equal(attempts.value.length, 0);
  } finally { await dispose(value); }
});

test("claims the durable CI retry Attempt after acquiring its Lease without creating Attempt 3", async () => {
  const setup = await mkdtemp(join(tmpdir(), "pirx-production-retry-"));
  const store = RuntimeSqliteStore.open({ filename: join(setup, "runtime.sqlite") });
  const retryTaskId = "production-retry-task" as TaskId;
  const retryIssue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 198, nodeId: "issue-198", url: "https://github.com/PiotrGry/ai-assistant/issues/198" } as const;
  const retryBranch = "pirx/production-retry";
  const retryCommit = "c".repeat(40);
  const retryAttempt1 = "production-retry-attempt-1" as AttemptId;
  const retryAttempt2 = "production-retry-attempt-2" as AttemptId;
  let workerCalls = 0;
  try {
    const created = createTask({ id: retryTaskId, githubReference: retryIssue, goal: "Retry through scheduler", scope: "failed CI", acceptanceCriteria: ["one worker"], priority: 1, risk: "low", requiredCapabilities: ["repository.write", "git.push_assigned_branch"], createdAt: now });
    assert.equal(created.ok, true); if (!created.ok) return;
    assert.equal(store.tasks.create(created.value).outcome, "success");
    assert.equal(store.selection.synchronize({ taskId: retryTaskId, queueOrder: 1, dependencyState: "known", blockers: [], synchronizedAt: now }).outcome, "success");
    const started = startInitialAttempt(created.value, [], { id: retryAttempt1, worker: "pirx-worker", provider: "fake-claude", branch: retryBranch, worktree: "/tmp/pirx-production-retry", currentCommit: retryCommit }, now);
    assert.equal(started.ok, true); if (!started.ok) return;
    assert.equal(store.tasks.update(started.value.task, { state: created.value.state, updatedAt: created.value.updatedAt }).outcome, "success");
    assert.equal(store.attempts.create(started.value.attempt).outcome, "success");
    const terminal = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch: retryBranch, finalCommit: retryCommit }, "2026-09-15T21:01:00.000Z" as UtcTimestamp);
    assert.equal(terminal.ok, true); if (!terminal.ok) return;
    assert.equal(store.attempts.update(terminal.value, "running").outcome, "success");
    const checkpoint = createCheckpoint({ id: "production-retry-checkpoint" as never, taskId: retryTaskId, previousAttemptId: retryAttempt1, trigger: "REQUIRED_ATTEMPT", createdAt: "2026-09-15T21:01:00.000Z" as UtcTimestamp, goal: created.value.goal, currentState: "in_progress", repository, branch: retryBranch, worktree: "/tmp/pirx-production-retry", currentCommit: retryCommit, completedWork: ["recorded exact failed CI"], remainingWork: ["run worker"], changedFiles: [], findings: ["workflow failed"], hypotheses: [], tests: [{ command: "Develop — Fast Gate", result: "failure" }], evidence: [{ reference: "ci-evidence:198", summary: "bounded failed CI" }], lastAction: "recorded failed CI", resumeInstruction: "run through scheduler" });
    assert.equal(checkpoint.ok, true); if (!checkpoint.ok) return;
    assert.equal(store.checkpoints.save(checkpoint.value).outcome, "success");
    const retried = retryTask(started.value.task, [terminal.value], { id: retryAttempt2, worker: "pirx-worker", provider: "fake-claude", predecessorAttemptId: retryAttempt1, branch: retryBranch, worktree: "/tmp/pirx-production-retry", currentCommit: retryCommit, checkpointReference: checkpoint.value.id }, "2026-09-15T21:01:00.000Z" as UtcTimestamp);
    assert.equal(retried.ok, true); if (!retried.ok) return;
    assert.equal(store.tasks.update(retried.value.task, { state: started.value.task.state, updatedAt: started.value.task.updatedAt }).outcome, "success");
    assert.equal(store.attempts.create(retried.value.attempt).outcome, "success");
    const runtime = new ProductionRuntime(store, { workerId: "pirx-worker", provider: "fake-claude", workerCapabilities: ["repository.write", "git.push_assigned_branch"], repositories: [{ repository, repositoryRoot: "/repo", baseBranch: "develop", baseRevision }], worktreeParent: "/tmp/pirx-worktrees", leaseDurationMs: 60_000, workerAdapters: { get: () => ({ execute: async (request) => { workerCalls += 1; const lease = store.leases.getActiveByTask(retryTaskId); assert.equal(lease.outcome, "success"); assert.equal(lease.outcome === "success" ? lease.value.attemptId : undefined, retryAttempt2); return { kind: "worker_result", schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, outcome: "CODE_PUSHED", branch: request.workspace.branch, finalCommit: "d".repeat(40) }; } }) }, workspace: { provision: async (request) => ({ outcome: "created", message: "workspace ready", binding: { schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, repositoryRoot: request.repositoryRoot, assignedBranch: request.assignedBranch, expectedBaseRevision: request.expectedBaseRevision, worktreePath: "/tmp/pirx-production-retry" } }) }, clock: { now: () => "2026-09-15T21:02:00.000Z" as UtcTimestamp } });
    const result = await runtime.cycle();
    assert.equal(result.outcome, "started", JSON.stringify({ result, attempts: store.attempts.listByTask(retryTaskId), workerCalls }));
    assert.equal(workerCalls, 1);
    const attempts = store.attempts.listByTask(retryTaskId); assert.equal(attempts.outcome, "success"); if (attempts.outcome === "success") { assert.equal(attempts.value.length, 2); assert.equal(attempts.value[0]?.state, "terminal"); assert.equal(attempts.value[1]?.id, retryAttempt2); assert.equal(attempts.value[1]?.state, "terminal"); }
    runtime.close();
  } finally { try { store.close(); } catch { /* runtime may already have closed it */ } await rm(setup, { recursive: true, force: true }); }
});

test("blocks startup when a durable active Lease needs reconciliation and prevents duplicate cycles", async () => {
  const value = await setup();
  try {
    const lease = value.store.leases.acquire({ id: "preexisting-lease" as never, taskId, workerId: "pirx-worker", now, durationMs: 60_000 });
    assert.equal(lease.outcome, "success");
    const blocked = await value.runtime.cycle(); assert.equal(blocked.outcome, "reconciliation_required"); assert.equal(value.adapterCalls.value, 0);
  } finally { await dispose(value); }
  const slow = await setup({ execute: async (_request, signal) => await new Promise((resolveResult) => { signal.addEventListener("abort", () => resolveResult({ kind: "worker_result", schemaVersion: 1, taskId, attemptId: "unused" as AttemptId, correlationId: "cancelled", outcome: "CANCELLED", reason: "shutdown" }), { once: true }); }) });
  try {
    const first = slow.runtime.cycle();
    await new Promise<void>((resolveResult) => setImmediate(resolveResult));
    const duplicate = await slow.runtime.cycle(); assert.deepEqual(duplicate, { outcome: "deferred", reason: "cycle_already_running" });
    const beforeShutdown = slow.store.attempts.listByTask(taskId); assert.equal(beforeShutdown.outcome, "success"); if (beforeShutdown.outcome === "success") assert.equal(beforeShutdown.value.length, 1);
    const stopped = await slow.runtime.shutdown(); assert.equal(stopped.outcome, "stopped"); assert.equal(slow.adapterCalls.value, 1);
    await first;
  } finally { try { slow.store.close(); } catch { /* shutdown closes the store */ } await rm(slow.directory, { recursive: true, force: true }); }
});
