import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  GitWorkspaceCommandRunner,
  RuntimeSqliteStore,
  WorkspaceResumeValidator,
  createTask,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
  type WorkspaceOwnershipRecord,
} from "../src/index.js";

const execFile = promisify(execFileCallback);
const now = "2026-09-15T13:00:00.000Z" as UtcTimestamp;
const later = "2026-09-15T13:01:00.000Z" as UtcTimestamp;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, maxBuffer: 32_768 });
  return result.stdout.trim();
}

interface Fixture {
  readonly directory: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly base: string;
  readonly store: RuntimeSqliteStore;
  readonly ownership: WorkspaceOwnershipRecord;
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-workspace-resume-test-"));
  const repositoryRoot = join(directory, "repository");
  const worktreePath = join(directory, "worktree");
  await execFile("git", ["init", repositoryRoot]);
  await git(repositoryRoot, "config", "user.email", "pirx@example.test");
  await git(repositoryRoot, "config", "user.name", "Pirx Test");
  await writeFile(join(repositoryRoot, "tracked.txt"), "base\n");
  await git(repositoryRoot, "add", "tracked.txt");
  await git(repositoryRoot, "commit", "-m", "base");
  const base = await git(repositoryRoot, "rev-parse", "HEAD");
  await git(repositoryRoot, "worktree", "add", "-b", "pirx/resume", worktreePath, base);
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  const task = createTask({ id: "resume-workspace-task" as TaskId, goal: "Validate a workspace", scope: "read-only resume validation", acceptanceCriteria: ["exact state"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: now });
  if (!task.ok) throw new Error(task.error.message);
  assert.equal(store.tasks.create(task.value).outcome, "success");
  const started = store.startAttempt(task.value.id, { id: "resume-workspace-attempt" as AttemptId, worker: "pirx", provider: "test", branch: "pirx/resume", worktree: worktreePath }, now);
  assert.equal(started.outcome, "success");
  const claimed = store.workspaces.claim({ taskId: task.value.id, attemptId: "resume-workspace-attempt" as AttemptId, repository: "local/repository", repositoryRoot, assignedBranch: "pirx/resume", worktreePath, expectedBaseRevision: base, acquiredAt: now });
  assert.equal(claimed.outcome, "success");
  if (claimed.outcome !== "success") throw new Error("ownership fixture failed");
  return { directory, repositoryRoot, worktreePath, base, store, ownership: claimed.value };
}

function request(value: Fixture, overrides: Partial<{ repositoryRoot: string; worktreePath: string; assignedBranch: string; expectedCurrentCommit: string; expectedOwnershipVersion: number }> = {}) {
  return { taskId: value.ownership.taskId, attemptId: value.ownership.attemptId, repository: value.ownership.repository, repositoryRoot: value.ownership.repositoryRoot, worktreePath: value.ownership.worktreePath, assignedBranch: value.ownership.assignedBranch, expectedCurrentCommit: value.ownership.currentRevision, expectedOwnershipVersion: value.ownership.version, ...overrides };
}

async function close(value: Fixture): Promise<void> {
  value.store.close();
  await rm(value.directory, { recursive: true, force: true });
}

test("allows only an exact clean workspace, is repeatable, and has no write side effects", async () => {
  const value = await fixture();
  try {
    const beforeHead = await git(value.repositoryRoot, "rev-parse", "HEAD");
    const beforeStatus = await git(value.repositoryRoot, "status", "--porcelain");
    const validator = new WorkspaceResumeValidator(value.store);
    const first = await validator.validate(request(value));
    const second = await validator.validate(request(value));
    assert.equal(first.outcome, "valid");
    assert.deepEqual(second, first);
    assert.equal(await git(value.repositoryRoot, "rev-parse", "HEAD"), beforeHead);
    assert.equal(await git(value.repositoryRoot, "status", "--porcelain"), beforeStatus);
    assert.equal(await git(value.worktreePath, "status", "--porcelain"), "");
  } finally { await close(value); }
});

test("returns explicit dirty, detached, missing, branch, commit, ownership, and stale outcomes", async () => {
  const dirty = await fixture();
  try {
    await writeFile(join(dirty.worktreePath, "untracked.txt"), "dirty\n");
    assert.equal((await new WorkspaceResumeValidator(dirty.store).validate(request(dirty))).outcome, "dirty");
  } finally { await close(dirty); }

  const detached = await fixture();
  try {
    await git(detached.worktreePath, "checkout", "--detach", detached.base);
    assert.equal((await new WorkspaceResumeValidator(detached.store).validate(request(detached))).outcome, "detached");
  } finally { await close(detached); }

  const missingWorktree = await fixture();
  try {
    await rm(missingWorktree.worktreePath, { recursive: true, force: true });
    assert.equal((await new WorkspaceResumeValidator(missingWorktree.store).validate(request(missingWorktree))).outcome, "missing_worktree");
  } finally { await close(missingWorktree); }

  const missingRepository = await fixture();
  try {
    await rm(missingRepository.repositoryRoot, { recursive: true, force: true });
    assert.equal((await new WorkspaceResumeValidator(missingRepository.store).validate(request(missingRepository))).outcome, "missing_repository");
  } finally { await close(missingRepository); }

  const ownership = await fixture();
  try {
    const validator = new WorkspaceResumeValidator(ownership.store);
    assert.equal((await validator.validate(request(ownership, { assignedBranch: "pirx/other" }))).outcome, "ownership_mismatch");
    assert.equal((await validator.validate(request(ownership, { expectedOwnershipVersion: 99 }))).outcome, "stale_record");
    assert.equal((await validator.validate(request(ownership, { expectedCurrentCommit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }))).outcome, "ownership_mismatch");
    assert.equal((await validator.validate(request(ownership, { worktreePath: "/tmp/missing-worktree" }))).outcome, "ownership_mismatch");
  } finally { await close(ownership); }

  const commit = await fixture();
  try {
    await writeFile(join(commit.worktreePath, "tracked.txt"), "changed\n");
    await git(commit.worktreePath, "add", "tracked.txt");
    await git(commit.worktreePath, "commit", "-m", "changed");
    assert.equal((await new WorkspaceResumeValidator(commit.store).validate(request(commit))).outcome, "commit_mismatch");
  } finally { await close(commit); }
});

test("distinguishes a diverged base and missing commit without attempting repair", async () => {
  const value = await fixture();
  try {
    await git(value.worktreePath, "commit", "--allow-empty", "-m", "branch change");
    const branchCommit = await git(value.worktreePath, "rev-parse", "HEAD");
    await git(value.repositoryRoot, "checkout", "-b", "pirx/unrelated");
    await writeFile(join(value.repositoryRoot, "unrelated.txt"), "unrelated\n");
    await git(value.repositoryRoot, "add", "unrelated.txt");
    await git(value.repositoryRoot, "commit", "-m", "unrelated");
    const unrelated = await git(value.repositoryRoot, "rev-parse", "HEAD");
    const moved = value.store.workspaces.updateCurrentRevision(value.ownership.attemptId, value.ownership.ownershipToken, value.ownership.version, branchCommit, later);
    assert.equal(moved.outcome, "success");
    if (moved.outcome !== "success") return;
    const divergedRequest = request(value, { expectedCurrentCommit: branchCommit, expectedOwnershipVersion: moved.value.version });
    const divergedValue = { ...divergedRequest };
    const raw = value.store.database;
    raw.prepare("UPDATE runtime_workspace_ownership SET expected_base_revision = ? WHERE attempt_id = ?").run(unrelated, value.ownership.attemptId);
    assert.equal((await new WorkspaceResumeValidator(value.store).validate(divergedValue)).outcome, "diverged");
  } finally { await close(value); }

  const missing = await fixture();
  try {
    const fake = { run: async (args: readonly string[], cwd: string) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { outcome: "success" as const, stdout: cwd, stderr: "", exitCode: 0 };
      if (args[0] === "worktree") return { outcome: "success" as const, stdout: `worktree ${missing.worktreePath}\nHEAD ${missing.base}\nbranch refs/heads/pirx/resume\n`, stderr: "", exitCode: 0 };
      if (args[0] === "symbolic-ref") return { outcome: "success" as const, stdout: "pirx/resume\n", stderr: "", exitCode: 0 };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { outcome: "success" as const, stdout: "\n", stderr: "", exitCode: 0 };
      return { outcome: "success" as const, stdout: "", stderr: "", exitCode: 0 };
    } } as unknown as GitWorkspaceCommandRunner;
    assert.equal((await new WorkspaceResumeValidator(missing.store, fake).validate(request(missing))).outcome, "missing_commit");
  } finally { await close(missing); }
});

