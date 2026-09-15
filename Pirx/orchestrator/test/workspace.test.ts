import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  WorkspaceProvisioner,
  GitWorkspaceCommandRunner,
  type AttemptId,
  type TaskId,
  type WorkspaceProvisionRequest,
} from "../src/index.js";

const run = promisify(execFile);
const taskId = "workspace-task" as TaskId;
const attemptId = "workspace-attempt" as AttemptId;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const value = await run("git", args, { cwd, shell: false, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" } });
  return value.stdout.trim();
}

interface Fixture { readonly root: string; readonly repository: string; readonly parent: string; readonly base: string; }
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pirx-workspace-test-"));
  const repository = join(root, "repository"); const parent = join(root, "worktrees");
  await mkdir(repository); await mkdir(parent);
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "pirx-test@example.invalid"); await git(repository, "config", "user.name", "Pirx Test");
  await writeFile(join(repository, "tracked.txt"), "base\n"); await git(repository, "add", "tracked.txt"); await git(repository, "commit", "-m", "base");
  return { root, repository, parent, base: await git(repository, "rev-parse", "HEAD") };
}
function request(value: Fixture, overrides: Partial<WorkspaceProvisionRequest> = {}): WorkspaceProvisionRequest {
  return { taskId, attemptId, repositoryRoot: value.repository, assignedBranch: "pirx/task/workspace", expectedBaseRevision: value.base, worktreeParent: value.parent, timeoutMs: 5_000, ...overrides };
}

test("creates one assigned branch and dedicated worktree from the exact base without changing primary checkout", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.repository, "untracked.txt"), "keep\n");
    const beforeHead = await git(value.repository, "rev-parse", "HEAD"); const beforeStatus = await git(value.repository, "status", "--porcelain");
    const provisioned = await new WorkspaceProvisioner().provision(request(value));
    assert.equal(provisioned.outcome, "created");
    assert.ok(provisioned.binding);
    assert.equal(provisioned.binding?.assignedBranch, "pirx/task/workspace");
    assert.equal(await git(value.repository, "rev-parse", "HEAD"), beforeHead);
    assert.equal(await git(value.repository, "status", "--porcelain"), beforeStatus);
    assert.equal(await git(provisioned.binding!.worktreePath, "branch", "--show-current"), "pirx/task/workspace");
    assert.equal(await git(provisioned.binding!.worktreePath, "rev-parse", "HEAD"), value.base);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("exact replay is a no-op and concurrent claims produce one creation", async () => {
  const value = await fixture();
  try {
    const provisioner = new WorkspaceProvisioner();
    const [first, second] = await Promise.all([provisioner.provision(request(value)), provisioner.provision(request(value))]);
    assert.deepEqual([first.outcome, second.outcome].sort(), ["created", "existing_compatible"]);
    assert.equal(first.binding?.worktreePath, second.binding?.worktreePath);
    const replay = await provisioner.provision(request(value));
    assert.equal(replay.outcome, "existing_compatible");
    assert.equal(replay.binding?.expectedBaseRevision, value.base);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("rejects existing branch or destination without matching ownership instead of adopting it", async () => {
  const value = await fixture();
  try {
    await git(value.repository, "branch", "pirx/task/workspace", value.base);
    const branchConflict = await new WorkspaceProvisioner().provision(request(value));
    assert.equal(branchConflict.outcome, "conflict");
    const other = fixture(); const otherValue = await other;
    try {
      const provisioner = new WorkspaceProvisioner();
      const created = await provisioner.provision(request(otherValue));
      assert.equal(created.outcome, "created");
      const destinationConflict = await new WorkspaceProvisioner().provision(request(otherValue, { assignedBranch: "pirx/task/other" }));
      assert.equal(destinationConflict.outcome, "conflict");
    } finally { await rm(otherValue.root, { recursive: true, force: true }); }
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("fails closed for invalid repository, revision, branch, and path inputs", async () => {
  const value = await fixture();
  try {
    const provisioner = new WorkspaceProvisioner();
    assert.equal((await provisioner.provision(request(value, { repositoryRoot: join(value.root, "missing") }))).outcome, "invalid_repository");
    assert.equal((await provisioner.provision(request(value, { expectedBaseRevision: "not-a-revision" }))).outcome, "invalid_revision");
    assert.equal((await provisioner.provision(request(value, { assignedBranch: "-unsafe" }))).outcome, "conflict");
    assert.equal((await provisioner.provision(request(value, { worktreeParent: value.repository }))).outcome, "conflict");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("normalizes cancellation and timeout without leaving a running child", async () => {
  const value = await fixture();
  const slow = join(value.root, "slow-git.js");
  const loud = join(value.root, "loud-git.js");
  await writeFile(slow, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 }); await chmod(slow, 0o755);
  await writeFile(loud, "#!/usr/bin/env node\nprocess.stdout.write(\"x\".repeat(20000));\nsetInterval(() => {}, 1000);\n", { mode: 0o755 }); await chmod(loud, 0o755);
  try {
    const controller = new AbortController(); controller.abort();
    assert.equal((await new WorkspaceProvisioner().provision(request(value, { signal: controller.signal }))).outcome, "cancelled");
    assert.equal((await new WorkspaceProvisioner(new GitWorkspaceCommandRunner({ executable: slow })).provision(request(value, { timeoutMs: 30 }))).outcome, "timeout");
    assert.equal((await new GitWorkspaceCommandRunner({ executable: loud }).run(["rev-parse", "--show-toplevel"], value.repository, 5_000)).outcome, "git_failure");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
