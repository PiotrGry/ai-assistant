import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { RuntimeSqliteStore, createTask, retryTask, transitionAttempt, type AttemptId, type TaskId, type TerminalAttemptSnapshot, type UtcTimestamp } from "../src/index.js";
import { BRANCH_SYNC_PROVIDER } from "../src/runtime/feature-branch-sync.js";
import { MAX_POST_MERGE_RETRIES, createPostMergeRetry } from "../src/runtime/post-merge-retry.js";

const t0 = "2026-11-18T10:00:00.000Z" as UtcTimestamp;
const at = (minutes: number): UtcTimestamp => new Date(Date.parse(t0) + minutes * 60_000).toISOString() as UtcTimestamp;
const taskId = "pm-task" as TaskId;
const branch = "pirx/task-pm-task";
const worktree = "/tmp/pirx-worktrees/pm-task";
const sha = (char: string) => char.repeat(40);

/** A worker Attempt and then a Pirx branch-sync Attempt, both CODE_PUSHED on the same branch. */
async function fixture(): Promise<{ directory: string; store: RuntimeSqliteStore }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-post-merge-retry-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  const task = createTask({ id: taskId, githubReference: { owner: "PiotrGry", repository: "zdrovena", issueNumber: 9 }, goal: "Fix docs", scope: "docs", acceptanceCriteria: ["released"], priority: 1, risk: "low", requiredCapabilities: ["repository.write"], createdAt: t0 });
  if (!task.ok || store.tasks.create(task.value).outcome !== "success") throw new Error("task fixture failed");
  const first = store.startAttempt(taskId, { id: "pm-attempt-1" as AttemptId, worker: "pepus-claude", provider: "claude-code", branch, worktree }, at(1));
  if (first.outcome !== "success") throw new Error(first.message);
  const pushed = transitionAttempt(first.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha("a"), currentCommit: sha("a") }, at(2));
  if (!pushed.ok || store.attempts.update(pushed.value, "running").outcome !== "success") throw new Error("first attempt failed");
  const current = store.tasks.get(taskId); const history = store.attempts.listByTask(taskId);
  if (current.outcome !== "success" || history.outcome !== "success") throw new Error("read failed");
  const synced = retryTask(current.value, history.value, { id: "pm-attempt-2" as AttemptId, worker: "pirx", provider: BRANCH_SYNC_PROVIDER, predecessorAttemptId: "pm-attempt-1" as AttemptId, branch, worktree, currentCommit: sha("a"), progress: "merging develop" }, at(3));
  if (!synced.ok || store.tasks.update(synced.value.task, { state: current.value.state, updatedAt: current.value.updatedAt }).outcome !== "success" || store.attempts.create(synced.value.attempt).outcome !== "success") throw new Error("sync attempt failed");
  const merged = transitionAttempt(synced.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha("b"), currentCommit: sha("b") }, at(4));
  if (!merged.ok || store.attempts.update(merged.value, "running").outcome !== "success") throw new Error("sync finish failed");
  return { directory, store };
}
async function dispose(value: { directory: string; store: RuntimeSqliteStore }) { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
function latest(store: RuntimeSqliteStore): TerminalAttemptSnapshot { const history = store.attempts.listByTask(taskId); if (history.outcome !== "success") throw new Error("history"); return history.value.at(-1) as TerminalAttemptSnapshot; }
function request(store: RuntimeSqliteStore, runId: number, minutes: number) {
  const task = store.tasks.get(taskId); if (task.outcome !== "success") throw new Error("task");
  return { task: task.value, attempt: latest(store), mergeSha: sha("c"), baseBranch: "develop", failedRun: { id: runId, name: "Release validation", status: "completed" as const, conclusion: "failure" as const, headSha: sha("c"), pullRequestNumbers: [], url: `https://github.com/o/r/actions/runs/${runId}` }, message: `release-validation.yml on develop failed for ccccccc: run ${runId} ended failure.`, facts: ["Failed job smoke; failed steps: pytest (#4)."], now: at(minutes) };
}

test("a failed post-merge run becomes one worker Attempt on the same branch, after the Pirx sync Attempt", async () => {
  const value = await fixture();
  try {
    const created = createPostMergeRetry(value.store, request(value.store, 77, 10));
    assert.equal(created.outcome, "created", created.message);
    const fix = latest(value.store) as unknown as { id: string; state: string; worker: string; provider: string; predecessorAttemptId: string; branch: string; worktree: string; checkpointReference: string; ordinal: number };
    assert.equal(fix.id, created.attemptId);
    assert.equal(fix.state, "running");
    // The scheduler claims a retry only from its own worker identity, after the immediate predecessor.
    assert.deepEqual([fix.worker, fix.provider, fix.predecessorAttemptId, fix.branch, fix.worktree, fix.ordinal], ["pepus-claude", "claude-code", "pm-attempt-2", branch, worktree, 3]);
    const checkpoint = value.store.checkpoints.get(fix.checkpointReference);
    assert.equal(checkpoint.outcome, "success");
    if (checkpoint.outcome === "success") {
      assert.equal(checkpoint.value.previousAttemptId, "pm-attempt-2");
      assert.match(checkpoint.value.findings.join("\n"), /run 77 ended failure[\s\S]*pytest \(#4\)/u);
      assert.match(checkpoint.value.resumeInstruction, /Merge the current develop into pirx\/task-pm-task first/u);
    }
  } finally { await dispose(value); }
});

test("the same failed run is handed over once, and repeated failures stop for a human", async () => {
  const value = await fixture();
  try {
    const first = createPostMergeRetry(value.store, request(value.store, 77, 10));
    assert.equal(first.outcome, "created");
    // Before the worker ran, delivery sees the same run again.
    assert.equal(createPostMergeRetry(value.store, { ...request(value.store, 77, 11), attempt: latest(value.store) }).outcome, "already_created");
    for (let index = 1; index < MAX_POST_MERGE_RETRIES; index += 1) {
      const running = latest(value.store);
      const done = transitionAttempt(running as never, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha(String(index)), currentCommit: sha(String(index)) }, at(20 + index));
      if (!done.ok || value.store.attempts.update(done.value, "running").outcome !== "success") throw new Error("finish failed");
      assert.equal(createPostMergeRetry(value.store, request(value.store, 77 + index, 30 + index)).outcome, "created");
    }
    const running = latest(value.store);
    const done = transitionAttempt(running as never, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha("9"), currentCommit: sha("9") }, at(50));
    if (!done.ok || value.store.attempts.update(done.value, "running").outcome !== "success") throw new Error("finish failed");
    const stopped = createPostMergeRetry(value.store, request(value.store, 99, 60));
    assert.equal(stopped.outcome, "limit_reached", stopped.message);
  } finally { await dispose(value); }
});
