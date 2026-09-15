import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import test from "node:test";

import {
  GitWorkerStateVerifier,
  createTask,
  createWorkerRequest,
  startInitialAttempt,
  type WorkerRequest,
} from "../src/index.js";

const run = promisify(execFile);
const now = "2026-09-15T15:00:00.000Z" as never;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run("git", args, { cwd });
  return result.stdout.trim();
}

async function fixture(): Promise<{ readonly root: string; readonly worktree: string; readonly request: WorkerRequest; readonly policy: { readonly repositoryRoot: string; readonly assignedWorktree: string; readonly remoteName: string; readonly testCommands: readonly string[] } }> {
  const root = await mkdtemp(join("/tmp", "pirx-git-state-"));
  const repositoryRoot = join(root, "repository");
  const remote = join(root, "remote.git");
  const worktree = join(root, "worktree");
  await run("git", ["init", "--bare", remote]);
  await run("git", ["init", "-b", "develop", repositoryRoot]);
  await git(repositoryRoot, "config", "user.email", "pirx@example.invalid");
  await git(repositoryRoot, "config", "user.name", "Pirx Test");
  await writeFile(join(repositoryRoot, "README.md"), "fixture\n");
  await git(repositoryRoot, "add", "README.md");
  await git(repositoryRoot, "commit", "-m", "initial");
  await git(repositoryRoot, "remote", "add", "origin", remote);
  await git(repositoryRoot, "worktree", "add", "-b", "pirx/worker-profile", worktree, "HEAD");
  await git(worktree, "push", "origin", "HEAD:refs/heads/pirx/worker-profile");
  const task = createTask({ id: "git-state-task" as never, goal: "Verify worker Git state", scope: "assigned worktree", acceptanceCriteria: ["exact Git state"], priority: 1, risk: "low", requiredCapabilities: ["repository.write", "git.push_assigned_branch"], createdAt: now });
  if (!task.ok) throw new Error(task.error.message);
  const started = startInitialAttempt(task.value, [], { id: "git-state-attempt" as never, worker: "claude", provider: "claude-code", branch: "pirx/worker-profile", worktree }, now);
  if (!started.ok) throw new Error(started.error.message);
  const request = createWorkerRequest({ task: started.value.task, attempt: started.value.attempt, workerId: "claude", provider: "claude-code", repository: { owner: "PiotrGry", repository: "ai-assistant" }, workspace: { branch: "pirx/worker-profile", worktree }, capabilityGrant: { grantedCapabilities: ["repository.write", "git.push_assigned_branch"], resourceScope: { repository: "PiotrGry/ai-assistant", branch: "pirx/worker-profile", worktree } }, correlationId: "git-state-correlation", limits: { timeoutMs: 30_000, maxOutputBytes: 16_384, maxErrorBytes: 16_384 } });
  if (!request.ok) throw new Error(request.violations[0]?.message ?? "request failed");
  return { root, worktree, request: request.value, policy: { repositoryRoot, assignedWorktree: worktree, remoteName: "origin", testCommands: [] } };
}

test("accepts only a clean assigned branch whose local and remote heads match", async () => {
  const value = await fixture();
  try {
    const commit = await git(value.worktree, "rev-parse", "HEAD");
    const result = { kind: "worker_result" as const, schemaVersion: 1 as const, taskId: value.request.taskId, attemptId: value.request.attemptId, correlationId: value.request.correlationId, outcome: "CODE_PUSHED" as const, branch: value.request.workspace.branch, finalCommit: commit };
    const verifier = new GitWorkerStateVerifier();
    assert.deepEqual(await verifier.verify(value.request, result, value.policy), { ok: true, message: "Local and remote Git state match the assigned worker result." });
    await writeFile(join(value.worktree, "uncommitted.txt"), "must block\n");
    assert.equal((await verifier.verify(value.request, result, value.policy)).ok, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
