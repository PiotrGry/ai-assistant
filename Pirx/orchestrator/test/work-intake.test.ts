import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  RuntimeSqliteStore,
  ProductionRuntime,
  WorkIntakeCoordinator,
  WorkIntakeQueueReconciler,
  createTask,
  failure,
  success,
  type GitHubIssueSummary,
  type GitHubProjectMetadata,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
  type WorkIntakeInput,
} from "../src/index.js";

const acceptedAt = "2026-11-06T12:00:00.000Z" as UtcTimestamp;
const repository = "PiotrGry/ai-assistant";
const goal = "Implement durable work intake";
const criteria = ["request survives chat restart", "normal Queue creates the Task"];

function input(overrides: Partial<WorkIntakeInput> = {}): WorkIntakeInput {
  return { operationId: "submit-246", repository, issueNumber: 246, goal, acceptanceCriteria: criteria, priority: "P1", risk: "Medium", area: "Orchestrator", workType: "Task", queueOrder: 246, acceptedAt, ...overrides };
}

function issue(body = `## Goal\n\n${goal}\n\n## Implementation scope\n\n- Durable intake\n\n## Acceptance criteria\n\n- [ ] ${criteria[0]}\n- [ ] ${criteria[1]}`): GitHubIssueSummary {
  return { owner: "PiotrGry", repository: "ai-assistant", nodeId: "issue-node-246", number: 246, url: "https://github.com/PiotrGry/ai-assistant/issues/246", title: "Tracked work", body, state: "open", labels: [], assignees: [], createdAt: acceptedAt, updatedAt: acceptedAt };
}

test("work intake is durable, idempotent and linked only through the normal Task projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-work-intake-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  try {
    const created = store.workIntakes.create(input());
    assert.equal(created.outcome, "success");
    if (created.outcome !== "success") return;
    assert.equal(created.value.state, "accepted");
    const initialTasks = store.tasks.list();
    assert.equal(initialTasks.outcome === "success" ? initialTasks.value.length : -1, 0);
    assert.equal(store.attempts.listByTask("missing").outcome, "success");
    assert.equal(store.workIntakes.create(input()).outcome, "success");
    assert.equal(store.workIntakes.create(input({ goal: "different" })).outcome, "conflict");

    store.close();
    const reopened = RuntimeSqliteStore.open({ filename, mode: "existing" });
    let projectCalls = 0;
    let observedMetadata: GitHubProjectMetadata | undefined;
    const coordinator = new WorkIntakeCoordinator(reopened, new Map([[repository, {
      reader: { getIssue: async () => success(issue(), "read-246") },
      project: { synchronize: async (_issue, metadata) => {
        projectCalls += 1; observedMetadata = metadata;
        return { outcome: "synchronized" as const, correlationId: "project-246", message: "synchronized", value: { id: "project-item-246", issueNodeId: "issue-node-246", values: {} } };
      } },
    }]]), { now: () => acceptedAt });
    assert.equal((await coordinator.reconcile()).outcome, "processed");
    assert.equal(projectCalls, 1);
    assert.deepEqual(observedMetadata, { status: "Todo", priority: "P1", worker: "Pirx", area: "Orchestrator", risk: "Medium", workType: "Task", queueOrder: 246 });
    const linking = reopened.workIntakes.get(created.value.id);
    assert.equal(linking.outcome === "success" ? linking.value.state : undefined, "linking");
    const initialAttempts = reopened.attempts.listByTask("missing");
    assert.equal(initialAttempts.outcome === "success" ? initialAttempts.value.length : -1, 0);

    const task = createTask({ id: "gh-246-fixture" as TaskId, githubReference: { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 246, nodeId: "issue-node-246", url: "https://github.com/PiotrGry/ai-assistant/issues/246" }, goal, scope: "Durable intake", acceptanceCriteria: criteria, priority: 75, risk: "medium", requiredCapabilities: ["repository.read"], createdAt: acceptedAt });
    assert.equal(task.ok, true); if (!task.ok) return;
    assert.equal(reopened.tasks.create(task.value).outcome, "success");
    assert.equal((await coordinator.reconcile()).outcome, "processed");
    const linked = reopened.workIntakes.get(created.value.id);
    assert.equal(linked.outcome === "success" ? linked.value.state : undefined, "linked");
    assert.equal(linked.outcome === "success" ? linked.value.taskId : undefined, task.value.id);
    assert.equal(projectCalls, 1);
    assert.equal(reopened.selection.synchronize({ taskId: task.value.id, queueOrder: 246, dependencyState: "known", blockers: [], synchronizedAt: acceptedAt }).outcome, "success");
    let workerCalls = 0;
    const runtime = new ProductionRuntime(reopened, {
      workerId: "pirx-worker", provider: "fake-claude", workerCapabilities: ["repository.read"],
      repositories: [{ repository, repositoryRoot: "/repo", baseBranch: "main", baseRevision: "a".repeat(40) }],
      worktreeParent: "/tmp/pirx-worktrees", leaseDurationMs: 60_000,
      attemptIdFactory: () => "intake-attempt-1" as AttemptId,
      workerAdapters: { get: () => ({ execute: async (request) => {
        workerCalls += 1;
        const lease = reopened.leases.getActiveByTask(task.value.id);
        assert.equal(lease.outcome, "success");
        assert.equal(lease.outcome === "success" ? lease.value.attemptId : undefined, request.attemptId);
        return { kind: "worker_result" as const, schemaVersion: 1 as const, taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, outcome: "CODE_PUSHED" as const, branch: request.workspace.branch, finalCommit: "b".repeat(40) };
      } }) },
      workspace: { provision: async (request) => ({ outcome: "created", message: "workspace ready", binding: { schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, repositoryRoot: request.repositoryRoot, assignedBranch: request.assignedBranch, expectedBaseRevision: request.expectedBaseRevision, worktreePath: resolve(request.worktreeParent, `pirx-${request.taskId}-${request.attemptId}`) } }) },
    });
    const dispatched = await runtime.cycle();
    assert.equal(dispatched.outcome, "started");
    assert.equal(workerCalls, 1);
    const attempts = reopened.attempts.listByTask(task.value.id);
    assert.equal(attempts.outcome === "success" ? attempts.value.length : -1, 1);
    assert.equal(attempts.outcome === "success" ? attempts.value[0]?.id : undefined, "intake-attempt-1");
    runtime.close();
  } finally {
    try { store.close(); } catch { /* reopened store owns the file */ }
    await rm(directory, { recursive: true, force: true });
  }
});

