import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  ClaudeCodeCliRunner,
  MINIMUM_CLAUDE_CODE_WORKER_VERSION,
  type ClaudeSpawn,
  type ClaudeCodeWorkerProfile,
  buildClaudeArguments,
  buildClaudeHandoffArguments,
} from "../src/index.js";

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.PIRX_FAKE_MODE || "success";
const args = process.argv.slice(2);
const schemaPosition = args.indexOf("--json-schema");
const schema = schemaPosition >= 0 ? JSON.parse(args[schemaPosition + 1]) : {};
const requestId = schema.properties?.requestId?.const || "missing";
if (process.env.PIRX_CAPTURE_FILE) {
  fs.writeFileSync(process.env.PIRX_CAPTURE_FILE, JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), args, env: Object.keys(process.env).sort() }));
}
const envelope = (structuredOutput) => ({ type: "result", subtype: "success", is_error: false, structured_output: structuredOutput });
const emit = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (mode === "success") emit(envelope({ requestId, acknowledgement: "hello world acknowledged" }));
if (mode === "mismatch") emit(envelope({ requestId: "wrong-request", acknowledgement: "hello world acknowledged" }));
if (mode === "extra") emit(envelope({ requestId, acknowledgement: "hello world acknowledged", extra: true }));
if (mode === "schema") emit(envelope({ requestId, acknowledgement: 42 }));
if (mode === "invalid-envelope") emit({ type: "message", text: "prose" });
if (mode === "invalid-json") { process.stdout.write("not json"); process.exit(0); }
if (mode === "auth") { process.stderr.write("CLAUDE_AUTH_REQUIRED"); process.exit(1); }
if (mode === "quota") { process.stderr.write("CLAUDE_QUOTA_EXHAUSTED"); process.exit(1); }
if (mode === "quota-prose") { process.stderr.write("You've hit your session limit; resets at 5pm"); process.exit(1); }
if (mode === "quota-structured") emit({ error_code: "quota_exhausted", retry_after_ms: 120000, quota_bucket: "five-hour", status_code: "quota_exhausted" });
if (mode === "process") { process.stderr.write("provider failed"); process.exit(17); }
if (mode === "signal") { process.kill(process.pid, "SIGTERM"); }
if (mode === "stdout-limit") { process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000); }
if (mode === "stderr-limit") { process.stderr.write("x".repeat(100000)); setInterval(() => {}, 1000); }
if (mode === "hang") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
if (mode === "missing-output") { process.stderr.write("provider fixture token=never-expose"); emit({ type: "result", subtype: "success", is_error: false }); }
if (mode === "process-tree") {
  require("node:child_process").spawn(process.execPath, ["-e", \`
    const fs = require("node:fs");
    process.on("SIGTERM", () => {});
    fs.writeFileSync(process.env.PIRX_CHILD_READY, "ready");
    setTimeout(() => fs.writeFileSync(process.env.PIRX_CHILD_ESCAPED, "escaped"), 650);
  \`], { stdio: "ignore" });
  setInterval(() => {}, 1000);
}
if (mode === "stream-active") {
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    process.stdout.write(JSON.stringify({ type: "assistant", step, padding: step === 2 ? "x".repeat(4096) : "" }) + "\\n");
    if (step === 6) { clearInterval(timer); process.stdout.write(JSON.stringify(envelope({ ok: true })) + "\\n"); process.exit(0); }
  }, 40);
}
if (mode === "stream-silent") { process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n"); setInterval(() => {}, 1000); }
if (mode === "delay") setTimeout(() => emit(envelope({ requestId, acknowledgement: "hello world acknowledged" })), 1000);
`;

interface Fixture {
  readonly root: string;
  readonly executable: string;
}

async function fixture(): Promise<Fixture> {
  // Resolve symlinked temp roots (macOS /var -> /private/var) so cwd comparisons match the child's view.
  const root = await realpath(await mkdtemp(join(tmpdir(), "pirx-claude-test-")));
  const executable = join(root, "fake claude executable.js");
  await writeFile(executable, FAKE_CLAUDE, { mode: 0o755 });
  await chmod(executable, 0o755);
  return { root, executable };
}

test("waits for close after a child process error before removing the temporary cwd", async () => {
  const value = await fixture();
  try {
    let child: EventEmitter | undefined;
    let cwd = "";
    const spawnProcess: ClaudeSpawn = (_file, _args, options) => {
      cwd = options.cwd;
      child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, kill: () => true });
      return child as unknown as ChildProcess;
    };
    let settled = false;
    const pending = new ClaudeCodeCliRunner({ executable: value.executable, tempParentDirectory: value.root, environment: {}, requestIdFactory: () => "error-then-close", spawnProcess })
      .run()
      .finally(() => { settled = true; });
    while (child === undefined) await delay(1);
    child.emit("error", Object.assign(new Error("kill failed"), { code: "EPERM" }));
    await delay(20);
    assert.equal(settled, false);
    assert.equal(existsSync(cwd), true);
    child.emit("close", 1);
    assert.equal((await pending).outcome, "process_error");
    assert.equal(existsSync(cwd), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

function runner(fixtureValue: Fixture, mode: string, captureFile?: string, extra: Record<string, string> = {}): ClaudeCodeCliRunner {
  return new ClaudeCodeCliRunner({
    executable: fixtureValue.executable,
    tempParentDirectory: fixtureValue.root,
    environment: { PATH: process.env.PATH, HOME: process.env.HOME, PIRX_SECRET: "must-not-cross-boundary" },
    additionalEnvironment: { PIRX_FAKE_MODE: mode, ...(captureFile === undefined ? {} : { PIRX_CAPTURE_FILE: captureFile }), ...extra },
    requestIdFactory: () => "11111111-1111-4111-8111-111111111111",
  });
}

test("builds the no-tools dontAsk JSON-schema invocation", () => {
  const args = buildClaudeArguments("request-id");
  assert.deepEqual(args.slice(0, 13), [
    "-p", "--tools", "", "--disallowedTools", "mcp__*",
    "--permission-mode", "dontAsk", "--disable-slash-commands",
    "--no-session-persistence", "--max-turns", "2", "--output-format", "json",
  ]);
  assert.equal(args.at(-1)?.includes('"hello world"'), true);
  assert.equal(args.at(-1)?.includes("request-id"), true);
  const schema = JSON.parse(args[14] ?? "{}");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.requestId.const, "request-id");
});

test("runs one fresh restricted structured failure handoff with the same handoff ID", async () => {
  const value = await fixture();
  const capture = join(value.root, "capture.json");
  try {
    const handoffId = "handoff-192";
    const args = buildClaudeHandoffArguments(handoffId, { schemaVersion: 1, evidence: { conclusion: "failure" } });
    assert.equal(args.includes("--no-session-persistence"), true);
    assert.equal(args.includes("--tools"), true);
    const result = await new ClaudeCodeCliRunner({ executable: value.executable, tempParentDirectory: value.root, environment: { PATH: process.env.PATH, HOME: process.env.HOME }, additionalEnvironment: { PIRX_CAPTURE_FILE: capture }, requestIdFactory: () => "unused" }).runHandoff({ handoffId, envelope: { schemaVersion: 1, evidence: { conclusion: "failure" } } });
    assert.equal(result.outcome, "success");
    assert.equal(result.requestId, handoffId);
    const captured = JSON.parse(await readFile(capture, "utf8")) as { args: string[] };
    assert.equal(captured.args.includes("--no-session-persistence"), true);
    assert.match(captured.args.at(-1) ?? "", /handoff-192/u);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("runs one structured round-trip in an empty temporary cwd with shell disabled and allowlisted env", async () => {
  const value = await fixture();
  try {
    const capture = join(value.root, "capture.json");
    let observed: { shell: false; cwd: string; env: NodeJS.ProcessEnv } | undefined;
    const spawnProcess: ClaudeSpawn = (file, args, options) => {
      observed = { shell: options.shell, cwd: options.cwd, env: options.env };
      return spawn(file, [...args], options);
    };
    const result = await new ClaudeCodeCliRunner({
      executable: value.executable,
      tempParentDirectory: value.root,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME, PIRX_SECRET: "not forwarded" },
      additionalEnvironment: { PIRX_FAKE_MODE: "success", PIRX_CAPTURE_FILE: capture },
      requestIdFactory: () => "11111111-1111-4111-8111-111111111111",
      spawnProcess,
    }).run();
    assert.equal(result.outcome, "success");
    if (result.outcome === "success") assert.equal(result.acknowledgement, "hello world acknowledged");
    assert.equal(observed?.shell, false);
    assert.notEqual(observed?.cwd, value.root);
    assert.equal(observed?.env.PIRX_SECRET, undefined);
    const captured = JSON.parse(await readFile(capture, "utf8")) as { cwd: string; entries: string[]; args: string[]; env: string[] };
    assert.equal(captured.cwd, observed?.cwd);
    assert.deepEqual(captured.entries, []);
    assert.equal(captured.env.includes("PIRX_SECRET"), false);
    assert.equal(captured.args.includes("--tools"), true);
    assert.equal(captured.args.includes("mcp__*"), true);
    assert.equal(captured.args.includes("--no-session-persistence"), true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects malformed, mismatched, oversized, and non-structured responses", async () => {
  const value = await fixture();
  try {
    for (const mode of ["invalid-json", "invalid-envelope", "mismatch", "extra", "schema"]) {
      const result = await runner(value, mode).run({ maxStdoutBytes: 2_048 });
      assert.equal(result.outcome, "invalid_output", mode);
    }
    assert.equal((await runner(value, "stdout-limit").run({ timeoutMs: 2_000, maxStdoutBytes: 1_024 })).outcome, "invalid_output");
    assert.equal((await runner(value, "stderr-limit").run({ timeoutMs: 2_000, maxStderrBytes: 1_024 })).outcome, "invalid_output");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("normalizes authentication, quota, process, and missing executable failures", async () => {
  const value = await fixture();
  try {
    assert.equal((await runner(value, "auth").run()).outcome, "authentication_required");
    assert.equal((await runner(value, "quota").run()).outcome, "quota_exhausted");
    const processResult = await runner(value, "process").run();
    assert.equal(processResult.outcome, "process_error");
    assert.equal(processResult.diagnostic.providerMessage, "provider failed");
    if (processResult.outcome === "process_error") assert.equal(processResult.exitCode, 17);
    const missing = new ClaudeCodeCliRunner({ executable: join(value.root, "does-not-exist"), tempParentDirectory: value.root, requestIdFactory: () => "missing" });
    assert.equal((await missing.run()).outcome, "claude_not_installed");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("preserves trustworthy structured quota recovery metadata without parsing prose", async () => {
  const value = await fixture();
  try {
    const result = await runner(value, "quota-structured").run();
    assert.equal(result.outcome, "quota_exhausted");
    if (result.outcome === "quota_exhausted") assert.deepEqual(result.diagnostic.providerRecovery, { source: "provider_retry_after", retryAfterMs: 120_000, quotaBucket: "five-hour", providerStatusCode: "quota_exhausted" });
    const prose = await runner(value, "quota-prose").run();
    assert.equal(prose.outcome, "quota_exhausted");
    if (prose.outcome === "quota_exhausted") assert.equal(prose.diagnostic.providerRecovery, undefined);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("terminates hung processes on timeout and cancellation, including forced kill", async () => {
  const value = await fixture();
  try {
    const timedOut = await runner(value, "hang").run({ timeoutMs: 40 });
    assert.equal(timedOut.outcome, "timeout");
    const controller = new AbortController();
    const pending = runner(value, "delay").run({ signal: controller.signal, timeoutMs: 2_000 });
    setTimeout(() => controller.abort(), 20);
    assert.equal((await pending).outcome, "cancelled");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("returns unknown when a child exits by signal and rejects invalid bounds", async () => {
  const value = await fixture();
  try {
    assert.equal((await runner(value, "signal").run()).outcome, "unknown");
    assert.equal((await runner(value, "success").run({ timeoutMs: 0 })).outcome, "process_error");
    assert.equal((await runner(value, "success").run({ maxStdoutBytes: 65 * 1024 })).outcome, "process_error");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("cancellation terminates the Claude subprocess group", { skip: process.platform === "win32" }, async () => {
  const value = await fixture();
  try {
    const ready = join(value.root, "child-ready");
    const escaped = join(value.root, "child-escaped");
    const controller = new AbortController();
    const execution = runner(value, "process-tree", undefined, { PIRX_CHILD_READY: ready, PIRX_CHILD_ESCAPED: escaped }).run({ signal: controller.signal, timeoutMs: 5_000 });
    for (let i = 0; i < 150 && !existsSync(ready); i++) await delay(10);
    const childStarted = existsSync(ready);
    controller.abort();
    assert.equal((await execution).outcome, "cancelled");
    assert.equal(childStarted, true);
    await delay(750);
    assert.equal(existsSync(escaped), false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("missing structured output preserves sanitized provider evidence", async () => {
  const value = await fixture();
  try {
    const result = await runner(value, "missing-output").runStructured({ requestId: "missing-output", cwd: value.root, prompt: "fixture", responseSchema: {} });
    assert.equal(result.outcome, "invalid_output");
    assert.equal(result.diagnostic.code, "missing_structured_output");
    assert.match(result.diagnostic.providerMessage ?? "", /provider fixture/u);
    assert.doesNotMatch(result.diagnostic.providerMessage ?? "", /never-expose/u);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

function workerProfile(cwd: string): ClaudeCodeWorkerProfile {
  return {
    schemaVersion: 1,
    cwd,
    tools: ["Read", "Edit", "Bash"],
    allowedTools: ["Read", "Edit", "Bash(node test.js)"],
    disallowedTools: ["mcp__*"],
    permissionMode: "dontAsk",
    maxTurns: 8,
    remoteName: "origin",
    assignedBranch: "pirx/test",
    testCommands: ["node test.js"],
  };
}

test("fails closed before code-worker invocation when Claude Code lacks isolation support", async () => {
  const value = await fixture();
  let processInvocations = 0;
  try {
    const result = await new ClaudeCodeCliRunner({
      executable: value.executable,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME },
      versionProbe: async () => "2.1.59 (Claude Code)",
      spawnProcess: (file, args, options) => { processInvocations += 1; return spawn(file, [...args], options); },
    }).runStructured({ requestId: "old-version", cwd: value.root, prompt: "bounded", responseSchema: {}, workerProfile: workerProfile(value.root) });
    assert.equal(result.outcome, "unsupported_version");
    assert.equal(result.diagnostic.code, "permission_denied");
    assert.match(result.diagnostic.providerMessage ?? "", new RegExp(MINIMUM_CLAUDE_CODE_WORKER_VERSION.replaceAll(".", "\\."), "u"));
    assert.equal(processInvocations, 0);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("runs isolated code workers only after one successful cached compatibility probe", async () => {
  const value = await fixture();
  let probes = 0;
  try {
    const instance = new ClaudeCodeCliRunner({
      executable: value.executable,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME },
      additionalEnvironment: { PIRX_FAKE_MODE: "success" },
      versionProbe: async () => { probes += 1; return `${MINIMUM_CLAUDE_CODE_WORKER_VERSION} (Claude Code)`; },
    });
    for (const requestId of ["supported-1", "supported-2"]) {
      const result = await instance.runStructured({ requestId, cwd: value.root, prompt: "bounded", responseSchema: {}, workerProfile: workerProfile(value.root) });
      assert.equal(result.outcome, "success");
    }
    assert.equal(probes, 1);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("rejects a worker profile bound to a different cwd before probing or spawning", async () => {
  const value = await fixture();
  let probes = 0;
  try {
    const result = await new ClaudeCodeCliRunner({
      executable: value.executable,
      versionProbe: async () => { probes += 1; return `${MINIMUM_CLAUDE_CODE_WORKER_VERSION} (Claude Code)`; },
    }).runStructured({ requestId: "cwd-mismatch", cwd: value.root, prompt: "bounded", responseSchema: {}, workerProfile: workerProfile(join(value.root, "other")) });
    assert.equal(result.outcome, "process_error");
    assert.equal(result.diagnostic.code, "permission_denied");
    assert.equal(probes, 0);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("code workers run while they stream events and stop only after an idle window", async () => {
  const value = await fixture();
  try {
    const instance = (mode: string) => new ClaudeCodeCliRunner({
      executable: value.executable,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME },
      additionalEnvironment: { PIRX_FAKE_MODE: mode },
      versionProbe: async () => `${MINIMUM_CLAUDE_CODE_WORKER_VERSION} (Claude Code)`,
    });
    // 6 events 40 ms apart outlive the 100 ms window; one oversized event is skipped, not fatal.
    const active = await instance("stream-active").runStructured({ requestId: "stream-active", cwd: value.root, prompt: "bounded", responseSchema: {}, workerProfile: workerProfile(value.root), timeoutMs: 100, maxStdoutBytes: 1_024 });
    assert.equal(active.outcome, "success", JSON.stringify(active));
    if (active.outcome === "success") assert.deepEqual(active.structuredOutput, { ok: true });
    assert.ok(active.durationMs >= 200, String(active.durationMs));
    const silent = await instance("stream-silent").runStructured({ requestId: "stream-silent", cwd: value.root, prompt: "bounded", responseSchema: {}, workerProfile: workerProfile(value.root), timeoutMs: 100 });
    assert.equal(silent.outcome, "timeout");
    assert.equal(silent.diagnostic.code, "timeout");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("code workers persist every raw stream byte, including the final result, to the transcript", async () => {
  const value = await fixture();
  try {
    const transcriptPath = join(value.root, "logs", "task-1", "attempt-1");
    const result = await new ClaudeCodeCliRunner({
      executable: value.executable,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME },
      additionalEnvironment: { PIRX_FAKE_MODE: "stream-active" },
      versionProbe: async () => `${MINIMUM_CLAUDE_CODE_WORKER_VERSION} (Claude Code)`,
    }).runStructured({ requestId: "stream-transcript", cwd: value.root, prompt: "bounded", responseSchema: {}, workerProfile: workerProfile(value.root), timeoutMs: 1_000, maxStdoutBytes: 1_024, transcriptPath });
    assert.equal(result.outcome, "success", JSON.stringify(result));
    const lines = (await readFile(`${transcriptPath}.stdout.jsonl`, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; padding?: string });
    // All 6 events (the oversized one too) plus the result envelope the contract checks later.
    assert.equal(lines.length, 7);
    assert.equal(lines[1]?.padding?.length, 4096);
    assert.equal(lines[6]?.type, "result");
    assert.equal(await readFile(`${transcriptPath}.stderr.log`, "utf8"), "");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
