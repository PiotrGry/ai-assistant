import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  RuntimeSqliteStore,
  createCheckpoint,
  createTask,
  retryTask,
  startInitialAttempt,
  transitionAttempt,
  type TaskSelectionMetadataInput,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-14T12:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-14T12:01:00.000Z" as UtcTimestamp;
const t2 = "2026-09-14T12:02:00.000Z" as UtcTimestamp;
const t3 = "2026-09-14T12:03:00.000Z" as UtcTimestamp;

function task(id: string, priority = 1, capabilities: readonly string[] = ["tests.run"], state: TaskSnapshot["state"] = "ready"): TaskSnapshot {
  const result = createTask({
    id: id as TaskId,
    goal: "Select runnable Task",
    scope: "deterministic scheduler",
    acceptanceCriteria: ["one candidate"],
    priority,
    risk: "low",
    requiredCapabilities: capabilities,
    createdAt: t0,
    state,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function fixture(): Promise<{ directory: string; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-selection-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}

function sync(store: RuntimeSqliteStore, taskId: string, queueOrder: number | undefined, overrides: Partial<TaskSelectionMetadataInput> = {}) {
  return store.selection.synchronize({ taskId: taskId as TaskId, dependencyState: "known", blockers: [], synchronizedAt: t1, ...(queueOrder === undefined ? {} : { queueOrder }), ...overrides });
}

test("selects at most one candidate by Queue Order and Task ID without reprioritizing the curated queue", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    for (const value of [task("task-z", 1), task("task-b", 0), task("task-c", 1), task("task-a", 1)]) assert.equal(store.tasks.create(value).outcome, "success");
    assert.equal(sync(store, "task-z", 20).outcome, "success");
    assert.equal(sync(store, "task-b", 99).outcome, "success");
    assert.equal(sync(store, "task-c", 10).outcome, "success");
    assert.equal(sync(store, "task-a", 11).outcome, "success");
    const request = { evaluatedAt: t2, worker: { workerId: "pirx", capabilities: ["tests.run"] } } as const;
    const first = store.selection.select(request);
    assert.equal(first.outcome, "selected");
    if (first.outcome !== "selected") return;
    assert.equal(first.candidate.task.id, "task-c");
    assert.equal(first.candidate.explanation.reasonCode, "ELIGIBLE");
    assert.equal(first.explanations.filter((explanation) => explanation.eligible).length, 4);
    assert.deepEqual(store.selection.select(request), first);
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("excludes blockers, cooldowns, and unavailable capabilities, with explicit explanations", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    for (const value of [task("task-blocker"), task("task-blocked"), task("task-cooldown"), task("task-capability", 1, ["special"])]) assert.equal(store.tasks.create(value).outcome, "success");
    assert.equal(sync(store, "task-blocker", 1, { dependencyState: "known" }).outcome, "success");
    assert.equal(sync(store, "task-blocked", 2, { blockers: ["task-blocker" as TaskId] }).outcome, "success");
    assert.equal(sync(store, "task-cooldown", 3, { cooldownUntil: t3 }).outcome, "success");
    assert.equal(sync(store, "task-capability", 4).outcome, "success");
    const selected = store.selection.select({ evaluatedAt: t2, worker: { workerId: "pirx", capabilities: ["tests.run"] } });
    assert.equal(selected.outcome, "selected");
    if (selected.outcome !== "selected") return;
    assert.equal(selected.candidate.task.id, "task-blocker");
    const byId = new Map(selected.explanations.map((explanation) => [explanation.taskId, explanation]));
    assert.equal(byId.get("task-blocked" as TaskId)?.reasonCode, "BLOCKED_BY_PREREQUISITE");
    assert.equal(byId.get("task-cooldown" as TaskId)?.reasonCode, "COOLDOWN_ACTIVE");
    assert.equal(byId.get("task-capability" as TaskId)?.reasonCode, "MISSING_CAPABILITY");
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("returns no_runnable_task for an empty eligible set and excludes non-ready lifecycle states", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    assert.equal(store.tasks.create(task("task-running", 1, ["tests.run"], "in_progress")).outcome, "success");
    const result = store.selection.select({ evaluatedAt: t2, worker: { workerId: "pirx", capabilities: ["tests.run"] } });
    assert.equal(result.outcome, "no_runnable_task");
    if (result.outcome === "no_runnable_task") assert.equal(result.explanations[0]?.reasonCode, "NOT_READY");
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("selects only an explicitly checkpointed failed-CI successor Attempt from an in_progress Task", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    const currentTask = task("task-ci-retry", 1);
    assert.equal(store.tasks.create(currentTask).outcome, "success");
    assert.equal(sync(store, currentTask.id, 10).outcome, "success");
    const first = startInitialAttempt(currentTask, [], { id: "task-ci-retry-attempt-1" as never, worker: "pirx", provider: "test", branch: "pirx/task-ci-retry", worktree: "/tmp/pirx-task-ci-retry", currentCommit: "a".repeat(40) }, t1);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(store.tasks.update(first.value.task, { state: currentTask.state, updatedAt: currentTask.updatedAt }).outcome, "success");
    assert.equal(store.attempts.create(first.value.attempt).outcome, "success");
    const terminal = transitionAttempt(first.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch: "pirx/task-ci-retry", finalCommit: "a".repeat(40) }, t2);
    assert.equal(terminal.ok, true, terminal.ok ? "" : JSON.stringify(terminal.error));
    if (!terminal.ok) return;
    assert.equal(store.attempts.update(terminal.value, "running").outcome, "success");
    const checkpoint = createCheckpoint({ id: "task-ci-retry-checkpoint" as never, taskId: currentTask.id, previousAttemptId: first.value.attempt.id, trigger: "REQUIRED_ATTEMPT", createdAt: t2, goal: currentTask.goal, currentState: "in_progress", repository: "PiotrGry/ai-assistant", branch: "pirx/task-ci-retry", worktree: "/tmp/pirx-task-ci-retry", currentCommit: "a".repeat(40), completedWork: ["recorded failed CI"], remainingWork: ["run the retry"], changedFiles: [], findings: ["required workflow failed"], hypotheses: [], tests: [{ command: "Required tests", result: "failed" }], evidence: [{ reference: "ci-evidence:retry", summary: "bounded failure evidence" }], lastAction: "recorded failed CI", resumeInstruction: "run the retry through the scheduler" });
    assert.equal(checkpoint.ok, true);
    if (!checkpoint.ok) return;
    assert.equal(store.checkpoints.save(checkpoint.value).outcome, "success");
    const retried = retryTask(first.value.task, [terminal.value], { id: "task-ci-retry-attempt-2" as never, worker: "pirx", provider: "test", predecessorAttemptId: terminal.value.id, branch: "pirx/task-ci-retry", worktree: "/tmp/pirx-task-ci-retry", currentCommit: "a".repeat(40), checkpointReference: checkpoint.value.id }, t2);
    assert.equal(retried.ok, true);
    if (!retried.ok) return;
    assert.equal(store.tasks.update(retried.value.task, { state: first.value.task.state, updatedAt: first.value.task.updatedAt }).outcome, "success");
    assert.equal(store.attempts.create(retried.value.attempt).outcome, "success");

    const result = store.selection.select({ evaluatedAt: t3, worker: { workerId: "pirx", capabilities: ["tests.run"] } });
    assert.equal(result.outcome, "selected");
    if (result.outcome === "selected") assert.equal(result.candidate.task.id, currentTask.id);
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("keeps refined but unqueued Tasks out of execution and reconciles duplicate or unknown queued projections", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    assert.equal(store.tasks.create(task("task-missing")).outcome, "success");
    const missing = store.selection.select({ evaluatedAt: t2, worker: { workerId: "pirx", capabilities: ["tests.run"] } });
    assert.equal(missing.outcome, "no_runnable_task");
    if (missing.outcome === "no_runnable_task") assert.equal(missing.explanations[0]?.reasonCode, "NOT_QUEUED");

    assert.equal(sync(store, "task-missing", 10).outcome, "success");
    assert.equal(store.tasks.create(task("task-duplicate")).outcome, "success");
    assert.equal(sync(store, "task-duplicate", 10).outcome, "success");
    const duplicate = store.selection.select({ evaluatedAt: t2, worker: { workerId: "pirx", capabilities: ["tests.run"] } });
    assert.equal(duplicate.outcome, "reconciliation_required");
    if (duplicate.outcome === "reconciliation_required") assert.ok(duplicate.reasons.includes("duplicate_queue_order:10"));

    assert.equal(sync(store, "task-duplicate", 11, { dependencyState: "unknown" }).outcome, "success");
    const unknown = store.selection.select({ evaluatedAt: t2, worker: { workerId: "pirx", capabilities: ["tests.run"] } });
    assert.equal(unknown.outcome, "reconciliation_required");
    if (unknown.outcome === "reconciliation_required") assert.ok(unknown.reasons.includes("unknown_dependency_state:task-duplicate"));
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});
