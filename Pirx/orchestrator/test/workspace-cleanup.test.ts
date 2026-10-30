import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  RuntimeSqliteStore,
  WorkspaceCleanupCoordinator,
  WorkspaceProvisioner,
  createTask,
  transitionAttempt,
  transitionTask,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
  type WorkspaceCleanupRequest,
} from "../src/index.js";

const run = promisify(execFile);
const t0 = "2026-10-30T10:00:00.000Z" as UtcTimestamp;
const t1 = "2026-10-30T10:01:00.000Z" as UtcTimestamp;
const t2 = "2026-10-30T10:02:00.000Z" as UtcTimestamp;
const t3 = "2026-10-30T10:03:00.000Z" as UtcTimestamp;
const t4 = "2026-10-30T10:04:00.000Z" as UtcTimestamp;
const taskId = "cleanup-task" as TaskId;
const attemptId = "cleanup-attempt" as AttemptId;
const branch = "pirx/cleanup/task";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const value = await run("git", args, { cwd, shell: false, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" } });
  return value.stdout.trim();
}

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly remote: string;
  readonly worktreeParent: string;
  readonly worktreePath: string;
  readonly base: string;
  readonly store: RuntimeSqliteStore;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pirx-workspace-cleanup-"));
  const repository = join(root, "repository"); const remote = join(root, "remote.git"); const worktreeParent = join(root, "worktrees");
  await mkdir(repository); await mkdir(worktreeParent); await git(root, "init", "--bare", remote); await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "pirx-test@example.invalid"); await git(repository, "config", "user.name", "Pirx Test");
  await writeFile(join(repository, "tracked.txt"), "base\n"); await git(repository, "add", "tracked.txt"); await git(repository, "commit", "-m", "base"); await git(repository, "remote", "add", "origin", remote); await git(repository, "push", "-u", "origin", "main");
  const base = await git(repository, "rev-parse", "HEAD"); const store = RuntimeSqliteStore.open({ filename: join(root, "runtime.sqlite") });
  const created = createTask({ id: taskId, goal: "Clean workspace", scope: "workspace", acceptanceCriteria: ["safe cleanup"], priority: 1, risk: "medium", requiredCapabilities: ["repository.write"], createdAt: t0 });
  if (!created.ok || store.tasks.create(created.value).outcome !== "success") throw new Error("Task fixture failed.");
  const worktreePath = join(worktreeParent, `pirx-${taskId}-${attemptId}`);
  const started = store.startAttempt(taskId, { id: attemptId, worker: "pirx", provider: "test", branch, worktree: worktreePath }, t1); if (started.outcome !== "success") throw new Error(started.message);
  const provisioned = await new WorkspaceProvisioner().provision({ taskId, attemptId, repositoryRoot: repository, assignedBranch: branch, expectedBaseRevision: base, worktreeParent, timeoutMs: 5_000 });
  if (provisioned.outcome !== "created" || provisioned.binding === undefined) throw new Error(provisioned.message);
  const claimed = store.workspaces.claim({ taskId, attemptId, repository: "PiotrGry/ai-assistant", repositoryRoot: provisioned.binding.repositoryRoot, assignedBranch: branch, worktreePath: provisioned.binding.worktreePath, expectedBaseRevision: provisioned.binding.expectedBaseRevision, acquiredAt: t1 });
  if (claimed.outcome !== "success") throw new Error(claimed.message);
  return { root, repository, remote, worktreeParent, worktreePath: provisioned.binding.worktreePath, base, store };
}

