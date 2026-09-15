import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_INPUT_SCHEMA_VERSION,
  createCheckpoint,
  createClaudeCodeInput,
  createTask,
  serializeClaudeCodeInput,
  startInitialAttempt,
  validateClaudeCodeInput,
  type AttemptId,
  type Checkpoint,
  type CheckpointInput,
  type ResumeContext,
  type TaskId,
  type UtcTimestamp,
  type WorkerExecutionLimits,
  type WorkerRepositoryScope,
  type WorkerWorkspaceScope,
} from "../src/index.js";

const t0 = "2026-09-15T14:00:00.000Z" as UtcTimestamp;
const taskId = "claude-input-task" as TaskId;
const attemptOne = "claude-input-attempt-1" as AttemptId;
const attemptTwo = "claude-input-attempt-2" as AttemptId;
const repository: WorkerRepositoryScope = { owner: "PiotrGry", repository: "ai-assistant" };
const workspace: WorkerWorkspaceScope = { branch: "pirx/claude-input", worktree: "/tmp/pirx-claude-input" };
const limits: WorkerExecutionLimits = { timeoutMs: 30_000, maxOutputBytes: 10_000, maxErrorBytes: 10_000 };

function baseInput() {
  const task = createTask({ id: taskId, goal: "Prepare bounded provider input", scope: "Claude Code execution", acceptanceCriteria: ["identity", "bounded output"], priority: 1, risk: "low", requiredCapabilities: ["repository.read", "tests.run"], createdAt: t0 });
  if (!task.ok) throw new Error(task.error.message);
  const attempt = startInitialAttempt(task.value, [], { id: attemptOne, worker: "claude-worker", provider: "claude-code", branch: workspace.branch, worktree: workspace.worktree }, t0);
  if (!attempt.ok) throw new Error(attempt.error.message);
  return {
    task: attempt.value.task,
    attempt: attempt.value.attempt,
    workerId: "claude-worker",
    provider: "claude-code",
    repository,
    workspace,
    capabilityGrant: { grantedCapabilities: ["repository.read", "tests.run"], resourceScope: { repository: "PiotrGry/ai-assistant", branch: workspace.branch, worktree: workspace.worktree } },
    correlationId: "claude-input-correlation",
    limits,
    mode: "new" as const,
  };
}

function checkpoint(): { value: Checkpoint; context: ResumeContext } {
  const created = createCheckpoint({
    id: "claude-input-checkpoint" as CheckpointInput["id"], taskId, previousAttemptId: attemptOne, trigger: "RECOVERABLE_FAILURE", createdAt: t0,
    goal: "Prepare bounded provider input", currentState: "failed", repository: "PiotrGry/ai-assistant", branch: workspace.branch, worktree: workspace.worktree, currentCommit: "abc123",
    completedWork: ["prepared"], remainingWork: ["continue safely"], changedFiles: ["src/worker.ts"], findings: ["provider-independent"], hypotheses: ["resume is safe"], tests: [{ command: "pnpm test", result: "failed" }], evidence: [{ reference: "test://failure", summary: "bounded failure" }], blockingReason: "provider stopped", lastAction: "saved checkpoint", resumeInstruction: "continue from the remaining work",
  });
  if (!created.ok) throw new Error(created.violations[0]?.message ?? "checkpoint fixture failed");
  return {
    value: created.value,
    context: {
      kind: "resume_context", schemaVersion: 1, taskId, previousAttemptId: attemptOne, checkpointId: created.value.id, goal: created.value.goal, currentState: created.value.currentState,
      completedWork: created.value.completedWork, remainingWork: created.value.remainingWork, repository: created.value.repository!, branch: created.value.branch!, worktree: created.value.worktree!, currentCommit: created.value.currentCommit!,
      changedFiles: created.value.changedFiles, findings: created.value.findings, hypotheses: created.value.hypotheses, tests: created.value.tests, evidence: created.value.evidence, ...(created.value.blockingReason === undefined ? {} : { blockingReason: created.value.blockingReason }), lastAction: created.value.lastAction, resumeInstruction: created.value.resumeInstruction, truncatedFields: [],
    },
  };
}

