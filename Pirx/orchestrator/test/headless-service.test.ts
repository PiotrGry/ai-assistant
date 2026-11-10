import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  HeadlessConfigurationError,
  HeadlessOrchestratorService,
  loadGitHubConfig,
  RuntimeSqliteStore,
  SqliteHeadlessControlPort,
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
    repositories: [{
      repository: "PiotrGry/ai-assistant", repositoryRoot: "/tmp/pirx-repository", baseBranch: "develop", baseRevision: "a".repeat(40), remoteName: "origin", testCommands: ["npm run check"],
      delivery: { releaseBranch: "main", featureWorkflowName: "CI", releaseRequiredChecks: ["CI"], featureRequiredApprovals: 0, releaseRequiredApprovals: 0, featureMergeMethod: "merge", releaseMergeMethod: "merge", requireMergeable: true },
    }],
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
  assert.deepEqual(port.calls, ["recover", "cycle", "shutdown", "close"]);
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

test("contains observability projection failure without blocking the work cycle", async () => {
  const port = runtime();
  const events: HeadlessServiceEvent[] = [];
  let service: HeadlessOrchestratorService;
  service = new HeadlessOrchestratorService(port, { cycleIntervalMs: 100, observability: { reconcile: () => { throw new Error("raw storage detail"); } }, emit: (event) => events.push(event), sleep: async () => { await service.stop("fixture"); } });
  assert.equal((await service.run()).outcome, "stopped");
  assert.equal(port.calls.includes("cycle"), true);
  const observations = events.filter((event) => event.event === "observability");
  assert.equal(observations.length >= 2, true);
  assert.equal(observations.every((event) => event.outcome === "storage_error" && event.reason === "projection_threw"), true);
  assert.equal(JSON.stringify(events).includes("raw storage detail"), false);
});

test("diagnostic persistence failure does not retry the worker cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-service-persistence-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  try {
    store.database.exec("CREATE TRIGGER fail_diagnostic BEFORE INSERT ON runtime_orchestrator_diagnostics BEGIN SELECT RAISE(FAIL, 'private error'); END");
    const failures: string[] = [];
    const control = new SqliteHeadlessControlPort(store, undefined, (failure) => failures.push(failure.stage));
    const port = runtime();
    let service: HeadlessOrchestratorService;
    service = new HeadlessOrchestratorService(port, { cycleIntervalMs: 100, control, sleep: async () => { await service.stop("fixture"); } });
    assert.equal((await service.run()).outcome, "stopped");
    assert.deepEqual(port.calls, ["recover", "cycle", "shutdown", "close"]);
    assert.ok(failures.length > 0 && failures.every((stage) => stage === "diagnostic"));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
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
  assert.deepEqual(port.calls, ["recover", "shutdown", "close"]);
});

test("runs the leased worker only when delivery reconciliation permits it", async () => {
  const port = runtime();
  let service: HeadlessOrchestratorService;
  service = new HeadlessOrchestratorService(port, {
    cycleIntervalMs: 100,
    delivery: { reconcile: async () => ({ outcome: "retry_ready", allowWorkerCycle: true, message: "retry is durable" }) },
    sleep: async () => { await service.stop("fixture"); },
  });
  assert.equal((await service.run()).outcome, "stopped");
  assert.deepEqual(port.calls, ["recover", "cycle", "shutdown", "close"]);
});

test("does not start worker execution while delivery is pending", async () => {
  const port = runtime();
  let service: HeadlessOrchestratorService;
  service = new HeadlessOrchestratorService(port, {
    cycleIntervalMs: 100,
    delivery: { reconcile: async () => ({ outcome: "waiting", allowWorkerCycle: false, message: "CI is pending" }) },
    sleep: async () => { await service.stop("fixture"); },
  });
  assert.equal((await service.run()).outcome, "stopped");
  assert.deepEqual(port.calls, ["recover", "shutdown", "close"]);
});