async function complete(value: Fixture): Promise<string> {
  await writeFile(join(value.worktreePath, "change.txt"), "completed\n"); await git(value.worktreePath, "add", "change.txt"); await git(value.worktreePath, "commit", "-m", "complete task");
  const revision = await git(value.worktreePath, "rev-parse", "HEAD"); await git(value.worktreePath, "push", "origin", `HEAD:refs/heads/${branch}`);
  const ownership = value.store.workspaces.getByTaskAttempt(taskId, attemptId); if (ownership.outcome !== "success") throw new Error(ownership.message);
  if (value.store.workspaces.updateCurrentRevision(attemptId, ownership.value.ownershipToken, ownership.value.version, revision, t2).outcome !== "success") throw new Error("Ownership revision update failed.");
  const attempt = value.store.attempts.get(attemptId); if (attempt.outcome !== "success") throw new Error(attempt.message);
  const terminal = transitionAttempt(attempt.value, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: revision }, t3); if (!terminal.ok || value.store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("Attempt completion failed.");
  const task = value.store.tasks.get(taskId); const history = value.store.attempts.listByTask(taskId); if (task.outcome !== "success" || history.outcome !== "success") throw new Error("Task completion evidence failed.");
  const completed = transitionTask(task.value, "in_progress", { type: "complete", evidence: { attemptId, finalCommit: revision, evidenceReference: "test:completed" }, attempts: history.value }, t4); if (!completed.ok || value.store.tasks.update(completed.value, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome !== "success") throw new Error("Task completion failed.");
  return revision;
}

function cleanupRequest(overrides: Partial<WorkspaceCleanupRequest> = {}): WorkspaceCleanupRequest { return { taskId, attemptId, disposition: "task_completed", remoteName: "origin", now: t4, timeoutMs: 5_000, ...overrides }; }
async function close(value: Fixture): Promise<void> { try { value.store.close(); } finally { await rm(value.root, { recursive: true, force: true }); } }
async function absent(path: string): Promise<boolean> { try { await stat(path); return false; } catch { return true; } }

test("removes only an exact clean pushed worktree, keeps its branch, and replays after restart", async () => {
  const value = await fixture(); const revision = await complete(value);
  try {
    const removed = await new WorkspaceCleanupCoordinator(value.store).cleanup(cleanupRequest()); assert.equal(removed.outcome, "removed"); assert.equal(removed.revision, revision); assert.equal(await absent(value.worktreePath), true);
    assert.equal(await git(value.repository, "rev-parse", branch), revision);
    const ownership = value.store.workspaces.getByTaskAttempt(taskId, attemptId); assert.equal(ownership.outcome, "success"); if (ownership.outcome === "success") assert.equal(ownership.value.state, "released");
    value.store.close(); const reopened = RuntimeSqliteStore.open({ filename: join(value.root, "runtime.sqlite") });
    try { assert.equal((await new WorkspaceCleanupCoordinator(reopened).cleanup(cleanupRequest())).outcome, "already_removed"); } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* closed for restart */ } await rm(value.root, { recursive: true, force: true }); }
});

test("preserves dirty and remotely diverged completed worktrees", async (context) => {
  await context.test("dirty", async () => {
    const value = await fixture(); await complete(value); await writeFile(join(value.worktreePath, "untracked.txt"), "preserve\n");
    try { assert.equal((await new WorkspaceCleanupCoordinator(value.store).cleanup(cleanupRequest())).outcome, "protected_dirty"); assert.equal(await absent(value.worktreePath), false); }
    finally { await close(value); }
  });
  await context.test("remote divergence", async () => {
    const value = await fixture(); await complete(value); await git(value.repository, "push", "--force", "origin", `${value.base}:refs/heads/${branch}`);
    try { assert.equal((await new WorkspaceCleanupCoordinator(value.store).cleanup(cleanupRequest())).outcome, "protected_diverged"); assert.equal(await absent(value.worktreePath), false); }
    finally { await close(value); }
  });
});

