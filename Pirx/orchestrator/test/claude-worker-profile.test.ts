import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_CODE_WORKER_SETTINGS,
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

test("advisor uses only explicit MCP config and one permitted tool", () => {
  const config = JSON.stringify({ mcpServers: { pirx_advisor: { command: "node", args: ["advisor-cli.js", "runtime.sqlite", "task", "attempt"] } } });
  const profile = buildClaudeCodeWorkerProfile(request(), { ...policy, advisorConfig: config });
  assert.ok(profile.ok);
  assert.ok(!profile.value.disallowedTools.includes("mcp__*"));
  assert.ok(profile.value.allowedTools.includes("mcp__pirx_advisor__ask_pirx"));
  const args = buildClaudeWorkerArguments("request", "prompt", {}, profile.value);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--mcp-config") + 1], config);
});

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
  assert.deepEqual(value.value.tools, ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Edit", "Write", "Bash"]);
  assert.ok(value.value.allowedTools.includes("WebFetch"));
  assert.ok(value.value.allowedTools.includes("WebSearch"));
  assert.equal(value.value.disallowedTools.includes("WebFetch"), false);
  assert.equal(value.value.permissionMode, "dontAsk");
  assert.equal(value.value.maxTurns, undefined);
  assert.ok(value.value.allowedTools.includes("Bash(pnpm check)"));
  // Pirx pushes; the worker may not.
  assert.equal(value.value.allowedTools.some((item) => item.includes("git push") || item.includes(" push ")), false);
  assert.ok(value.value.disallowedTools.includes("Bash(git push *)"));
  assert.ok(value.value.allowedTools.includes("Bash(git status:*)"));
  assert.ok(value.value.allowedTools.includes("Bash(git diff:*)"));
  assert.ok(value.value.allowedTools.includes("Bash(git add:*)"));
  assert.ok(value.value.allowedTools.includes("Bash(git commit -m:*)"));
  assert.ok(value.value.allowedTools.includes("Bash(git rev-parse HEAD)"));
  assert.ok(value.value.allowedTools.includes(`Bash(git -C ${worktree} status:*)`));
  assert.ok(value.value.allowedTools.includes(`Bash(git -C ${worktree} commit -m:*)`));
  assert.ok(value.value.allowedTools.includes(`Bash(git -C ${worktree} rev-parse HEAD)`));
  assert.ok(value.value.disallowedTools.includes("mcp__*"));
  assert.ok(value.value.disallowedTools.includes("Bash(git reset *)"));
  assert.equal(value.value.allowedTools.some((item) => item === "Bash"), false);
  const args = buildClaudeWorkerArguments("worker-profile-correlation", "bounded prompt", buildWorkerResultSchema(request()), value.value);
  assert.equal(args[0], "--restricted");
  assert.equal(args.includes("--settings"), true);
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}"), CLAUDE_CODE_WORKER_SETTINGS);
  assert.equal(CLAUDE_CODE_WORKER_SETTINGS.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.equal(CLAUDE_CODE_WORKER_SETTINGS.permissions.blockWritesOutsideWorkingDirectories, true);
  assert.equal(CLAUDE_CODE_WORKER_SETTINGS.sandbox.enabled, true);
  assert.equal(CLAUDE_CODE_WORKER_SETTINGS.sandbox.allowUnsandboxedCommands, false);
  assert.equal(CLAUDE_CODE_WORKER_SETTINGS.sandbox.failIfUnavailable, true);
  assert.equal(args.includes("--permission-mode"), true);
  assert.equal(args.includes("dontAsk"), true);
  assert.equal(args.includes("bypassPermissions"), false);
  // No turn bound unless the repository configures a backstop.
  assert.equal(args.includes("--max-turns"), false);
  const bounded = buildClaudeCodeWorkerProfile(request(), { ...policy, maxTurns: 200 });
  assert.equal(bounded.ok, true);
  if (!bounded.ok) return;
  const boundedArgs = buildClaudeWorkerArguments("worker-profile-correlation", "bounded prompt", buildWorkerResultSchema(request()), bounded.value);
  assert.equal(boundedArgs[boundedArgs.indexOf("--max-turns") + 1], "200");
  assert.equal(args.filter((value) => value === "--allowedTools").length, 1);
  assert.equal(args.filter((value) => value === "--disallowedTools").length, 1);
  assert.match(args[args.indexOf("--allowedTools") + 1] ?? "", /Bash\(git status:\*\),Bash\(git diff:\*\)/u);
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
    if (missing === "repository.read") {
      assert.deepEqual(value.value.tools.filter((item) => ["Read", "Glob", "Grep", "WebFetch", "WebSearch"].includes(item)), []);
      assert.ok(value.value.disallowedTools.includes("WebFetch") && value.value.disallowedTools.includes("WebSearch"));
    }
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
  assert.equal(args[args.indexOf("--max-turns") + 1], "2");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args.includes("--restricted"), false);
  assert.equal(args.includes("--permission-prompts"), false);
});