test("work intake rejects scope drift and never prevents the normal Queue reconciliation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-work-intake-scope-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  try {
    const accepted = store.workIntakes.create(input({ operationId: "submit-scope-drift" }));
    assert.equal(accepted.outcome, "success"); if (accepted.outcome !== "success") return;
    let queueCalls = 0;
    const intake = new WorkIntakeCoordinator(store, new Map([[repository, {
      reader: { getIssue: async () => success(issue("## Goal\n\nSomething else"), "read-drift") },
      project: { synchronize: async () => { throw new Error("Project must not be mutated for scope drift"); } },
    }]]), { now: () => acceptedAt });
    const composed = new WorkIntakeQueueReconciler(intake, { reconcile: async () => { queueCalls += 1; return { outcome: "synchronized" }; } });
    assert.equal((await composed.reconcile()).outcome, "synchronized");
    assert.equal(queueCalls, 1);
    const rejected = store.workIntakes.get(accepted.value.id);
    assert.equal(rejected.outcome === "success" ? rejected.value.state : undefined, "rejected");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a retryable intake failure remains visible without stalling unrelated Queue work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-work-intake-retry-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  try {
    const accepted = store.workIntakes.create(input({ operationId: "submit-retryable" }));
    assert.equal(accepted.outcome, "success"); if (accepted.outcome !== "success") return;
    const intake = new WorkIntakeCoordinator(store, new Map([[repository, {
      reader: { getIssue: async () => failure("rate_limited", "rate_limited", "retry later", "read-rate-limit", "not_accepted") },
      project: { synchronize: async () => { throw new Error("Project must not run while Issue read is rate limited"); } },
    }]]), { now: () => acceptedAt });
    let queueCalls = 0;
    const composed = new WorkIntakeQueueReconciler(intake, { reconcile: async () => { queueCalls += 1; return { outcome: "synchronized" }; } });
    const result = await composed.reconcile();
    assert.equal(result.outcome, "synchronized");
    assert.match(result.message ?? "", /work intake remains pending/u);
    assert.equal(queueCalls, 1);
    const pending = store.workIntakes.get(accepted.value.id);
    assert.equal(pending.outcome === "success" ? pending.value.state : undefined, "accepted");
    assert.equal(pending.outcome === "success" ? pending.value.lastError : undefined, "retry later");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
