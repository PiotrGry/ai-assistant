import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { RuntimeSqliteStore, createTask, createWorkerRequest, isWorkerFailureError } from "../src/index.js";
import { ProductionClaudeWorker } from "../src/claude/production-worker.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

test("a code worker commits and Pirx pushes the reported commit with the worker's pull request text", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pirx-production-publish-")));
  const remote = join(root, "remote.git"); const worktree = join(root, "worktree"); const branch = "pirx/publish";
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", "-b", branch, worktree); git(worktree, "remote", "add", "origin", remote);
  await writeFile(join(worktree, "a.txt"), "base\n"); git(worktree, "add", "a.txt"); git(worktree, "commit", "-q", "-m", "base");
  const store = RuntimeSqliteStore.open({ filename: join(root, "runtime.sqlite") });
  const t0 = "2026-11-10T12:00:00.000Z" as never;
  const capabilities = ["repository.read", "repository.write", "git.commit", "git.push_assigned_branch"];
  try {
    const made = createTask({ id: "publish-task" as never, goal: "Publish", scope: "adapter", acceptanceCriteria: ["push"], priority: 1, risk: "low", requiredCapabilities: capabilities, createdAt: t0 });
    assert.equal(made.ok, true); if (!made.ok) return;
    assert.equal(store.tasks.create(made.value).outcome, "success");
    const started = store.startAttempt(made.value.id, { id: "publish-attempt-1" as never, worker: "worker", provider: "claude-code", branch, worktree }, t0);
    assert.equal(started.outcome, "success"); if (started.outcome !== "success") return;
    const request = createWorkerRequest({ task: started.value.task, attempt: started.value.attempt, workerId: "worker", provider: "claude-code", repository: { owner: "PiotrGry", repository: "ai-assistant" }, workspace: { branch, worktree }, capabilityGrant: { grantedCapabilities: capabilities, resourceScope: { repository: "PiotrGry/ai-assistant", branch, worktree } }, correlationId: "publish-correlation", limits: { timeoutMs: 60_000, maxOutputBytes: 16_384, maxErrorBytes: 16_384 } });
    assert.equal(request.ok, true); if (!request.ok) return;
    const worker = (commitChange: boolean, body = "## What\nFixed a: `<order token>-<n>`.\n\nMerge needs its own authorization.") => new ProductionClaudeWorker({ store, repositories: [{ repository: "PiotrGry/ai-assistant", repositoryRoot: root, remoteName: "origin", testCommands: [] }], runner: { async runStructured(input) {
      assert.ok(input.workerProfile!.disallowedTools.includes("Bash(git push *)"));
      if (commitChange) { await writeFile(join(worktree, "a.txt"), "fixed\n"); git(worktree, "commit", "-q", "-am", "fix"); }
      return { outcome: "success", requestId: input.requestId, durationMs: 1, exitCode: 0, structuredOutput: { kind: "worker_result", schemaVersion: 1, taskId: request.value.taskId, attemptId: request.value.attemptId, correlationId: request.value.correlationId, outcome: "CODE_COMMITTED", branch, finalCommit: git(worktree, "rev-parse", "--short", "HEAD"), pullRequestTitle: "fix: a", pullRequestBody: body } };
    } } });

    const result = await worker(true).execute(request.value, new AbortController().signal);
    assert.equal(result.outcome, "CODE_PUSHED");
    if (result.outcome !== "CODE_PUSHED") return;
    // gh-462 attempt 11 reported an abbreviated SHA; Pirx records the full one it pushed.
    assert.match(result.finalCommit, /^[0-9a-f]{40}$/u);
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), result.finalCommit);
    assert.equal(result.pullRequestTitle, "fix: a");
    // Prose that names "token" or "authorization" is not a secret (gh-462 attempt 9).
    assert.equal(result.pullRequestBody, "## What\nFixed a: `<order token>-<n>`.\n\nMerge needs its own authorization.");
    await assert.rejects(worker(false, "leaked token=abc123").execute(request.value, new AbortController().signal), (error: unknown) => isWorkerFailureError(error) && error.diagnostic.field === "secret_shaped_value");

    // A diverged remote is never overwritten; the push error reaches the diagnostic.
    git(worktree, "reset", "-q", "--hard", "HEAD~1"); await writeFile(join(worktree, "a.txt"), "other\n"); git(worktree, "commit", "-q", "-am", "other");
    await assert.rejects(worker(false).execute(request.value, new AbortController().signal), (error: unknown) => isWorkerFailureError(error) && error.diagnostic.code === "push_rejected" && /git push failed/u.test(error.diagnostic.providerMessage ?? ""));
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), result.finalCommit);

    // A pre-push gate that refuses the push (gh-462: pip-audit) blocks with the hook output, not git_state_mismatch.
    git(worktree, "reset", "-q", "--hard", result.finalCommit); await writeFile(join(worktree, "a.txt"), "hooked\n"); git(worktree, "commit", "-q", "-am", "hooked");
    await writeFile(join(worktree, ".git", "hooks", "pre-push"), "#!/bin/sh\necho 'pip-audit: vulnerabilities found'\nexit 1\n", { mode: 0o755 });
    await assert.rejects(worker(false).execute(request.value, new AbortController().signal), (error: unknown) => isWorkerFailureError(error) && error.diagnostic.code === "push_rejected" && /pip-audit: vulnerabilities found/u.test(error.diagnostic.providerMessage ?? ""));
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), result.finalCommit);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
