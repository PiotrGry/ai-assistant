import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  HeadlessConfigurationError,
  HeadlessOrchestratorService,
  parseHeadlessOrchestratorConfig,
  type HeadlessRuntimePort,
  type HeadlessServiceEvent,
} from "../src/index.js";
import { runHeadlessCli, type HeadlessCliProcess } from "../src/headless-cli.js";

function runtime(overrides: Partial<HeadlessRuntimePort> = {}): HeadlessRuntimePort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    recover: async () => { calls.push("recover"); return { outcome: "idle", reason: "no_runnable_task" }; },
    cycle: async () => { calls.push("cycle"); return { outcome: "idle", reason: "no_runnable_task" }; },
    shutdown: async () => { calls.push("shutdown"); return { outcome: "stopped", interrupted: false }; },
    close: () => { calls.push("close"); },
    status: () => ({ active: false, stopping: false, recovered: true }),
    ...overrides,
  };
}

function validConfig(directory = "/tmp/pirx-headless"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    databasePath: `${directory}/runtime.sqlite`,
    workerId: "pirx-worker",
    provider: "claude-code",
    workerCapabilities: ["repository.read", "repository.write", "tests.run", "git.commit", "git.push_assigned_branch"],
    repositories: [{ repository: "PiotrGry/ai-assistant", repositoryRoot: "/tmp/pirx-repository", baseBranch: "main", baseRevision: "a".repeat(40), remoteName: "origin", testCommands: ["npm run check"] }],
    worktreeParent: `${directory}/worktrees`,
    leaseDurationMs: 60_000,
    shutdownTimeoutMs: 5_000,
    workerTimeoutMs: 120_000,
    workerOutputBytes: 16_384,
    workerErrorBytes: 16_384,
    maximumConsecutiveResumeFailures: 3,
    cycleIntervalMs: 30_000,
    errorIntervalMs: 60_000,
    githubProjectOwner: "PiotrGry",
    githubProjectNumber: 3,
    githubApiUrl: "https://api.github.com",
    githubTimeoutMs: 10_000,
  };
}

test("headless service recovers before the first serial cycle and stops idempotently", async () => {
  const port = runtime();
  const events: HeadlessServiceEvent[] = [];
  let service: HeadlessOrchestratorService;
  service = new HeadlessOrchestratorService(port, { cycleIntervalMs: 100, emit: (event) => events.push(event), sleep: async () => { await service.stop("fixture"); } });
  const result = await service.run();
  assert.deepEqual(result, { outcome: "stopped", exitCode: 0, interrupted: false });
  assert.deepEqual(port.calls, ["recover", "cycle", "shutdown"]);
  assert.deepEqual(events.map((event) => event.event), ["starting", "recovered", "cycle", "stopping", "stopped"]);
  assert.strictEqual(await service.stop("replay"), result);
  assert.equal(port.calls.filter((value) => value === "shutdown").length, 1);
});

test("contains a cycle exception, uses the error delay, and continues to shutdown", async () => {
  const delays: number[] = [];
  const events: HeadlessServiceEvent[] = [];
  const port = runtime({ cycle: async () => { port.calls.push("cycle"); throw new Error("provider payload must not escape"); } });
  let service: HeadlessOrchestratorService;
  service = new HeadlessOrchestratorService(port, { cycleIntervalMs: 100, errorIntervalMs: 250, emit: (event) => events.push(event), sleep: async (duration) => { delays.push(duration); await service.stop("fixture"); } });
  assert.equal((await service.run()).outcome, "stopped");
  assert.deepEqual(delays, [250]);
  assert.equal(events.find((event) => event.event === "cycle_error")?.reason, "cycle_threw");
  assert.equal(JSON.stringify(events).includes("provider payload"), false);
});

test("does not execute stale runtime Queue data when GitHub reconciliation fails", async () => {
  const port = runtime();
  let service: HeadlessOrchestratorService;
  service = new HeadlessOrchestratorService(port, {
    cycleIntervalMs: 100, errorIntervalMs: 250,
    queue: { reconcile: async () => ({ outcome: "rate_limited", message: "bounded retry exhausted" }) },
    sleep: async () => { await service.stop("fixture"); },
  });
  assert.equal((await service.run()).outcome, "stopped");
  assert.deepEqual(port.calls, ["recover", "shutdown"]);
});

test("closes storage once when startup recovery fails and reports a bounded outcome", async () => {
  const port = runtime({ recover: async () => { port.calls.push("recover"); return { outcome: "reconciliation_required", reason: "recovery:durable_state_conflict" }; } });
  const service = new HeadlessOrchestratorService(port, { cycleIntervalMs: 100 });
  assert.deepEqual(await service.run(), { outcome: "startup_recovery_failed", exitCode: 2, reason: "recovery:durable_state_conflict" });
  assert.deepEqual(port.calls, ["recover", "close"]);
});

test("surfaces a bounded shutdown timeout without closing active storage underneath the runtime", async () => {
  const port = runtime({ shutdown: async () => { port.calls.push("shutdown"); return { outcome: "timeout", interrupted: true }; } });
  const service = new HeadlessOrchestratorService(port, { cycleIntervalMs: 100 });
  assert.deepEqual(await service.stop("SIGTERM"), { outcome: "shutdown_timeout", exitCode: 3, interrupted: true });
  assert.deepEqual(port.calls, ["shutdown"]);
});

test("strict config accepts bounded operational fields and rejects unknown or sensitive fields", () => {
  const parsed = parseHeadlessOrchestratorConfig(validConfig());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.repositories[0]?.testCommands[0], "npm run check");
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), token: "fixture" }), (error: unknown) => error instanceof HeadlessConfigurationError && error.code === "sensitive_configuration");
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), unexpected: true }), (error: unknown) => error instanceof HeadlessConfigurationError && error.code === "invalid_configuration");
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), cycleIntervalMs: 1 }), HeadlessConfigurationError);
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), provider: "pretends-to-be-claude" }), HeadlessConfigurationError);
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), workerCapabilities: ["production.mutate"] }), HeadlessConfigurationError);
});

class FixtureHost extends EventEmitter implements HeadlessCliProcess {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[] = ["node", "headless-cli.js"];
  readonly output: string[] = [];
  readonly errors: string[] = [];
  exitCode: string | number | null | undefined;
  readonly stdout = { write: (value: string) => { this.output.push(value); if (value.includes('"event":"recovered"')) queueMicrotask(() => this.emit(this.signal, this.signal)); } };
  readonly stderr = { write: (value: string) => { this.errors.push(value); } };
  public constructor(configPath: string, readonly signal: "SIGTERM" | "SIGINT") { super(); this.env = { PIRX_ORCHESTRATOR_CONFIG: configPath }; }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) test(`CLI drains gracefully on ${signal}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-headless-cli-"));
  try {
    const filename = join(directory, "config.json");
    await writeFile(filename, JSON.stringify(validConfig(directory)), { mode: 0o600 });
    const host = new FixtureHost(filename, signal);
    assert.equal(await runHeadlessCli(host, { queue: { reconcile: async () => ({ outcome: "synchronized" }) }, githubConfigLoader: () => ({ token: "test-only", owner: "PiotrGry", repository: "ai-assistant", projectOwner: "PiotrGry", projectNumber: 3, apiUrl: "https://api.github.com", timeoutMs: 10_000 }) }), 0);
    assert.equal(host.exitCode, 0);
    assert.equal(host.errors.length, 0);
    assert.equal(host.output.some((line) => line.includes('"event":"stopped"')), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
