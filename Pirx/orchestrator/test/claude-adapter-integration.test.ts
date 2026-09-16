import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CapabilityAwareWorkerExecutionPort,
  CapabilityEnforcementGate,
  ClaudeCodeCliRunner,
  ClaudeCodeProcessAdapter,
  createCheckpoint,
  createClaudeCodeInput,
  createTask,
  createWorkerRequest,
  startInitialAttempt,
  type ClaudeCodeInput,
  type ClaudeInputResult,
  type ClaudeSpawn,
  type Checkpoint,
  type CheckpointInput,
  type ResumeContext,
  type TaskId,
  type AttemptId,
  type TaskSnapshot,
  type RunningAttemptSnapshot,
  type UtcTimestamp,
  type WorkerRequest,
  type ClaudeStructuredRunner,
} from "../src/index.js";

const now = "2026-09-15T15:00:00.000Z" as UtcTimestamp;
const repository = { owner: "PiotrGry", repository: "ai-assistant" } as const;
const branch = "pirx/claude-integration";
const worktree = "/tmp/pirx-claude-integration";
const taskId = "claude-integration-task" as TaskId;
const attemptOne = "claude-integration-attempt-1" as AttemptId;
const attemptTwo = "claude-integration-attempt-2" as AttemptId;

const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.PIRX_FAKE_MODE || "success";
const args = process.argv.slice(2);
const prompt = args.find((value) => value.includes('"kind":"claude_code_input"')) || "{}";
const input = JSON.parse(prompt.split("\\n\\nFINAL RESPONSE:")[0]);
if (process.env.PIRX_CAPTURE_FILE) fs.writeFileSync(process.env.PIRX_CAPTURE_FILE, JSON.stringify({ cwd: process.cwd(), args, input }));
if (mode === "auth") { process.stderr.write("CLAUDE_AUTH_REQUIRED token=fixture-secret"); process.exit(1); }
if (mode === "quota") { process.stderr.write("CLAUDE_QUOTA_EXHAUSTED"); process.exit(1); }
if (mode === "malformed") { process.stdout.write("{not-json"); process.exit(0); }
if (mode === "missing") { process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false })); process.exit(0); }
if (mode === "envelope") { process.stdout.write(JSON.stringify({ type: "message", subtype: "success", is_error: false, structured_output: {} })); process.exit(0); }
if (mode === "invalid") { process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: "not-a-worker-result" })); process.exit(0); }
if (mode === "minimal-code-pushed") { process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { kind: "worker_result", schemaVersion: 1, taskId: input.taskId, attemptId: input.attemptId, correlationId: input.correlationId, outcome: "CODE_PUSHED" } })); process.exit(0); }
if (mode === "overflow") { process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000); }
if (mode === "hang") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
if (mode === "delay") { setTimeout(() => process.exit(0), 1000); }
else {
  const result = { kind: "worker_result", schemaVersion: 1, taskId: input.taskId, attemptId: input.attemptId, correlationId: input.correlationId, outcome: "CODE_PUSHED", branch: input.workspace.branch, finalCommit: "dddddddddddddddddddddddddddddddddddddddd" };
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: result }));
}
`;

interface Fixture { readonly root: string; readonly executable: string; readonly worktree: string; }

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pirx-claude-integration-"));
  const executable = join(root, "fake-claude.cjs");
  const assignedWorktree = join(root, "assigned-worktree");
  await mkdir(assignedWorktree);
  await writeFile(executable, fakeClaude, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable, worktree: assignedWorktree };
}

function taskAndAttempt(id: AttemptId, assignedWorktree = worktree): { readonly task: TaskSnapshot; readonly attempt: RunningAttemptSnapshot } {
  const task = createTask({ id: taskId, goal: "Run bounded Claude integration", scope: "local adapter test", acceptanceCriteria: ["structured worker result"], priority: 1, risk: "low", requiredCapabilities: ["repository.read", "tests.run"], createdAt: now });
  if (!task.ok) throw new Error(task.error.message);
  const started = startInitialAttempt(task.value, [], { id, worker: "claude-worker", provider: "claude-code", branch, worktree: assignedWorktree }, now);
  if (!started.ok) throw new Error(started.error.message);
  return { task: started.value.task, attempt: started.value.attempt };
}

function request(mode: "new" | "resume" = "new", assignedWorktree = worktree): WorkerRequest {
  const initial = taskAndAttempt(mode === "new" ? attemptOne : attemptOne, assignedWorktree);
  const attempt = mode === "new" ? initial.attempt : { ...initial.attempt, id: attemptTwo, ordinal: 2, predecessorAttemptId: attemptOne, checkpointReference: "claude-integration-checkpoint" as CheckpointInput["id"] };
  const created = createWorkerRequest({
    task: initial.task,
    attempt,
    workerId: "claude-worker",
    provider: "claude-code",
    repository,
    workspace: { branch, worktree: assignedWorktree },
    capabilityGrant: { grantedCapabilities: ["repository.read", "tests.run"], resourceScope: { repository: "PiotrGry/ai-assistant", branch, worktree: assignedWorktree } },
    correlationId: mode === "new" ? "claude-integration-new" : "claude-integration-resume",
    limits: { timeoutMs: 30_000, maxOutputBytes: 16_384, maxErrorBytes: 16_384 },
  });
  if (!created.ok) throw new Error(created.violations[0]?.message ?? "worker request fixture failed");
  return created.value;
}

function checkpointForResume(): { readonly value: Checkpoint; readonly context: ResumeContext } {
  const created = createCheckpoint({
    id: "claude-integration-checkpoint" as CheckpointInput["id"],
    taskId,
    previousAttemptId: attemptOne,
    trigger: "RECOVERABLE_FAILURE",
    createdAt: now,
    goal: "Run bounded Claude integration",
    currentState: "failed",
    repository: "PiotrGry/ai-assistant",
    branch,
    worktree,
    currentCommit: "abc123",
    completedWork: ["prepared"],
    remainingWork: ["continue safely"],
    changedFiles: ["test-only.ts"],
    findings: ["failure is controlled"],
    hypotheses: [],
    tests: [{ command: "pnpm check", result: "failed" }],
    evidence: [{ reference: "test://failure", summary: "bounded failure" }],
    lastAction: "saved checkpoint",
    resumeInstruction: "continue from remaining work",
  });
  if (!created.ok) throw new Error(created.violations[0]?.message ?? "checkpoint fixture failed");
  return { value: created.value, context: { kind: "resume_context", schemaVersion: 1, taskId, previousAttemptId: attemptOne, checkpointId: created.value.id, goal: created.value.goal, currentState: created.value.currentState, completedWork: created.value.completedWork, remainingWork: created.value.remainingWork, repository: created.value.repository!, branch: created.value.branch!, worktree: created.value.worktree!, currentCommit: created.value.currentCommit!, changedFiles: created.value.changedFiles, findings: created.value.findings, hypotheses: created.value.hypotheses, tests: created.value.tests, evidence: created.value.evidence, lastAction: created.value.lastAction, resumeInstruction: created.value.resumeInstruction, truncatedFields: [] } };
}

function inputFor(requestValue: WorkerRequest, mode: "new" | "resume"): ClaudeInputResult<ClaudeCodeInput> {
  const initial = taskAndAttempt(attemptOne, requestValue.workspace.worktree);
  const attempt = mode === "new" ? initial.attempt : { ...initial.attempt, id: requestValue.attemptId, ordinal: 2, predecessorAttemptId: attemptOne, checkpointReference: "claude-integration-checkpoint" as CheckpointInput["id"] };
  const resume = checkpointForResume();
  return createClaudeCodeInput({ task: initial.task, attempt, workerId: requestValue.workerId, provider: requestValue.provider, repository: requestValue.repository, workspace: requestValue.workspace, capabilityGrant: { grantedCapabilities: requestValue.capabilityGrant.grantedCapabilities, resourceScope: requestValue.capabilityGrant.resourceScope }, correlationId: requestValue.correlationId, limits: requestValue.limits, mode, ...(mode === "resume" ? { resumeContext: resume.context, latestCheckpoint: resume.value } : {}) });
}

async function adapter(fixtureValue: Fixture, mode: "new" | "resume", fakeMode = "success", captureFile?: string, observed?: { value?: { readonly cwd: string; readonly shell: false; readonly env: NodeJS.ProcessEnv } }): Promise<ClaudeCodeProcessAdapter> {
  const spawnProcess: ClaudeSpawn = (file, args, options): ChildProcess => {
    if (observed !== undefined) observed.value = { cwd: options.cwd, shell: options.shell, env: options.env };
    return spawn(file, [...args], options);
  };
  const runner = new ClaudeCodeCliRunner({ executable: fixtureValue.executable, environment: { PATH: process.env.PATH, HOME: process.env.HOME, PIRX_SECRET: "must-not-forward" }, additionalEnvironment: { PIRX_FAKE_MODE: fakeMode, ...(captureFile === undefined ? {} : { PIRX_CAPTURE_FILE: captureFile }) }, spawnProcess });
  return new ClaudeCodeProcessAdapter({ runner, inputSource: { create: (value) => inputFor(value, mode) }, promptRenderer: { render: (value) => JSON.stringify(value) } });
}

test("executes new and resumed input end to end through the capability-aware port", async () => {
  const value = await fixture();
  try {
    for (const mode of ["new", "resume"] as const) {
      const observed: { value?: { readonly cwd: string; readonly shell: false; readonly env: NodeJS.ProcessEnv } } = {};
      const processAdapter = await adapter(value, mode, "success", undefined, observed);
      const allowed = new CapabilityAwareWorkerExecutionPort(new CapabilityEnforcementGate({ record: () => undefined }), { get: () => processAdapter }, { now: () => now });
      const result = await allowed.execute(request(mode, value.worktree), new AbortController().signal);
      assert.equal(result.outcome, "allowed");
      if (result.outcome === "allowed") assert.equal(result.value.outcome, "CODE_PUSHED");
      assert.equal(observed.value?.cwd, value.worktree);
      assert.equal(observed.value?.shell, false);
      assert.equal(observed.value?.env.PIRX_SECRET, undefined);
    }
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("passes bounded process failures through the adapter without provider data", async () => {
  const value = await fixture();
  try {
    for (const [fakeMode, expected, code] of [["auth", "authentication_required", "authentication"], ["quota", "quota_exhausted", "quota_exhausted"], ["malformed", "invalid_output", "malformed_cli_envelope"], ["missing", "invalid_output", "missing_structured_output"], ["envelope", "invalid_output", "malformed_cli_envelope"], ["invalid", "invalid_output", "invalid_structured_output"]] as const) {
      const processAdapter = await adapter(value, "new", fakeMode);
      const result = await processAdapter.run(request("new", value.worktree), new AbortController().signal);
      assert.equal(result.outcome, expected);
      assert.equal("diagnostic" in result ? result.diagnostic.code : undefined, code);
      assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
    }
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("bounds timeout, cancellation, and output overflow using request limits", async () => {
  const value = await fixture();
  try {
    const timeoutAdapter = await adapter(value, "new", "hang");
    const timeoutRequest = { ...request("new", value.worktree), limits: { timeoutMs: 40, maxOutputBytes: 1_024, maxErrorBytes: 1_024 } };
    const timeout = await timeoutAdapter.run(timeoutRequest, new AbortController().signal);
    assert.equal(timeout.outcome, "timeout");
    assert.equal("diagnostic" in timeout ? timeout.diagnostic.code : undefined, "timeout");
    const cancelAdapter = await adapter(value, "new", "delay");
    const controller = new AbortController();
    const pending = cancelAdapter.run(request("new", value.worktree), controller.signal);
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal("diagnostic" in cancelled ? cancelled.diagnostic.code : undefined, "cancellation");
    const overflowAdapter = await adapter(value, "new", "overflow");
    const overflowRequest = { ...request("new", value.worktree), limits: { timeoutMs: 2_000, maxOutputBytes: 1_024, maxErrorBytes: 1_024 } };
    const overflow = await overflowAdapter.run(overflowRequest, new AbortController().signal);
    assert.equal(overflow.outcome, "invalid_output");
    assert.equal("diagnostic" in overflow ? overflow.diagnostic.code : undefined, "invalid_structured_output");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("rejects wrong workspace, branch, capability, and secret prompt before Claude starts", async () => {
  const value = await fixture();
  try {
    let calls = 0;
    const runner: ClaudeStructuredRunner = { runStructured: async () => { calls += 1; throw new Error("must not run"); } };
    const processAdapter = new ClaudeCodeProcessAdapter({ runner, inputSource: { create: (value) => { const built = inputFor(value, "new"); if (!built.ok) return built; return { ok: true, value: { ...built.value, workspace: { branch: "other", worktree: "/tmp/other" } } }; } }, promptRenderer: { render: () => "" } });
    const result = await processAdapter.run(request("new", value.worktree), new AbortController().signal);
    assert.equal(result.outcome, "invalid_input");
    assert.equal(calls, 0);
    const denied = new CapabilityAwareWorkerExecutionPort(new CapabilityEnforcementGate({ record: () => undefined }), { get: () => processAdapter }, { now: () => now });
    const noCapability = { ...request(), capabilityGrant: { ...request().capabilityGrant, requiredCapabilities: ["unknown.capability"] as readonly string[], grantedCapabilities: ["unknown.capability"] as readonly string[] } };
    assert.equal((await denied.execute(noCapability, new AbortController().signal)).outcome, "denied");
    assert.equal(calls, 0);
    const secretAdapter = new ClaudeCodeProcessAdapter({ runner, inputSource: { create: (value) => inputFor(value, "new") }, promptRenderer: { render: () => "token=fixture-secret" } });
    assert.equal((await secretAdapter.run(request(), new AbortController().signal)).outcome, "invalid_input");
    assert.equal(calls, 0);
    const privateKeyAdapter = new ClaudeCodeProcessAdapter({ runner, inputSource: { create: (value) => inputFor(value, "new") }, promptRenderer: { render: () => "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----" } });
    assert.equal((await privateKeyAdapter.run(request(), new AbortController().signal)).outcome, "invalid_input");
    assert.equal(calls, 0);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("allows sanitized repair policy prose and redacted evidence while blocking secret-shaped evidence", async () => {
  const value = await fixture();
  try {
    let calls = 0;
    const runner: ClaudeStructuredRunner = { runStructured: async (input) => { calls += 1; return { outcome: "success", requestId: input.requestId, structuredOutput: { kind: "worker_result", schemaVersion: 1, taskId, attemptId: attemptOne, correlationId: "claude-integration-new", outcome: "CODE_PUSHED", branch, finalCommit: "dddddddddddddddddddddddddddddddddddddddd" }, durationMs: 1, exitCode: 0 }; } };
    const safePrompt = new ClaudeCodeProcessAdapter({ runner, inputSource: { create: (input) => inputFor(input, "new") }, promptRenderer: { render: () => "Do not modify CI/CD, infrastructure, secrets, other branches, or remotes. Evidence: [REDACTED]." } });
    const accepted = await safePrompt.run(request("new", value.worktree), new AbortController().signal);
    assert.equal(accepted.outcome, "success");
    assert.equal(calls, 1);
    const evidenceWithSecret = new ClaudeCodeProcessAdapter({ runner, inputSource: { create: (input) => inputFor(input, "new") }, promptRenderer: { render: () => "Failure log excerpt: token=fixture-secret" } });
    const rejected = await evidenceWithSecret.run(request("new", value.worktree), new AbortController().signal);
    assert.equal(rejected.outcome, "invalid_input");
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(rejected).includes("fixture-secret"), false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("keeps the CLI schema and WorkerResult contract aligned with bounded diagnostics", async () => {
  const value = await fixture();
  try {
    const minimal = await adapter(value, "new", "minimal-code-pushed");
    await assert.rejects(() => minimal.execute(request("new", value.worktree), new AbortController().signal), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const diagnostic = (error as { readonly diagnostic?: { readonly code?: string; readonly stage?: string; readonly field?: string; readonly fieldNames?: readonly string[]; readonly payloadDigest?: string } }).diagnostic;
      assert.equal(diagnostic?.code, "worker_contract_mismatch");
      assert.equal(diagnostic?.stage, "worker_contract");
      assert.equal(diagnostic?.field, "branch");
      assert.deepEqual(diagnostic?.fieldNames, ["attemptId", "correlationId", "kind", "outcome", "schemaVersion", "taskId"]);
      assert.match(diagnostic?.payloadDigest ?? "", /^[0-9a-f]{64}$/u);
      assert.equal(JSON.stringify(error).includes("not-a-worker-result"), false);
      return true;
    });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("appends the exact terminal variant requirements to the worker prompt", async () => {
  const value = await fixture();
  try {
    let prompt = "";
    const runner: ClaudeStructuredRunner = { runStructured: async (input) => {
      prompt = input.prompt;
      return { outcome: "success", requestId: input.requestId, structuredOutput: { kind: "worker_result", schemaVersion: 1, taskId, attemptId: attemptOne, correlationId: "claude-integration-new", outcome: "BLOCKED", reason: "bounded" }, durationMs: 1, exitCode: 0 };
    } };
    const processAdapter = new ClaudeCodeProcessAdapter({ runner, inputSource: { create: (input) => inputFor(input, "new") }, promptRenderer: { render: () => "Inspect and perform the assigned bounded repair." } });
    await processAdapter.execute(request("new", value.worktree), new AbortController().signal);
    assert.match(prompt, /CODE_PUSHED include branch and finalCommit/u);
    assert.match(prompt, /non-success outcome include reason/u);
    assert.match(prompt, /Do not wrap the JSON in Markdown/u);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("preserves CODE_PUSHED evidence in a temporary local fixture without mutation", async () => {
  const value = await fixture();
  const capture = join(value.root, "capture.json");
  try {
    const processAdapter = await adapter(value, "new", "success", capture);
    const result = await processAdapter.run(request("new", value.worktree), new AbortController().signal);
    assert.equal(result.outcome, "success");
    if (result.outcome === "success") {
      const output = result.structuredOutput as { readonly outcome: string; readonly branch: string; readonly finalCommit: string };
      assert.deepEqual(output, { kind: "worker_result", schemaVersion: 1, taskId, attemptId: attemptOne, correlationId: "claude-integration-new", outcome: "CODE_PUSHED", branch, finalCommit: "dddddddddddddddddddddddddddddddddddddddd" });
    }
    const captured = JSON.parse(await readFile(capture, "utf8")) as { readonly input: ClaudeCodeInput };
    assert.equal(captured.input.workspace.branch, branch);
    assert.equal(JSON.stringify(captured).includes("must-not-forward"), false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