test("honours a durable pause before Queue or worker work and resumes on a later poll", async () => {
  const port = runtime();
  const modes: Array<"paused" | "running"> = ["paused", "running"];
  let pausedHeartbeats = 0;
  let sleeps = 0;
  let service: HeadlessOrchestratorService;
  service = new HeadlessOrchestratorService(port, {
    cycleIntervalMs: 100,
    control: {
      read: () => ({ outcome: "success", mode: modes.shift() ?? "running" }),
      observe: () => undefined,
      paused: () => { pausedHeartbeats += 1; },
    },
    sleep: async () => { sleeps += 1; if (sleeps === 2) await service.stop("fixture"); },
  });
  assert.equal((await service.run()).outcome, "stopped");
  assert.equal(pausedHeartbeats, 1);
  assert.deepEqual(port.calls, ["recover", "cycle", "shutdown", "close"]);
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

test("drains, closes runtime storage, and only then invokes an armed host power-off", async () => {
  const port = runtime();
  const calls: string[] = [];
  let evaluations = 0;
  const service = new HeadlessOrchestratorService(port, {
    cycleIntervalMs: 100,
    queue: { reconcile: async () => ({ outcome: "synchronized" }) },
    delivery: { reconcile: async () => ({ outcome: "idle", allowWorkerCycle: true }) },
    hostShutdown: {
      evaluate: () => ++evaluations === 1 ? { outcome: "armed", requestOperationId: "shutdown-1" } : { outcome: "triggered", requestOperationId: "shutdown-1" },
      beginDrain: () => { calls.push("beginDrain"); return { outcome: "success" }; },
      powerOffRequested: () => { calls.push("powerOffRequested"); return { outcome: "success" }; },
      failBeforeClose: () => { calls.push("failed"); },
      powerOffAfterClose: async () => { calls.push(port.calls.at(-1) === "close" ? "powerOffAfterClose" : "powerOffBeforeClose"); return { outcome: "accepted", message: "accepted" }; },
    },
  });
  assert.deepEqual(await service.run(), { outcome: "stopped", exitCode: 0, interrupted: false });
  assert.deepEqual(port.calls, ["recover", "cycle", "shutdown", "close"]);
  assert.deepEqual(calls, ["beginDrain", "powerOffRequested", "powerOffAfterClose"]);
});

test("fails closed without power-off when the armed host drain times out", async () => {
  const calls: string[] = [];
  const port = runtime({ shutdown: async () => { port.calls.push("shutdown"); return { outcome: "timeout", interrupted: true }; } });
  const service = new HeadlessOrchestratorService(port, {
    cycleIntervalMs: 100,
    hostShutdown: {
      evaluate: () => ({ outcome: "triggered", requestOperationId: "shutdown-timeout" }),
      beginDrain: () => ({ outcome: "success" }),
      powerOffRequested: () => { calls.push("requested"); return { outcome: "success" }; },
      failBeforeClose: (reason) => { calls.push(reason); },
      powerOffAfterClose: async () => { calls.push("poweroff"); return { outcome: "accepted", message: "unexpected" }; },
    },
  });
  assert.deepEqual(await service.run(), { outcome: "shutdown_timeout", exitCode: 3, interrupted: true });
  assert.deepEqual(port.calls, ["recover", "shutdown"]);
  assert.deepEqual(calls, ["runtime_drain_timeout"]);
});

test("returns a controlled failure after a rejected post-close power-off command", async () => {
  const port = runtime();
  let evaluations = 0;
  const service = new HeadlessOrchestratorService(port, {
    cycleIntervalMs: 100,
    queue: { reconcile: async () => ({ outcome: "synchronized" }) },
    delivery: { reconcile: async () => ({ outcome: "idle", allowWorkerCycle: true }) },
    hostShutdown: {
      evaluate: () => ++evaluations === 1 ? { outcome: "armed", requestOperationId: "shutdown-rejected" } : { outcome: "triggered", requestOperationId: "shutdown-rejected" },
      beginDrain: () => ({ outcome: "success" }),
      powerOffRequested: () => ({ outcome: "success" }),
      failBeforeClose: () => undefined,
      powerOffAfterClose: async () => ({ outcome: "failed", message: "Host power-off command was rejected." }),
    },
  });
  assert.deepEqual(await service.run(), { outcome: "host_shutdown_failed", exitCode: 4, reason: "Host power-off command was rejected." });
  assert.deepEqual(port.calls, ["recover", "cycle", "shutdown", "close"]);
});

test("strict config accepts bounded operational fields and rejects unknown or sensitive fields", () => {
  const parsed = parseHeadlessOrchestratorConfig(validConfig());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.repositories[0]?.testCommands[0], "npm run check");
  assert.equal(parsed.repositories[0]?.delivery.releaseBranch, "main");
  assert.equal(parsed.repositories[0]?.maxTurns, undefined);
  const withTurns = (maxTurns: unknown) => { const config = structuredClone(validConfig()) as { repositories: Array<Record<string, unknown>> }; config.repositories[0]!.maxTurns = maxTurns; return config; };
  assert.equal(parseHeadlessOrchestratorConfig(withTurns(32)).repositories[0]?.maxTurns, 32);
  for (const maxTurns of [1, 33, 2.5, "32"]) assert.throws(() => parseHeadlessOrchestratorConfig(withTurns(maxTurns)), HeadlessConfigurationError);
  const powered = parseHeadlessOrchestratorConfig({ ...validConfig(), hostPowerOff: { enabled: true, method: "linux-systemctl", acceptanceTimeoutMs: 5_000 } });
  assert.equal(powered.hostPowerOff?.method, "linux-systemctl");
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), hostPowerOff: { enabled: true, method: "shell", acceptanceTimeoutMs: 5_000, command: "shutdown now" } }), HeadlessConfigurationError);
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), token: "fixture" }), (error: unknown) => error instanceof HeadlessConfigurationError && error.code === "sensitive_configuration");
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), unexpected: true }), (error: unknown) => error instanceof HeadlessConfigurationError && error.code === "invalid_configuration");
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), cycleIntervalMs: 1 }), HeadlessConfigurationError);
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), provider: "pretends-to-be-claude" }), HeadlessConfigurationError);
  assert.throws(() => parseHeadlessOrchestratorConfig({ ...validConfig(), workerCapabilities: ["production.mutate"] }), HeadlessConfigurationError);
  const invalidMerge = structuredClone(validConfig()) as { repositories: Array<{ delivery: { featureMergeMethod: string } }> };
  invalidMerge.repositories[0]!.delivery.featureMergeMethod = "squash";
  assert.throws(() => parseHeadlessOrchestratorConfig(invalidMerge), HeadlessConfigurationError);
  const sameBranches = structuredClone(validConfig()) as { repositories: Array<{ baseBranch: string; delivery: { releaseBranch: string } }> };
  sameBranches.repositories[0]!.delivery.releaseBranch = sameBranches.repositories[0]!.baseBranch;
  assert.throws(() => parseHeadlessOrchestratorConfig(sameBranches), HeadlessConfigurationError);
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
    RuntimeSqliteStore.open({ filename: parseHeadlessOrchestratorConfig(validConfig(directory)).databasePath }).close();
    const host = new FixtureHost(filename, signal);
    const githubEnvironments: NodeJS.ProcessEnv[] = [];
    assert.equal(await runHeadlessCli(host, {
      queue: { reconcile: async () => ({ outcome: "synchronized" }) },
      delivery: { reconcile: async () => ({ outcome: "idle", allowWorkerCycle: true }) },
      githubConfigLoader: (environment) => {
        githubEnvironments.push(environment);
        return loadGitHubConfig(environment, { tokenProvider: () => "test-only" });
      },
    }), 0);
    assert.equal(host.exitCode, 0);
    assert.equal(host.errors.length, 0);
    assert.equal(host.output.some((line) => line.includes('"event":"stopped"')), true);
    assert.equal(githubEnvironments.length, 1);
    assert.equal(githubEnvironments[0]?.PIRX_GITHUB_OWNER, "PiotrGry");
    assert.equal(githubEnvironments[0]?.PIRX_GITHUB_REPOSITORY, "ai-assistant");
    assert.equal(loadGitHubConfig(githubEnvironments[0], { tokenProvider: () => "test-only" }).writeTargetExplicit, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
