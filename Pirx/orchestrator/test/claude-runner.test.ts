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
  type ClaudeSpawn,
  buildClaudeArguments,
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
if (mode === "process") { process.stderr.write("provider failed"); process.exit(17); }
if (mode === "signal") { process.kill(process.pid, "SIGTERM"); }
if (mode === "stdout-limit") { process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000); }
if (mode === "stderr-limit") { process.stderr.write("x".repeat(100000)); setInterval(() => {}, 1000); }
if (mode === "hang") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
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

test("builds the restricted no-tools JSON-schema invocation", () => {
  const args = buildClaudeArguments("request-id");
  assert.deepEqual(args.slice(0, 14), [
    "--restricted", "-p", "--tools", "", "--disallowedTools", "mcp__*",
    "--permission-prompts", "none", "--disable-slash-commands",
    "--no-session-persistence", "--max-turns", "1", "--output-format", "json",
  ]);
  assert.equal(args.at(-1)?.includes('"hello world"'), true);
  assert.equal(args.at(-1)?.includes("request-id"), true);
  const schema = JSON.parse(args[15] ?? "{}");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.requestId.const, "request-id");
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
    if (processResult.outcome === "process_error") assert.equal(processResult.exitCode, 17);
    const missing = new ClaudeCodeCliRunner({ executable: join(value.root, "does-not-exist"), tempParentDirectory: value.root, requestIdFactory: () => "missing" });
    assert.equal((await missing.run()).outcome, "claude_not_installed");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
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
