import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { RuntimeSqliteStore, createTask, startInitialAttempt, transitionAttempt, type AttemptId, type TaskId, type UtcTimestamp } from "../src/index.js";
import { BRANCH_SYNC_PROVIDER, FeatureBranchSyncService, MAX_CONSECUTIVE_BRANCH_SYNCS } from "../src/runtime/feature-branch-sync.js";

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } }).trim();
const taskId = "sync-task" as TaskId;
const attempt1 = "sync-attempt-1" as AttemptId;
const branch = "pirx/task-sync";
const t0 = "2026-11-15T10:00:00.000Z" as UtcTimestamp;
const at = (minutes: number): UtcTimestamp => new Date(Date.parse(t0) + minutes * 60_000).toISOString() as UtcTimestamp;

interface Fixture { readonly root: string; readonly remote: string; readonly seed: string; readonly worktree: string; readonly store: RuntimeSqliteStore; readonly workerCommit: string }

/** develop and a Task branch with one worker commit, then develop moves on: the PR is behind. */
async function fixture(options: { readonly conflicting?: boolean } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pirx-branch-sync-")));
  const remote = join(root, "remote.git"); const seed = join(root, "seed"); const worktree = join(root, "worktree");
  git(root, "init", "-q", "--bare", "-b", "develop", remote);
  git(root, "init", "-q", "-b", "develop", seed); git(seed, "remote", "add", "origin", remote);
  await writeFile(join(seed, "shared.txt"), "base\n"); git(seed, "add", "."); git(seed, "commit", "-q", "-m", "base"); git(seed, "push", "-q", "origin", "develop");
  git(root, "clone", "-q", "-b", "develop", remote, worktree);
  // Pirx's git runner keeps only HOME and PATH, so the merge identity comes from the worktree's own config.
  git(worktree, "config", "user.name", "Pirx"); git(worktree, "config", "user.email", "pirx@localhost");
  git(worktree, "checkout", "-q", "-b", branch);
  await writeFile(join(worktree, options.conflicting === true ? "shared.txt" : "feature.txt"), "worker change\n"); git(worktree, "add", "."); git(worktree, "commit", "-q", "-m", "worker");
  git(worktree, "push", "-q", "origin", branch);
  const workerCommit = git(worktree, "rev-parse", "HEAD");
  await writeFile(join(seed, "shared.txt"), "develop moved\n"); git(seed, "commit", "-q", "-am", "develop moves"); git(seed, "push", "-q", "origin", "develop");

  const store = RuntimeSqliteStore.open({ filename: join(root, "runtime.sqlite") });
  const task = createTask({ id: taskId, githubReference: { owner: "PiotrGry", repository: "zdrovena", issueNumber: 7, nodeId: "issue-7", url: "https://github.com/PiotrGry/zdrovena/issues/7" }, goal: "Sync", scope: "delivery", acceptanceCriteria: ["mergeable"], priority: 1, risk: "low", requiredCapabilities: ["repository.write"], createdAt: t0 });
  if (!task.ok || store.tasks.create(task.value).outcome !== "success") throw new Error("task fixture failed");
  const started = startInitialAttempt(task.value, [], { id: attempt1, worker: "pepus-claude", provider: "claude-code", branch, worktree }, t0);
  if (!started.ok || store.tasks.update(started.value.task, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome !== "success" || store.attempts.create(started.value.attempt).outcome !== "success") throw new Error("attempt fixture failed");
  const claimed = store.workspaces.claim({ taskId, attemptId: attempt1, repository: "PiotrGry/zdrovena", repositoryRoot: seed, assignedBranch: branch, worktreePath: worktree, expectedBaseRevision: git(seed, "rev-parse", "HEAD~1"), acquiredAt: t0 });
  if (claimed.outcome !== "success") throw new Error(claimed.message);
  const moved = store.workspaces.updateCurrentRevision(attempt1, claimed.value.ownershipToken, claimed.value.version, workerCommit, at(1));
  if (moved.outcome !== "success") throw new Error(moved.message);
  const finished = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: workerCommit, currentCommit: workerCommit }, at(1));
  if (!finished.ok || store.attempts.update(finished.value, "running").outcome !== "success") throw new Error("terminal fixture failed");
  return { root, remote, seed, worktree, store, workerCommit };
}
async function dispose(value: Fixture): Promise<void> { try { value.store.close(); } finally { await rm(value.root, { recursive: true, force: true }); } }
const request = (attemptId: AttemptId, minutes: number) => ({ taskId, attemptId, remoteName: "origin", baseBranch: "develop", now: at(minutes) });

