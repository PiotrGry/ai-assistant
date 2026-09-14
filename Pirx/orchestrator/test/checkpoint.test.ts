import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKPOINT_TRIGGERS,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  validateCheckpoint,
  type CheckpointInput,
  type TaskId,
  type AttemptId,
  type UtcTimestamp,
} from "../src/index.js";

const createdAt = "2026-09-14T17:00:00.000Z" as UtcTimestamp;

function input(overrides: Partial<CheckpointInput> = {}): CheckpointInput {
  return {
    id: "checkpoint-1" as CheckpointInput["id"],
    taskId: "task-1" as TaskId,
    previousAttemptId: "attempt-1" as AttemptId,
    trigger: "EXPLICIT_PAUSE",
    createdAt,
    goal: "Finish the runtime contract",
    currentState: "in_progress",
    completedWork: ["Validated the input"],
    remainingWork: ["Implement the next contract"],
    changedFiles: ["./src\\runtime\\checkpoint.ts", "src/runtime/checkpoint.ts"],
    findings: ["The domain is provider-independent"],
    hypotheses: ["The next Attempt can resume from this summary"],
    tests: [{ command: "pnpm test", result: "passed" }],
    evidence: [{ reference: "test://checkpoint-1", summary: "Contract test passed" }],
    lastAction: "Recorded the checkpoint",
    resumeInstruction: "Read this checkpoint and continue the remaining work",
    ...overrides,
  };
}

test("creates a minimal checkpoint and normalizes meaningful ordered content", () => {
  const result = createCheckpoint({
    id: "checkpoint-minimal" as CheckpointInput["id"],
    taskId: "task-minimal" as TaskId,
    previousAttemptId: "attempt-minimal" as AttemptId,
    trigger: "MACHINE_RESTART",
    createdAt,
    goal: "Resume safely",
    currentState: "in_progress",
    completedWork: [],
    remainingWork: ["Continue"],
    changedFiles: ["./src\\a.ts", "src/a.ts", "src/b.ts"],
    findings: ["one", "one"],
    hypotheses: [],
    tests: [],
    evidence: [],
    lastAction: "Stopped",
    resumeInstruction: "Continue from remaining work",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.schemaVersion, 1);
  assert.deepEqual(result.value.changedFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(result.value.findings, ["one"]);
  assert.equal(result.value.repository, undefined);
  assert.equal(Object.isFrozen(result.value), true);
});

test("accepts every trigger and preserves a complete workspace and evidence", () => {
  for (const trigger of CHECKPOINT_TRIGGERS) {
    const result = createCheckpoint({
      ...input(),
      trigger,
      repository: "PiotrGry/ai-assistant",
      branch: "task/checkpoint",
      worktree: "/tmp/pirx-task-checkpoint",
      currentCommit: "abc123",
      evidence: [
        { reference: "ci://run-1", summary: "success" },
        { reference: "ci://run-1", summary: "success" },
      ],
    });
    assert.equal(result.ok, true, trigger);
    if (result.ok) {
      assert.equal(result.value.trigger, trigger);
      assert.deepEqual(result.value.evidence, [{ reference: "ci://run-1", summary: "success" }]);
      assert.equal(result.value.currentCommit, "abc123");
    }
  }
});

test("rejects unsupported versions, malformed provider data, and forbidden secret fields", () => {
  const unsupported = validateCheckpoint({ kind: "checkpoint", schemaVersion: 2, ...input() });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.violations[0]?.code, "unsupported_version");

  const malformed = validateCheckpoint({ kind: "checkpoint", schemaVersion: 1, ...input(), remainingWork: [] });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.violations[0]?.field, "remainingWork");

  const secret = validateCheckpoint({ kind: "checkpoint", schemaVersion: 1, ...input(), providerToken: "must not persist" });
  assert.equal(secret.ok, false);
  if (!secret.ok) {
    assert.equal(secret.violations[0]?.code, "forbidden_field");
    assert.equal(secret.violations[0]?.field, "checkpoint.providerToken");
  }
});

test("enforces workspace combinations, safe relative changed files, and conflicting evidence", () => {
  const missingGitField = createCheckpoint({ ...input(), repository: "PiotrGry/ai-assistant" });
  assert.equal(missingGitField.ok, false);
  if (!missingGitField.ok) assert.equal(missingGitField.violations[0]?.field, "workspace");

  for (const changedFile of ["/etc/passwd", "../secrets.txt", "src/../../secrets.txt", "C:/secret.txt"]) {
    const unsafe = createCheckpoint({ ...input(), changedFiles: [changedFile] });
    assert.equal(unsafe.ok, false, changedFile);
    if (!unsafe.ok) assert.equal(unsafe.violations[0]?.code, "unsafe_path");
  }

  const conflict = createCheckpoint({
    ...input(),
    evidence: [
      { reference: "ci://run-1", summary: "success" },
      { reference: "ci://run-1", summary: "failed" },
    ],
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.violations[0]?.code, "conflicting_evidence");
});

test("enforces required content, explicit limits, and JSON round trip", () => {
  const emptyGoal = createCheckpoint({ ...input(), goal: "   " });
  assert.equal(emptyGoal.ok, false);
  const oversized = createCheckpoint({ ...input(), goal: "x".repeat(2_001) });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.violations[0]?.code, "limit_exceeded");

  const result = createCheckpoint(input());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const roundTrip = deserializeCheckpoint(serializeCheckpoint(result.value));
  assert.deepEqual(roundTrip, result);
  assert.equal(deserializeCheckpoint("not-json").ok, false);
});

test("rejects cyclic data instead of accepting a non-JSON checkpoint", () => {
  const cyclic: Record<string, unknown> = { kind: "checkpoint", schemaVersion: 1, ...input() };
  cyclic.self = cyclic;
  const result = validateCheckpoint(cyclic);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violations[0]?.code, "invalid_input");
});
