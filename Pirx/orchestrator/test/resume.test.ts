import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  RuntimeSqliteStore,
  buildResumeContext,
  createCheckpoint,
  createTask,
  startResumedAttempt,
  transitionAttempt,
  transitionTask,
  type AttemptId,
  type CheckpointInput,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
  type WorkspaceReferenceCheck,
  type WorkspaceReferencePort,
} from "../src/index.js";

const t0 = "2026-09-14T19:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T19:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-14T19:02:00.000Z" as UtcTimestamp;
const t3 = "2026-09-14T19:03:00.000Z" as UtcTimestamp;

async function fixture(): Promise<{ readonly directory: string; readonly filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-resume-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}

function task(id = "resume-task-1"): TaskSnapshot {
  const result = createTask({ id: id as TaskId, goal: "Resume safely", scope: "Build bounded context", acceptanceCriteria: ["successor Attempt"], priority: 1, risk: "low", requiredCapabilities: ["worker"], createdAt: t0 });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function checkpoint(taskId: string, attemptId: string, workspace = true): CheckpointInput {
  return {
    id: "resume-checkpoint-1" as CheckpointInput["id"],
    taskId: taskId as TaskId,
    previousAttemptId: attemptId as AttemptId,
    trigger: "RECOVERABLE_FAILURE",
    createdAt: t2,
    goal: "Resume safely",
    currentState: "failed",
    ...(workspace ? { repository: "PiotrGry/ai-assistant", branch: "task/resume", worktree: "/tmp/pirx-resume", currentCommit: "abc123" } : {}),
    completedWork: ["prepared"],
    remainingWork: ["continue implementation"],
    changedFiles: ["src/runtime/resume.ts"],
    findings: ["provider-independent"],
    hypotheses: ["the next Attempt can continue"],
    tests: [{ command: "pnpm test", result: "failed: provider stopped" }],
    evidence: [{ reference: "failure://resume", summary: "provider failure" }],
    blockingReason: "provider stopped",
    lastAction: "saved checkpoint",
    resumeInstruction: "continue the remaining work after checking the workspace",
  };
}

const presentWorkspace: WorkspaceReferencePort = {
  check: (): WorkspaceReferenceCheck => ({ repository: "present", branch: "present", worktree: "present", currentCommit: "present" }),
};

async function prepare(filename: string): Promise<{ store: RuntimeSqliteStore; task: TaskSnapshot; attemptId: AttemptId }> {
  const store = RuntimeSqliteStore.open({ filename });
  const createdTask = task();
  assert.equal(store.tasks.create(createdTask).outcome, "success");
  const started = store.startAttempt(createdTask.id, { id: "resume-attempt-1" as AttemptId, worker: "pirx", provider: "test", branch: "task/resume" }, t1);
  assert.equal(started.outcome, "success");
  if (started.outcome !== "success") throw new Error("start failed");
  const finished = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "FAILED", blockingReason: "provider stopped" }, t2);
  if (!finished.ok) throw new Error(finished.error.message);
  assert.equal(store.attempts.update(finished.value, "running").outcome, "success");
  const failedTask = transitionTask(started.value.task, "in_progress", { type: "fail", reason: "provider stopped" }, t3);
  if (!failedTask.ok) throw new Error(failedTask.error.message);
  assert.equal(store.tasks.update(failedTask.value, { state: started.value.task.state, updatedAt: started.value.task.updatedAt }).outcome, "success");
  const saved = createCheckpoint(checkpoint(createdTask.id, "resume-attempt-1"));
  assert.equal(saved.ok, true);
  if (!saved.ok) throw new Error("checkpoint validation failed");
  assert.equal(store.checkpoints.save(saved.value).outcome, "success");
  return { store, task: failedTask.value, attemptId: "resume-attempt-1" as AttemptId };
}