test("Pirx merges develop into a behind branch, pushes it, and records the merge as the next CODE_PUSHED Attempt", async () => {
  const value = await fixture();
  try {
    const synced = await new FeatureBranchSyncService(value.store).sync(request(attempt1, 5));
    assert.equal(synced.outcome, "synced", JSON.stringify(synced));
    const merge = git(value.worktree, "rev-parse", "HEAD");
    assert.equal(synced.commit, merge);
    // The merge commit has the worker commit and the current develop as parents, and is what the remote branch points at.
    assert.deepEqual(git(value.worktree, "rev-list", "--parents", "-n", "1", merge).split(" ").slice(1), [value.workerCommit, git(value.seed, "rev-parse", "HEAD")]);
    assert.equal(git(value.remote, "rev-parse", `refs/heads/${branch}`), merge);
    const history = value.store.attempts.listByTask(taskId);
    const latest = history.outcome === "success" ? history.value.at(-1) : undefined;
    assert.equal(latest?.id, synced.successorAttemptId);
    assert.equal(latest?.provider, BRANCH_SYNC_PROVIDER);
    assert.equal(latest?.predecessorAttemptId, attempt1);
    assert.equal(latest?.state === "terminal" ? `${latest.result}:${latest.finalCommit}` : "running", `CODE_PUSHED:${merge}`);
    // Workspace ownership moves with it, so a later retry worker resumes from the merge commit.
    const ownership = value.store.workspaces.getByTask(taskId);
    assert.equal(ownership.outcome === "success" ? `${ownership.value.attemptId}:${ownership.value.currentRevision}` : "missing", `${synced.successorAttemptId}:${merge}`);
    const task = value.store.tasks.get(taskId);
    assert.equal(task.outcome === "success" ? task.value.state : "missing", "in_progress");
  } finally { await dispose(value); }
});

test("a merge conflict leaves the worktree as it was and names the files", async () => {
  const value = await fixture({ conflicting: true });
  try {
    const synced = await new FeatureBranchSyncService(value.store).sync(request(attempt1, 5));
    assert.equal(synced.outcome, "conflict", JSON.stringify(synced));
    assert.deepEqual(synced.conflictedFiles, ["shared.txt"]);
    assert.equal(git(value.worktree, "rev-parse", "HEAD"), value.workerCommit);
    assert.equal(git(value.worktree, "status", "--porcelain"), "");
    const history = value.store.attempts.listByTask(taskId);
    assert.equal(history.outcome === "success" ? history.value.length : 0, 1);
  } finally { await dispose(value); }
});

test("a merge made before a crash is pushed and recorded, not merged twice", async () => {
  const value = await fixture();
  try {
    git(value.worktree, "fetch", "-q", "origin", "develop");
    git(value.worktree, "merge", "-q", "--no-ff", "--no-edit", "FETCH_HEAD");
    const merge = git(value.worktree, "rev-parse", "HEAD");
    const synced = await new FeatureBranchSyncService(value.store).sync(request(attempt1, 5));
    assert.equal(synced.outcome, "synced", JSON.stringify(synced));
    assert.equal(synced.commit, merge);
    assert.equal(git(value.remote, "rev-parse", `refs/heads/${branch}`), merge);
  } finally { await dispose(value); }
});

test("a branch that already contains develop is not merged again", async () => {
  const value = await fixture();
  try {
    const first = await new FeatureBranchSyncService(value.store).sync(request(attempt1, 5));
    assert.equal(first.outcome, "synced");
    const again = await new FeatureBranchSyncService(value.store).sync(request(first.successorAttemptId!, 6));
    assert.equal(again.outcome, "retryable", JSON.stringify(again));
    assert.match(again.message, /already contains develop/u);
    const history = value.store.attempts.listByTask(taskId);
    assert.equal(history.outcome === "success" ? history.value.length : 0, 2);
  } finally { await dispose(value); }
});

test("a pre-push gate that refuses the merge is a rejection, and nothing is recorded", async () => {
  const value = await fixture();
  try {
    // Real gates print pages of noise first and the decisive line last; delivery keeps only 256 characters.
    const noise = "WARNING:cachecontrol.controller:Cache entry deserialization failed, entry ignored\\n".repeat(40);
    await writeFile(join(value.worktree, ".git", "hooks", "pre-push"), `#!/bin/sh\nprintf '${noise}'\nprintf '\\033[0;31m✗\\033[0m pip-audit: vulnerabilities found\\n'\nexit 1\n`, { mode: 0o755 });
    const synced = await new FeatureBranchSyncService(value.store).sync(request(attempt1, 5));
    assert.equal(synced.outcome, "rejected", JSON.stringify(synced));
    assert.match(synced.message.slice(0, 256), /✗ pip-audit: vulnerabilities found/u);
    assert.equal(git(value.remote, "rev-parse", `refs/heads/${branch}`), value.workerCommit);
    const history = value.store.attempts.listByTask(taskId);
    assert.equal(history.outcome === "success" ? history.value.length : 0, 1);
  } finally { await dispose(value); }
});

test("a base that keeps moving stops after a bounded number of syncs", async () => {
  const value = await fixture();
  try {
    const service = new FeatureBranchSyncService(value.store);
    let attemptId = attempt1;
    for (let index = 0; index < MAX_CONSECUTIVE_BRANCH_SYNCS; index += 1) {
      const synced = await service.sync(request(attemptId, 5 + index));
      assert.equal(synced.outcome, "synced", JSON.stringify(synced));
      attemptId = synced.successorAttemptId!;
      await writeFile(join(value.seed, "shared.txt"), `develop moved ${index}\n`); git(value.seed, "commit", "-q", "-am", `develop ${index}`); git(value.seed, "push", "-q", "origin", "develop");
    }
    const stopped = await service.sync(request(attemptId, 20));
    assert.equal(stopped.outcome, "limit_reached", JSON.stringify(stopped));
  } finally { await dispose(value); }
});
