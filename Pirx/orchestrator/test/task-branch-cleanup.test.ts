import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { RuntimeSqliteStore, WorkspaceProvisioner, createTask, transitionAttempt, transitionTask, type AttemptId, type TaskId, type UtcTimestamp } from "../src/index.js";
import { TaskBranchCleanup } from "../src/runtime/task-branch-cleanup.js";

const run = promisify(execFile);
const t0 = "2026-11-18T10:00:00.000Z" as UtcTimestamp;
const taskId = "branch-cleanup-task" as TaskId;
const attemptId = "branch-cleanup-attempt" as AttemptId;
const branch = "pirx/task-branch-cleanup";
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
async function git(cwd: string, ...args: string[]): Promise<string> { return (await run("git", args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0", ...identity } })).stdout.trim(); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }

interface Fixture { readonly root: string; readonly repository: string; readonly remote: string; readonly worktree: string; readonly head: string; readonly store: RuntimeSqliteStore }

/** A completed Task whose branch was pushed; `merged` says whether develop received it with a merge commit. */
async function fixture(merged: boolean): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pirx-branch-cleanup-"));
  const repository = join(root, "repository"); const remote = join(root, "remote.git"); const parent = join(root, "worktrees");
  await mkdir(repository); await mkdir(parent); await git(root, "init", "-q", "--bare", "-b", "develop", remote); await git(root, "init", "-q", "-b", "develop", repository);
  await writeFile(join(repository, "base.txt"), "base\n"); await git(repository, "add", "."); await git(repository, "commit", "-q", "-m", "base");
  await git(repository, "remote", "add", "origin", remote); await git(repository, "push", "-q", "origin", "develop");
  const base = await git(repository, "rev-parse", "HEAD");
  const store = RuntimeSqliteStore.open({ filename: join(root, "runtime.sqlite") });
  const created = createTask({ id: taskId, goal: "Clean up", scope: "branch", acceptanceCriteria: ["deleted"], priority: 1, risk: "low", requiredCapabilities: ["repository.write"], createdAt: t0 });
  if (!created.ok || store.tasks.create(created.value).outcome !== "success") throw new Error("task fixture failed");
  const worktree = join(parent, `pirx-${taskId}-${attemptId}`);
  const started = store.startAttempt(taskId, { id: attemptId, worker: "pirx", provider: "test", branch, worktree }, t0); if (started.outcome !== "success") throw new Error(started.message);
  const provisioned = await new WorkspaceProvisioner().provision({ taskId, attemptId, repositoryRoot: repository, assignedBranch: branch, expectedBaseRevision: base, worktreeParent: parent, timeoutMs: 5_000 });
  if (provisioned.binding === undefined) throw new Error(provisioned.message);
  const claimed = store.workspaces.claim({ taskId, attemptId, repository: "PiotrGry/zdrovena", repositoryRoot: provisioned.binding.repositoryRoot, assignedBranch: branch, worktreePath: provisioned.binding.worktreePath, expectedBaseRevision: base, acquiredAt: t0 });
  if (claimed.outcome !== "success") throw new Error(claimed.message);
  await writeFile(join(worktree, "fix.txt"), "fix\n"); await git(worktree, "add", "."); await git(worktree, "commit", "-q", "-m", "fix"); await git(worktree, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  const head = await git(worktree, "rev-parse", "HEAD");
  if (store.workspaces.updateCurrentRevision(attemptId, claimed.value.ownershipToken, claimed.value.version, head, t0).outcome !== "success") throw new Error("revision fixture failed");
  const finished = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: head }, t0);
  if (!finished.ok || store.attempts.update(finished.value, "running").outcome !== "success") throw new Error("attempt fixture failed");
  const task = store.tasks.get(taskId); const history = store.attempts.listByTask(taskId); if (task.outcome !== "success" || history.outcome !== "success") throw new Error("read failed");
  const done = transitionTask(task.value, "in_progress", { type: "complete", evidence: { attemptId, finalCommit: head, evidenceReference: "post-merge:test" }, attempts: history.value }, t0);
  if (!done.ok || store.tasks.update(done.value, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome !== "success") throw new Error("completion fixture failed");
  if (merged) {
    const merger = join(root, "merger"); await git(root, "clone", "-q", "-b", "develop", remote, merger);
    await git(merger, "merge", "-q", "--no-ff", "-m", "Merge pull request #1", `origin/${branch}`); await git(merger, "push", "-q", "origin", "develop");
  }
  return { root, repository, remote, worktree, head, store };
}
async function dispose(value: Fixture): Promise<void> { try { value.store.close(); } finally { await rm(value.root, { recursive: true, force: true }); } }
const request = { taskId, attemptId, remoteName: "origin", baseBranch: "develop", now: t0 };
const remoteBranch = async (value: Fixture) => git(value.repository, "ls-remote", "origin", `refs/heads/${branch}`);

test("a branch merged into develop is deleted on the remote and locally, with its worktree", async () => {
  const value = await fixture(true);
  try {
    const result = await new TaskBranchCleanup(value.store).cleanup(request);
    assert.equal(result.outcome, "deleted", result.message);
    assert.equal(await remoteBranch(value), "");
    assert.equal(await git(value.repository, "branch", "--list", branch), "");
    assert.equal(await exists(value.worktree), false);
  } finally { await dispose(value); }
});

test("a branch develop does not contain (a squash merge) is kept", async () => {
  const value = await fixture(false);
  try {
    const result = await new TaskBranchCleanup(value.store).cleanup(request);
    assert.equal(result.outcome, "kept_unmerged", result.message);
    assert.match(await remoteBranch(value), new RegExp(value.head, "u"));
    assert.notEqual(await git(value.repository, "branch", "--list", branch), "");
  } finally { await dispose(value); }
});

test("a remote branch someone moved after the merge is kept", async () => {
  const value = await fixture(true);
  try {
    const other = join(value.root, "other"); await git(value.root, "clone", "-q", "-b", branch, value.remote, other);
    await writeFile(join(other, "more.txt"), "more\n"); await git(other, "add", "."); await git(other, "commit", "-q", "-m", "more"); await git(other, "push", "-q", "origin", branch);
    const result = await new TaskBranchCleanup(value.store).cleanup(request);
    assert.notEqual(result.outcome, "deleted", result.message);
    assert.notEqual(await remoteBranch(value), "");
  } finally { await dispose(value); }
});