test("builds a bounded deterministic context from the latest valid Checkpoint", async () => {
  const value = await fixture();
  const setupValue = await prepare(value.filename);
  try {
    const large = createCheckpoint({ ...checkpoint(setupValue.task.id, setupValue.attemptId), id: "resume-checkpoint-large" as CheckpointInput["id"], findings: Array.from({ length: 20 }, () => "finding ".repeat(125)), hypotheses: Array.from({ length: 20 }, () => "hypothesis ".repeat(100)) });
    assert.equal(large.ok, true);
    if (!large.ok) return;
    assert.equal(setupValue.store.checkpoints.save(large.value).outcome, "success");
    const first = buildResumeContext(setupValue.store, setupValue.task.id, presentWorkspace);
    const second = buildResumeContext(setupValue.store, setupValue.task.id, presentWorkspace);
    assert.deepEqual(second, first);
    assert.equal(first.outcome, "ready");
    if (first.outcome !== "ready") return;
    assert.equal(first.context.previousAttemptId, setupValue.attemptId);
    assert.equal(first.context.currentCommit, "abc123");
    assert.equal(first.context.tests[0]?.result, "failed: provider stopped");
    assert.equal(first.context.truncatedFields.length > 0, true);
  } finally {
    setupValue.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("returns precise human-action results for every stale workspace reference", async () => {
  const fields: readonly [keyof WorkspaceReferenceCheck, "WORKSPACE_REFERENCE_MISSING" | "WORKSPACE_REFERENCE_STALE"][] = [["repository", "WORKSPACE_REFERENCE_MISSING"], ["worktree", "WORKSPACE_REFERENCE_STALE"], ["branch", "WORKSPACE_REFERENCE_STALE"], ["currentCommit", "WORKSPACE_REFERENCE_STALE"]];
  for (const [field, reason] of fields) {
    const value = await fixture();
    const setupValue = await prepare(value.filename);
    try {
      const result = buildResumeContext(setupValue.store, setupValue.task.id, { check: () => ({ repository: "present", branch: "present", worktree: "present", currentCommit: "present", [field]: reason === "WORKSPACE_REFERENCE_MISSING" ? "missing" : "stale" }) });
      assert.equal(result.outcome, "human_action_required", field);
      if (result.outcome === "human_action_required") assert.equal(result.reason, reason, field);
      const noAttempt = startResumedAttempt(setupValue.store, setupValue.task.id, { check: () => ({ repository: "present", branch: "present", worktree: "present", currentCommit: "present", [field]: reason === "WORKSPACE_REFERENCE_MISSING" ? "missing" : "stale" }) }, { id: "resume-attempt-blocked" as AttemptId, worker: "pirx", provider: "test" }, t3);
      assert.equal(noAttempt.outcome, "human_action_required", field);
      const history = setupValue.store.attempts.listByTask(setupValue.task.id);
      assert.equal(history.outcome, "success");
      if (history.outcome === "success") assert.equal(history.value.length, 1);
    } finally {
      setupValue.store.close();
      await rm(value.directory, { recursive: true, force: true });
    }
  }
});

test("distinguishes missing/invalid checkpoints and does not start on a bad workspace", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    const createdTask = task();
    assert.equal(store.tasks.create(createdTask).outcome, "success");
    const missing = buildResumeContext(store, createdTask.id, presentWorkspace);
    assert.deepEqual(missing, { outcome: "blocked", reason: "NO_CHECKPOINT", message: "No Checkpoint was found for the Task." });
    const started = store.startAttempt(createdTask.id, { id: "resume-attempt-1" as AttemptId, worker: "pirx", provider: "test" }, t1);
    assert.equal(started.outcome, "success");
    if (started.outcome !== "success") return;
    const saved = createCheckpoint(checkpoint(createdTask.id, "resume-attempt-1", false));
    assert.equal(saved.ok, true);
    if (!saved.ok) return;
    assert.equal(store.checkpoints.save(saved.value).outcome, "success");
    const invalidState = buildResumeContext(store, createdTask.id, presentWorkspace);
    assert.equal(invalidState.outcome, "blocked");
    if (invalidState.outcome === "blocked") assert.equal(invalidState.reason, "PREDECESSOR_ACTIVE");
    const noSuccessor = store.attempts.listByTask(createdTask.id);
    assert.equal(noSuccessor.outcome, "success");
    if (noSuccessor.outcome === "success") assert.equal(noSuccessor.value.length, 1);
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("creates a successor Attempt transactionally and records its predecessor", async () => {
  const value = await fixture();
  const setupValue = await prepare(value.filename);
  try {
    const result = startResumedAttempt(setupValue.store, setupValue.task.id, presentWorkspace, { id: "resume-attempt-2" as AttemptId, worker: "pirx", provider: "test", branch: "task/resume-2" }, t3);
    assert.equal(result.outcome, "ready");
    if (result.outcome !== "ready" || !("attempt" in result)) return;
    assert.equal(result.attempt.ordinal, 2);
    assert.equal(result.attempt.predecessorAttemptId, setupValue.attemptId);
    assert.equal(result.attempt.checkpointReference, "resume-checkpoint-1");
    assert.equal(setupValue.store.tasks.get(setupValue.task.id).outcome, "success");
    const history = setupValue.store.attempts.listByTask(setupValue.task.id);
    assert.equal(history.outcome, "success");
    if (history.outcome === "success") assert.deepEqual(history.value.map((attempt) => attempt.id), ["resume-attempt-1", "resume-attempt-2"]);
    const duplicate = startResumedAttempt(setupValue.store, setupValue.task.id, presentWorkspace, { id: "resume-attempt-3" as AttemptId, worker: "pirx", provider: "test" }, t3);
    assert.equal(duplicate.outcome, "blocked");
    if (duplicate.outcome === "blocked") assert.equal(duplicate.reason, "CONCURRENT_SUCCESSOR");
  } finally {
    setupValue.store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
