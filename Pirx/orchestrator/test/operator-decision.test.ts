import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  ProductionRuntime,
  RuntimeSqliteStore,
  createTask,
  createWorkerFailureDiagnostic,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-11-06T10:00:00.000Z" as UtcTimestamp;
const t1 = "2026-11-06T10:01:00.000Z" as UtcTimestamp;
const taskId = "operator-decision-task" as TaskId;
const repository = "PiotrGry/ai-assistant";
const baseRevision = "a".repeat(40);

test("persists an operator question, accepts one idempotent answer, and resumes exactly once under a Lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-operator-decision-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  let now = t0;
  let calls = 0;
  try {
    const created = createTask({
      id: taskId,
      githubReference: { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 245, nodeId: "issue-245", url: "https://github.com/PiotrGry/ai-assistant/issues/245" },
      goal: "Resume after an explicit operator decision",
      scope: "durable operator decision",
      acceptanceCriteria: ["one successor Attempt"],
      priority: 1,
      risk: "medium",
      requiredCapabilities: ["repository.write", "git.push_assigned_branch"],
      createdAt: t0,
    });
    assert.equal(created.ok, true); if (!created.ok) return;
    assert.equal(store.tasks.create(created.value).outcome, "success");
    assert.equal(store.selection.synchronize({ taskId, queueOrder: 1, dependencyState: "known", blockers: [], synchronizedAt: t0 }).outcome, "success");
    const diagnostic = createWorkerFailureDiagnostic("operator_input_required");
    const runtime = new ProductionRuntime(store, {
      workerId: "pirx-worker",
      provider: "fake-claude",
      workerCapabilities: ["repository.write", "git.push_assigned_branch"],
      repositories: [{ repository, repositoryRoot: "/repo", baseBranch: "develop", baseRevision }],
      worktreeParent: "/tmp/pirx-worktrees",
      leaseDurationMs: 60_000,
      attemptIdFactory: (_task, ordinal) => `operator-attempt-${ordinal}` as AttemptId,
      workerAdapters: { get: () => ({ execute: async (request) => {
        calls += 1;
        const lease = store.leases.getActiveByTask(taskId);
        assert.equal(lease.outcome, "success");
        assert.equal(lease.outcome === "success" ? lease.value.attemptId : undefined, request.attemptId);
        if (calls === 1) return { kind: "worker_result" as const, schemaVersion: 1 as const, taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, outcome: "BLOCKED" as const, reason: "Choose whether to preserve the legacy field.", diagnostic };
        const checkpoint = request.resumeContextReference === undefined ? undefined : store.checkpoints.get(request.resumeContextReference);
        assert.equal(checkpoint?.outcome, "success");
        if (checkpoint?.outcome === "success") assert.match(checkpoint.value.resumeInstruction, /Preserve it for compatibility/u);
        return { kind: "worker_result" as const, schemaVersion: 1 as const, taskId: request.taskId, attemptId: request.attemptId, correlationId: request.correlationId, outcome: "CODE_PUSHED" as const, branch: request.workspace.branch, finalCommit: "b".repeat(40) };
      } }) },
      workspace: { provision: async (request) => ({ outcome: "created", message: "workspace ready", binding: { schemaVersion: 1, taskId: request.taskId, attemptId: request.attemptId, repositoryRoot: request.repositoryRoot, assignedBranch: request.assignedBranch, expectedBaseRevision: request.expectedBaseRevision, worktreePath: resolve(request.worktreeParent, `pirx-${request.taskId}-${request.attemptId}`) } }) },
      resumeWorkspaceValidator: { validate: async () => ({ outcome: "valid", message: "durable workspace verified" }) },
      clock: { now: () => now },
    });

    const blocked = await runtime.cycle();
    assert.equal(blocked.outcome, "failed");
    assert.equal(calls, 1);
    const questions = store.operatorDecisions.listOpen();
    assert.equal(questions.outcome, "success"); if (questions.outcome !== "success") return;
    assert.equal(questions.value.length, 1);
    const question = questions.value[0]!;
    assert.equal(question.sourceAttemptId, "operator-attempt-1");
    assert.equal(store.leases.acquire({ id: "premature-operator-lease" as never, taskId, workerId: "pirx-worker", now: t0, durationMs: 60_000 }).outcome, "conflict");

    store.database.prepare("UPDATE runtime_operator_questions SET expires_at = ? WHERE id = ?").run("2026-11-06T10:00:30.000Z", question.id);
    const expired = store.operatorDecisions.answer({ questionId: question.id, expectedVersion: question.version, operationId: "operator-expired-answer", answer: "Preserve it for compatibility.", decidedBy: "mcp-chat", decidedAt: t1 });
    assert.equal(expired.outcome, "conflict");
    const afterExpiry = store.operatorDecisions.get(question.id);
    assert.equal(afterExpiry.outcome === "success" ? afterExpiry.value.state : undefined, "open");
    store.database.prepare("UPDATE runtime_operator_questions SET expires_at = NULL WHERE id = ?").run(question.id);

    const chatStore = RuntimeSqliteStore.open({ filename, mode: "existing" });
    try {
      const accepted = chatStore.operatorDecisions.answer({ questionId: question.id, expectedVersion: question.version, operationId: "operator-answer-1", answer: "Preserve it for compatibility.", decidedBy: "mcp-chat", decidedAt: t1 });
      assert.equal(accepted.outcome, "success");
      if (accepted.outcome === "success") assert.equal(accepted.value.replayed, false);
      const replay = chatStore.operatorDecisions.answer({ questionId: question.id, expectedVersion: question.version, operationId: "operator-answer-1", answer: "Preserve it for compatibility.", decidedBy: "mcp-chat", decidedAt: t1 });
      assert.equal(replay.outcome, "success");
      if (replay.outcome === "success") assert.equal(replay.value.replayed, true);
      const equivalentReplay = chatStore.operatorDecisions.answer({ questionId: question.id, expectedVersion: question.version, operationId: "operator-answer-2", answer: "Preserve it for compatibility.", decidedBy: "mcp-chat", decidedAt: t1 });
      assert.equal(equivalentReplay.outcome, "success");
      const conflict = chatStore.operatorDecisions.answer({ questionId: question.id, expectedVersion: question.version, operationId: "operator-answer-3", answer: "Remove it.", decidedBy: "mcp-chat", decidedAt: t1 });
      assert.equal(conflict.outcome, "conflict");
    } finally { chatStore.close(); }

    now = t1;
    const resumed = await runtime.cycle();
    assert.equal(resumed.outcome, "started", JSON.stringify(resumed));
    assert.equal(calls, 2);
    const history = store.attempts.listByTask(taskId);
    assert.equal(history.outcome, "success");
    if (history.outcome === "success") {
      assert.equal(history.value.length, 2);
      assert.equal(history.value[1]?.predecessorAttemptId, history.value[0]?.id);
      assert.equal(history.value[1]?.state, "terminal");
      if (history.value[1]?.state === "terminal") assert.equal(history.value[1].result, "CODE_PUSHED");
    }
    await runtime.cycle();
    assert.equal(calls, 2);
    const replayHistory = store.attempts.listByTask(taskId);
    assert.equal(replayHistory.outcome, "success");
    if (replayHistory.outcome === "success") assert.equal(replayHistory.value.length, 2);
    runtime.close();
  } finally {
    try { store.close(); } catch { /* runtime owns the store after success */ }
    await rm(directory, { recursive: true, force: true });
  }
});
