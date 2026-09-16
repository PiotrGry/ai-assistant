import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClaudeCodeWorkerProfile,
  buildClaudeWorkerArguments,
  buildWorkerResultSchema,
  createTask,
  createWorkerRequest,
  startInitialAttempt,
  type AttemptId,
  type TaskId,
  type UtcTimestamp,
  type WorkerRequest,
} from "../src/index.js";

const now = "2026-09-15T15:00:00.000Z" as UtcTimestamp;
const taskId = "worker-profile-task" as TaskId;
const branch = "pirx/worker-profile";
const worktree = "/tmp/pirx-worker-profile/worktree";
const policy = {
  repositoryRoot: "/tmp/pirx-worker-profile/repository",
  assignedWorktree: worktree,
  remoteName: "origin",
  testCommands: ["pnpm check", "npm test"],
  commitMessage: "Pirx: apply assigned repair",
};

function request(granted = ["repository.read", "repository.write", "tests.run", "git.commit", "git.push_assigned_branch"]): WorkerRequest {
  const task = createTask({ id: taskId, goal: "Perform one bounded repair", scope: "assigned worktree only", acceptanceCriteria: ["return a structured result"], priority: 1, risk: "low", requiredCapabilities: granted, createdAt: now });
  if (!task.ok) throw new Error(task.error.message);
  const started = startInitialAttempt(task.value, [], { id: "worker-profile-attempt" as AttemptId, worker: "claude", provider: "claude-code", branch, worktree }, now);
  if (!started.ok) throw new Error(started.error.message);
  const value = createWorkerRequest({ task: started.value.task, attempt: started.value.attempt, workerId: "claude", provider: "claude-code", repository: { owner: "PiotrGry", repository: "ai-assistant" }, workspace: { branch, worktree }, capabilityGrant: { grantedCapabilities: granted, resourceScope: { repository: "PiotrGry/ai-assistant", branch, worktree } }, correlationId: "worker-profile-correlation", limits: { timeoutMs: 30_000, maxOutputBytes: 16_384, maxErrorBytes: 16_384 } });
  if (!value.ok) throw new Error(value.violations[0]?.message ?? "request failed");
  return value.value;
}

test("maps the complete code-worker grant to a bounded Claude profile", () => {
  const value = buildClaudeCodeWorkerProfile(request(), policy);
  assert.equal(value.ok, true);
  if (!value.ok) return;
  assert.deepEqual(value.value.tools, ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
  assert.equal(value.value.permissionMode, "dontAsk");
  assert.equal(value.value.maxTurns, 16);
  assert.ok(value.value.allowedTools.includes("Bash(pnpm check)"));
  assert.ok(value.value.allowedTools.includes("Bash(git push origin HEAD:refs/heads/pirx/worker-profile)"));
  assert.ok(value.value.allowedTools.includes("Bash(git commit -m \"Pirx: apply assigned repair\")"));
  assert.ok(value.value.disallowedTools.includes("mcp__*"));
  assert.ok(value.value.disallowedTools.includes("Bash(git reset *)"));
  assert.equal(value.value.allowedTools.some((item) => item === "Bash"), false);
  const args = buildClaudeWorkerArguments("worker-profile-correlation", "bounded prompt", buildWorkerResultSchema(request()), value.value);
  assert.equal(args.includes("--permission-mode"), true);
  assert.equal(args.includes("dontAsk"), true);
  assert.equal(args.includes("bypassPermissions"), false);
  assert.equal(args.includes("--max-turns"), true);
  assert.equal(args[args.indexOf("--max-turns") + 1], "16");
});

test("allows an explicitly configured uv test command", () => {
  const result = buildClaudeCodeWorkerProfile(request(), { repositoryRoot: policy.repositoryRoot, assignedWorktree: worktree, remoteName: "origin", testCommands: ["uv run pytest tests/test_controlled.py -q"] });
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.value.allowedTools.includes("Bash(uv run pytest tests/test_controlled.py -q)"));
});

test("keeps the Claude response schema within the CLI-supported object subset", () => {
  const schema = buildWorkerResultSchema(request()) as { readonly required: readonly string[]; readonly properties: Record<string, unknown> };
  assert.equal(schema.required.includes("outcome"), true);
  assert.equal("branch" in schema.properties, true);
  assert.equal("finalCommit" in schema.properties, true);
  assert.equal("diagnostic" in schema.properties, true);
});

test("removing one capability removes only its corresponding authority", () => {
  const all = ["repository.read", "repository.write", "tests.run", "git.commit", "git.push_assigned_branch"] as const;
  for (const missing of all) {
    const value = buildClaudeCodeWorkerProfile(request(all.filter((item) => item !== missing)), policy);
    assert.equal(value.ok, true, missing);
    if (!value.ok) continue;
    if (missing === "repository.read") assert.deepEqual(value.value.tools.filter((item) => ["Read", "Glob", "Grep"].includes(item)), []);
    if (missing === "repository.write") assert.deepEqual(value.value.tools.filter((item) => ["Edit", "Write"].includes(item)), []);
    if (missing === "tests.run") assert.equal(value.value.allowedTools.some((item) => item.startsWith("Bash(pnpm") || item.startsWith("Bash(npm")), false);
    if (missing === "git.commit") assert.equal(value.value.allowedTools.some((item) => item.startsWith("Bash(git commit")), false);
    if (missing === "git.push_assigned_branch") assert.equal(value.value.allowedTools.some((item) => item.startsWith("Bash(git push")), false);
  }
});

test("fails before process construction for unknown capabilities and unsafe policy values", () => {
  assert.equal(buildClaudeCodeWorkerProfile(request(["repository.read", "unknown.capability"]), policy).ok, false);
  assert.equal(buildClaudeCodeWorkerProfile(request(), { ...policy, remoteName: "origin;evil" }).ok, false);
  assert.equal(buildClaudeCodeWorkerProfile(request(), { ...policy, testCommands: ["pnpm check && rm -rf /"] }).ok, false);
  assert.equal(buildClaudeCodeWorkerProfile(request(), { ...policy, assignedWorktree: "/tmp/other" }).ok, false);
  assert.equal(buildClaudeCodeWorkerProfile({ ...request(), workspace: { branch: "pirx/other;push", worktree } }, policy).ok, false);
});

test("keeps receipt tools disabled and uses the supported non-interactive permission mode", async () => {
  const { buildClaudeArguments } = await import("../src/index.js");
  const args = buildClaudeArguments("receipt");
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--max-turns") + 1], "1");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args.includes("--restricted"), false);
  assert.equal(args.includes("--permission-prompts"), false);
});