test("builds deterministic bounded new and resumed envelopes from Task/Attempt state", () => {
  const fresh = baseInput();
  const first = createClaudeCodeInput(fresh);
  const second = createClaudeCodeInput(fresh);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  if (!first.ok) return;
  assert.equal(first.value.mode, "new");
  assert.equal(first.value.responseContract.schemaVersion, 1);
  assert.equal(first.value.taskId, taskId);
  assert.equal(first.value.attemptId, attemptOne);
  assert.equal("resume" in first.value, false);
  const saved = checkpoint();
  const resumedAttempt = { ...fresh.attempt, id: attemptTwo, ordinal: 2, predecessorAttemptId: attemptOne };
  const resumed = createClaudeCodeInput({ ...fresh, task: fresh.task, attempt: resumedAttempt, mode: "resume", resumeContext: saved.context, latestCheckpoint: saved.value });
  assert.equal(resumed.ok, true);
  if (resumed.ok) {
    assert.equal(resumed.value.mode, "resume");
    assert.equal(resumed.value.resume?.previousAttemptId, attemptOne);
    assert.equal(resumed.value.resume?.remainingWork[0], "continue safely");
    assert.equal(resumed.value.resume?.tests[0]?.result, "failed");
    assert.equal(resumed.value.resume?.currentCommit, "abc123");
  }
});

test("round-trips output and deterministically truncates optional resume data while preserving required data", () => {
  const fresh = baseInput();
  const saved = checkpoint();
  const resumedAttempt = { ...fresh.attempt, id: attemptTwo, ordinal: 2, predecessorAttemptId: attemptOne };
  const largeContext: ResumeContext = { ...saved.context, findings: Array.from({ length: 60 }, (_, index) => `finding-${index}`), hypotheses: Array.from({ length: 60 }, (_, index) => `hypothesis-${index}`), completedWork: Array.from({ length: 60 }, (_, index) => `done-${index}`), changedFiles: Array.from({ length: 60 }, (_, index) => `src/file-${index}.ts`) };
  const result = createClaudeCodeInput({ ...fresh, attempt: resumedAttempt, mode: "resume", resumeContext: largeContext, latestCheckpoint: saved.value });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.resume?.remainingWork[0], "continue safely");
  assert.equal(result.value.resume?.tests[0]?.result, "failed");
  assert.equal(result.value.resume?.truncatedFields.includes("findings"), true);
  assert.equal(new TextEncoder().encode(serializeClaudeCodeInput(result.value)).byteLength <= 16_000, true);
  const parsed = validateClaudeCodeInput(JSON.parse(serializeClaudeCodeInput(result.value)));
  assert.equal(parsed.ok, true);
});

test("rejects stale or mismatched Task, Attempt, checkpoint, workspace, capability, mode, and version data", () => {
  const fresh = baseInput();
  const saved = checkpoint();
  const resumedAttempt = { ...fresh.attempt, id: attemptTwo, ordinal: 2, predecessorAttemptId: attemptOne };
  const valid = { ...fresh, attempt: resumedAttempt, mode: "resume" as const, resumeContext: saved.context, latestCheckpoint: saved.value };
  assert.equal(createClaudeCodeInput({ ...valid, resumeContext: { ...saved.context, taskId: "other-task" as TaskId } }).ok, false);
  assert.equal(createClaudeCodeInput({ ...valid, latestCheckpoint: { ...saved.value, previousAttemptId: "other-attempt" as AttemptId } }).ok, false);
  assert.equal(createClaudeCodeInput({ ...valid, attempt: { ...resumedAttempt, predecessorAttemptId: "other-attempt" as AttemptId } }).ok, false);
  assert.equal(createClaudeCodeInput({ ...valid, workspace: { ...workspace, branch: "other-branch" } }).ok, false);
  assert.equal(createClaudeCodeInput({ ...valid, capabilityGrant: { ...fresh.capabilityGrant, grantedCapabilities: ["repository.read"] } }).ok, false);
  assert.equal(createClaudeCodeInput({ ...fresh, mode: "unknown" as "new" }).ok, false);
  assert.equal(validateClaudeCodeInput({ kind: "claude_code_input", schemaVersion: CLAUDE_INPUT_SCHEMA_VERSION + 1 }).ok, false);
  assert.equal(createClaudeCodeInput({ ...valid, resumeContext: { ...saved.context, remainingWork: Array.from({ length: 51 }, () => "required") } }).ok, false);
});

test("keeps secret-shaped fields and raw provider/history data out of the envelope", () => {
  const fresh = baseInput();
  const saved = checkpoint();
  const resumedAttempt = { ...fresh.attempt, id: attemptTwo, ordinal: 2, predecessorAttemptId: attemptOne };
  const result = createClaudeCodeInput({ ...fresh, attempt: resumedAttempt, mode: "resume", resumeContext: { ...saved.context, resumeInstruction: "token=do-not-forward" }, latestCheckpoint: saved.value });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(JSON.stringify(result).includes("do-not-forward"), false);
  const malformed = validateClaudeCodeInput({ kind: "claude_code_input", schemaVersion: 1, promptHistory: "raw chat", secret: "hidden" });
  assert.equal(malformed.ok, false);
  assert.equal(JSON.stringify(malformed).includes("hidden"), false);
});