test("removes an explicitly cancelled unchanged workspace but protects abandoned commits", async (context) => {
  await context.test("unchanged cancellation", async () => {
    const value = await fixture(); const attempt = value.store.attempts.get(attemptId); if (attempt.outcome !== "success") throw new Error(attempt.message);
    const terminal = transitionAttempt(attempt.value, "running", { type: "finish", result: "CANCELLED", blockingReason: "abandoned" }, t2); if (!terminal.ok || value.store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("Attempt cancellation failed.");
    const task = value.store.tasks.get(taskId); if (task.outcome !== "success") throw new Error(task.message); const cancelled = transitionTask(task.value, "in_progress", { type: "cancel", reason: "abandoned" }, t3); if (!cancelled.ok || value.store.tasks.update(cancelled.value, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome !== "success") throw new Error("Task cancellation failed.");
    try { assert.equal((await new WorkspaceCleanupCoordinator(value.store).cleanup(cleanupRequest({ disposition: "attempt_abandoned" }))).outcome, "removed"); }
    finally { await close(value); }
  });
  await context.test("abandoned commit", async () => {
    const value = await fixture(); await writeFile(join(value.worktreePath, "local.txt"), "local\n"); await git(value.worktreePath, "add", "local.txt"); await git(value.worktreePath, "commit", "-m", "local only"); const revision = await git(value.worktreePath, "rev-parse", "HEAD");
    const ownership = value.store.workspaces.getByAttempt(attemptId); if (ownership.outcome !== "success") throw new Error(ownership.message); assert.equal(value.store.workspaces.updateCurrentRevision(attemptId, ownership.value.ownershipToken, ownership.value.version, revision, t2).outcome, "success");
    const attempt = value.store.attempts.get(attemptId); if (attempt.outcome !== "success") throw new Error(attempt.message); const terminal = transitionAttempt(attempt.value, "running", { type: "finish", result: "CANCELLED", blockingReason: "abandoned" }, t2); if (!terminal.ok) throw new Error(terminal.error.message); assert.equal(value.store.attempts.update(terminal.value, "running").outcome, "success");
    const task = value.store.tasks.get(taskId); if (task.outcome !== "success") throw new Error(task.message); const cancelled = transitionTask(task.value, "in_progress", { type: "cancel", reason: "abandoned" }, t3); if (!cancelled.ok) throw new Error(cancelled.error.message); assert.equal(value.store.tasks.update(cancelled.value, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome, "success");
    try { assert.equal((await new WorkspaceCleanupCoordinator(value.store).cleanup(cleanupRequest({ disposition: "attempt_abandoned" }))).outcome, "protected_diverged"); }
    finally { await close(value); }
  });
});

test("rejects running Attempts, invalid requests, and cancellation without mutation", async () => {
  const value = await fixture();
  try {
    const coordinator = new WorkspaceCleanupCoordinator(value.store); assert.equal((await coordinator.cleanup(cleanupRequest())).outcome, "not_eligible");
    assert.equal((await coordinator.cleanup(cleanupRequest({ remoteName: "unsafe remote" }))).outcome, "invalid_request");
    const controller = new AbortController(); controller.abort();
    const attempt = value.store.attempts.get(attemptId); if (attempt.outcome !== "success") throw new Error(attempt.message); const terminal = transitionAttempt(attempt.value, "running", { type: "finish", result: "CANCELLED", blockingReason: "abandoned" }, t2); if (!terminal.ok) throw new Error(terminal.error.message); assert.equal(value.store.attempts.update(terminal.value, "running").outcome, "success");
    const task = value.store.tasks.get(taskId); if (task.outcome !== "success") throw new Error(task.message); const cancelled = transitionTask(task.value, "in_progress", { type: "cancel", reason: "abandoned" }, t3); if (!cancelled.ok) throw new Error(cancelled.error.message); assert.equal(value.store.tasks.update(cancelled.value, { state: task.value.state, updatedAt: task.value.updatedAt }).outcome, "success");
    assert.equal((await coordinator.cleanup(cleanupRequest({ disposition: "attempt_abandoned", signal: controller.signal }))).outcome, "cancelled"); assert.equal(await absent(value.worktreePath), false);
  } finally { await close(value); }
});

test("serializes concurrent cleanup and never removes twice", async () => {
  const value = await fixture(); await complete(value);
  try { const coordinator = new WorkspaceCleanupCoordinator(value.store); const results = await Promise.all([coordinator.cleanup(cleanupRequest()), coordinator.cleanup(cleanupRequest())]); assert.deepEqual(results.map((item) => item.outcome), ["removed", "already_removed"]); }
  finally { await close(value); }
});
