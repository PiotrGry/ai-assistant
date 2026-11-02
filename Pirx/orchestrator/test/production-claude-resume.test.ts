import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { RuntimeSqliteStore, createTask, transitionAttempt, transitionTask, createCheckpoint, startResumedAttempt, buildAssignedResumeContext, buildResumeContext, createWorkerRequest } from "../src/index.js";
import { ProductionClaudeWorker } from "../src/claude/production-worker.js";

test("production Claude resumes an assigned successor from its predecessor checkpoint without creating another Attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-production-resume-"));
  const worktree = join(root, "worktree"); await mkdir(worktree);
  const store = RuntimeSqliteStore.open({ filename: join(root, "runtime.sqlite") });
  const t0 = "2026-11-02T12:00:00.000Z" as never;
  const t1 = "2026-11-02T12:01:00.000Z" as never;
  const t2 = "2026-11-02T12:02:00.000Z" as never;
  const t3 = "2026-11-02T12:03:00.000Z" as never;
  try {
    const made = createTask({ id: "resume-production-task" as never, goal: "Resume safely", scope: "Production adapter", acceptanceCriteria: ["invoke once"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
    assert.equal(made.ok, true); if (!made.ok) return;
    assert.equal(store.tasks.create(made.value).outcome, "success");
    const first = store.startAttempt(made.value.id, { id: "resume-production-attempt-1" as never, worker: "worker", provider: "claude-code", branch: "pirx/review", worktree }, t1);
    assert.equal(first.outcome, "success"); if (first.outcome !== "success") return;
    const finished = transitionAttempt(first.value.attempt, "running", { type: "finish", result: "FAILED", blockingReason: "process failure" }, t2);
    assert.equal(finished.ok, true); if (!finished.ok) return;
    assert.equal(store.attempts.update(finished.value, "running").outcome, "success");
    const failed = transitionTask(first.value.task, "in_progress", { type: "fail", reason: "process failure" }, t2);
    assert.equal(failed.ok, true); if (!failed.ok) return;
    assert.equal(store.tasks.update(failed.value, { state: "in_progress", updatedAt: first.value.task.updatedAt }).outcome, "success");
    const checkpoint = createCheckpoint({ id: "resume-production-checkpoint" as never, taskId: made.value.id, previousAttemptId: first.value.attempt.id, trigger: "RECOVERABLE_FAILURE", createdAt: t2, goal: made.value.goal, currentState: "failed", completedWork: [], remainingWork: ["continue"], changedFiles: [], findings: [], hypotheses: [], tests: [], evidence: [], lastAction: "process failed", resumeInstruction: "continue" });
    assert.equal(checkpoint.ok, true); if (!checkpoint.ok) return;
    assert.equal(store.checkpoints.save(checkpoint.value).outcome, "success");
    const successor = startResumedAttempt(store, made.value.id, { check: () => ({ repository: "present", branch: "present", worktree: "present", currentCommit: "present" }) }, { id: "resume-production-attempt-2" as never, worker: "worker", provider: "claude-code", branch: "pirx/review", worktree }, t3);
    assert.equal(successor.outcome, "ready"); if (successor.outcome !== "ready" || !("attempt" in successor)) return;
    assert.equal(buildAssignedResumeContext(store, made.value.id, successor.attempt.id).outcome, "ready");
    assert.notEqual(buildAssignedResumeContext(store, made.value.id, first.value.attempt.id).outcome, "ready");
    assert.equal(buildResumeContext(store, made.value.id, { check: () => ({ repository: "present", branch: "present", worktree: "present", currentCommit: "present" }) }).outcome, "invalid_checkpoint");
    const task = store.tasks.get(made.value.id); assert.equal(task.outcome, "success"); if (task.outcome !== "success") return;
    const request = createWorkerRequest({ task: task.value, attempt: successor.attempt, workerId: "worker", provider: "claude-code", repository: { owner: "PiotrGry", repository: "ai-assistant" }, workspace: { branch: "pirx/review", worktree }, capabilityGrant: { grantedCapabilities: ["repository.read"], resourceScope: { repository: "PiotrGry/ai-assistant", branch: "pirx/review", worktree } }, correlationId: "resume-production-correlation", limits: { timeoutMs: 1000, maxOutputBytes: 16384, maxErrorBytes: 16384 }, resumeContextReference: checkpoint.value.id });
    assert.equal(request.ok, true); if (!request.ok) return;
    let calls = 0;
    const worker = new ProductionClaudeWorker({ store, repositories: [{ repository: "PiotrGry/ai-assistant", repositoryRoot: root, remoteName: "origin", testCommands: [] }], runner: { async runStructured(input) {
      calls++;
      assert.match(input.prompt, /"mode":"resume"/u);
      assert.match(input.prompt, /resume-production-attempt-1/u);
      return { outcome: "success", requestId: input.requestId, durationMs: 1, exitCode: 0, structuredOutput: { kind: "worker_result", schemaVersion: 1, taskId: request.value.taskId, attemptId: request.value.attemptId, correlationId: request.value.correlationId, outcome: "BLOCKED", reason: "Fixture completed without repository mutations" } };
    } } });
    const result = await worker.execute(request.value, new AbortController().signal);
    assert.equal(result.outcome, "BLOCKED");
    assert.equal(calls, 1);
    const history = store.attempts.listByTask(made.value.id);
    assert.equal(history.outcome, "success"); if (history.outcome === "success") assert.equal(history.value.length, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