test("maps cancellation, timeout, Git failure, unknown results, and invalid inputs without raw errors", async () => {
  const value = await fixture();
  try {
    const cancelled = new AbortController(); cancelled.abort();
    assert.equal((await new WorkspaceResumeValidator(value.store).validate({ ...request(value), signal: cancelled.signal })).outcome, "cancelled");
    const timeoutFake = { run: async () => ({ outcome: "timeout" as const, stdout: "", stderr: "token=secret", exitCode: null }) } as unknown as GitWorkspaceCommandRunner;
    const timed = await new WorkspaceResumeValidator(value.store, timeoutFake).validate(request(value));
    assert.equal(timed.outcome, "timeout");
    assert.equal(JSON.stringify(timed).includes("secret"), false);
    const failureFake = { run: async () => ({ outcome: "git_failure" as const, stdout: "", stderr: "Authorization: secret", exitCode: 2 }) } as unknown as GitWorkspaceCommandRunner;
    const failed = await new WorkspaceResumeValidator(value.store, failureFake).validate(request(value));
    assert.equal(failed.outcome, "git_failure");
    assert.equal(JSON.stringify(failed).includes("secret"), false);
    const unknownFake = { run: async () => ({ outcome: "unknown" as const, stdout: "", stderr: "", exitCode: null }) } as unknown as GitWorkspaceCommandRunner;
    assert.equal((await new WorkspaceResumeValidator(value.store, unknownFake).validate(request(value))).outcome, "unknown");
    assert.equal((await new WorkspaceResumeValidator(value.store).validate({ ...request(value), expectedOwnershipVersion: 0 })).outcome, "invalid_input");
  } finally { await close(value); }
});
