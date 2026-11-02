import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProductionRuntime, RuntimeSqliteStore, createTask, createWorkerFailureDiagnostic, type UtcTimestamp } from "../src/index.js";
import { ProductionClaudeWorker } from "../src/claude/production-worker.js";

const run = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, shell: false, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
}

test("full production cycle retries failed Claude through Lease and real workspace to verified CODE_PUSHED", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pirx-cycle-resume-")));
  const repositoryRoot = join(root, "repository");
  const remote = join(root, "origin.git");
  const worktrees = join(root, "worktrees");
  await mkdir(repositoryRoot); await mkdir(worktrees);
  const store = RuntimeSqliteStore.open({ filename: join(root, "runtime.sqlite") });
  let runtime: ProductionRuntime | undefined;
  try {
    await git(root, "init", "--bare", remote);
    await git(root, "init", "-b", "develop", repositoryRoot);
    await git(repositoryRoot, "config", "user.name", "Pirx Test");
    await git(repositoryRoot, "config", "user.email", "pirx-test@example.invalid");
    await writeFile(join(repositoryRoot, "tracked.txt"), "base\n");
    await git(repositoryRoot, "add", "tracked.txt"); await git(repositoryRoot, "commit", "-m", "base");
    const base = await git(repositoryRoot, "rev-parse", "HEAD");
    await git(repositoryRoot, "remote", "add", "origin", remote);
    await git(repositoryRoot, "push", "origin", "develop");
    let now = "2026-11-02T12:00:00.000Z" as UtcTimestamp;
    const capabilities = ["repository.read", "repository.write", "tests.run", "git.commit", "git.push_assigned_branch"];
    const made = createTask({ id: "cycle-resume-task" as never, githubReference: { owner: "PiotrGry", repository: "test" , issueNumber: 462 }, goal: "Repair fixture", scope: "temporary local repository", acceptanceCriteria: ["verified pushed commit"], priority: 1, risk: "low", requiredCapabilities: capabilities, createdAt: now });
    assert.equal(made.ok, true); if (!made.ok) return;
    assert.equal(store.tasks.create(made.value).outcome, "success");
    assert.equal(store.selection.synchronize({ taskId: made.value.id, queueOrder: 1, dependencyState: "known", blockers: [], synchronizedAt: now }).outcome, "success");
    let invocations = 0;
    const worker = new ProductionClaudeWorker({ store, repositories: [{ repository: "PiotrGry/test", repositoryRoot, remoteName: "origin", testCommands: [] }], runner: { async runStructured(input) {
      invocations++;
      const lease = store.leases.getActiveByTask(made.value.id);
      assert.equal(lease.outcome, "success");
      if (invocations === 1) return { outcome: "process_error", requestId: input.requestId, durationMs: 1, exitCode: 1, message: "fixture recoverable failure", diagnostic: createWorkerFailureDiagnostic("process_failure", { exitCode: 1 }) };
      assert.equal(invocations, 2);
      const envelope = JSON.parse(input.prompt.split("\n\n")[2]!) as { mode: string; taskId: string; attemptId: string; correlationId: string; workspace: { branch: string }; resume: { previousAttemptId: string } };
      assert.equal(envelope.mode, "resume");
      assert.equal(envelope.resume.previousAttemptId, "cycle-attempt-1");
      if (lease.outcome === "success") assert.equal(lease.value.attemptId, envelope.attemptId);
      await writeFile(join(input.cwd, "tracked.txt"), "fixed\n");
      await git(input.cwd, "add", "tracked.txt"); await git(input.cwd, "commit", "-m", "fixture repair");
      await git(input.cwd, "push", "origin", `HEAD:refs/heads/${envelope.workspace.branch}`);
      return { outcome: "success", requestId: input.requestId, durationMs: 1, exitCode: 0, structuredOutput: { kind: "worker_result", schemaVersion: 1, taskId: envelope.taskId, attemptId: envelope.attemptId, correlationId: envelope.correlationId, outcome: "CODE_PUSHED", branch: envelope.workspace.branch, finalCommit: await git(input.cwd, "rev-parse", "HEAD") } };
    } } });
    runtime = new ProductionRuntime(store, { workerId: "worker", provider: "claude-code", workerCapabilities: capabilities, repositories: [{ repository: "PiotrGry/test", repositoryRoot, baseBranch: "develop", baseRevision: base }], worktreeParent: worktrees, leaseDurationMs: 60_000, workerTimeoutMs: 5000, workerAdapters: { get: () => worker }, attemptIdFactory: (_task, ordinal) => `cycle-attempt-${ordinal}` as never, clock: { now: () => now } });
    now = "2026-11-02T12:01:00.000Z" as UtcTimestamp;
    assert.equal((await runtime.cycle()).outcome, "failed");
    now = "2026-11-02T12:02:00.000Z" as UtcTimestamp;
    const resumed = await runtime.cycle();
    assert.equal(resumed.outcome, "started", JSON.stringify({ resumed, history: store.attempts.listByTask(made.value.id) }));
    const attempts = store.attempts.listByTask(made.value.id);
    assert.equal(attempts.outcome, "success");
    if (attempts.outcome === "success") assert.deepEqual(attempts.value.map((attempt) => attempt.state === "terminal" ? attempt.result : "running"), ["FAILED", "CODE_PUSHED"]);
    assert.equal(store.leases.getActiveByTask(made.value.id).outcome, "not_found");
    assert.equal(await git(repositoryRoot, "rev-parse", "develop"), base);
    assert.equal((await runtime.cycle()).outcome, "idle");
    assert.equal(invocations, 2);
  } finally { if (runtime !== undefined) runtime.close(); else store.close(); await rm(root, { recursive: true, force: true }); }
});
