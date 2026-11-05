import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createTask, createWorkerFailureDiagnostic, RUNTIME_STORAGE_SCHEMA_VERSION, RuntimeSqliteStore, transitionAttempt, transitionTask } from "@pirx/orchestrator";
import type { AttemptId, TaskId, ExecutionReportQuery, HostShutdownCommand, OrchestratorControlRequest, OrchestratorStatusSnapshot, UtcTimestamp } from "@pirx/orchestrator";

import { createHostAuthorization, HOST_AUTHORIZATION_META_KEY } from "../src/authorization.js";
import { ObsidianVault } from "../src/obsidian/vaults.js";
import { createMcpServer } from "../src/server.js";
import type { ExecutionObservabilityToolPort, OrchestratorControlToolPort } from "../src/tools/orchestrator.js";

const now = "2026-10-30T13:00:00.000Z" as UtcTimestamp;

class FakeControl implements OrchestratorControlToolPort, ExecutionObservabilityToolPort {
  calls: OrchestratorControlRequest[] = [];
  mode: "running" | "paused" = "running";
  version = 1;
  readonly snapshot: OrchestratorStatusSnapshot = { schemaVersion: 1, requestedMode: "running", observedState: "running", version: 1, heartbeatAt: now, heartbeatStale: false, lastPersistedObservationIncomplete: true, activeTask: { id: "task-211", state: "in_progress", issueNumber: 211 }, nextQueuedTask: { id: "task-212", state: "ready", issueNumber: 212, queueOrder: 500 } };
  status() { return { outcome: "success" as const, value: { ...this.snapshot, requestedMode: this.mode, version: this.version } }; }
  request(input: OrchestratorControlRequest) { this.calls.push(input); this.mode = input.action === "pause" ? "paused" : "running"; this.version += 1; return { outcome: "applied" as const, operationId: input.operationId, record: { schemaVersion: 1 as const, requestedMode: this.mode, requestedAt: input.requestedAt, requestedBy: input.requestedBy, reason: input.reason, version: this.version, observedState: "running" as const, heartbeatAt: now }, message: "applied" }; }
  shutdown(input: HostShutdownCommand) { return { outcome: "applied" as const, operationId: input.operationId, record: { schemaVersion: 1 as const, requestOperationId: input.action === "arm" ? input.operationId : input.requestOperationId, target: "queue_drained" as const, state: input.action === "arm" ? "armed" as const : "cancelled" as const, checkpointBaseline: 0, requestedAt: input.requestedAt, requestedBy: input.requestedBy, reason: input.reason, version: 1 }, message: "applied" }; }
  report(input: ExecutionReportQuery) { return { outcome: "success" as const, report: { schemaVersion: 1 as const, window: { from: input.from, to: input.to }, coverage: { eventsAvailable: 1, eventsScanned: 1, metricsAvailable: 1, metricsScanned: 1 }, partial: false, notices: [], recentEvents: [{ name: "pirx.task.lifecycle" as const, occurredAt: now, attributes: { correlationId: "task:211", taskId: "task-211", taskState: "in_progress" } }], latency: [{ name: "pirx.attempt.duration" as const, count: 1, minimumSeconds: 60, averageSeconds: 60, p50Seconds: 60, p95Seconds: 60, maximumSeconds: 60 }], repeatedFailures: [] } }; }
}

test("MCP reads bounded status and requires exact authorization for pause/resume", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-orchestrator-mcp-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const control = new FakeControl();
  const secret = "orchestrator-test-secret";
  const server = createMcpServer({ environment: { PIRX_TOOL_PROFILE: "operations" }, obsidianVault: new ObsidianVault(root), orchestratorControlPort: control, executionObservabilityPort: control, githubAuthorizationSecret: secret });
  const client = new Client({ name: "pirx-orchestrator-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });

  const status = await client.callTool({ name: "pirx_orchestrator_status", arguments: { staleAfterMs: 120_000 } });
  assert.notEqual(status.isError, true);
  assert.equal((status.structuredContent as { snapshot: { activeTask: { issueNumber: number } } }).snapshot.activeTask.issueNumber, 211);
  assert.equal((status.structuredContent as { snapshot: { lastPersistedObservationIncomplete: boolean } }).snapshot.lastPersistedObservationIncomplete, true);
  assert.equal(JSON.stringify(status.structuredContent).includes("prompt"), false);

  const report = await client.callTool({ name: "pirx_execution_report", arguments: { from: "2026-10-30T12:00:00.000Z", to: now } });
  assert.notEqual(report.isError, true);
  assert.equal((report.structuredContent as { report: { latency: Array<{ p95Seconds: number }> } }).report.latency[0]?.p95Seconds, 60);
  assert.equal(JSON.stringify(report.structuredContent).includes("stdout"), false);

  const arguments_ = { action: "pause" as const, reason: "operator review", operationId: "pause-211" };
  const denied = await client.callTool({ name: "pirx_orchestrator_control", arguments: arguments_ });
  assert.equal(denied.isError, true);
  assert.equal(control.calls.length, 0);
  const allowed = await client.callTool({ name: "pirx_orchestrator_control", arguments: arguments_, _meta: { [HOST_AUTHORIZATION_META_KEY]: createHostAuthorization(secret, "pirx_orchestrator_control", arguments_, arguments_.operationId) } });
  assert.notEqual(allowed.isError, true);
  assert.equal((allowed.structuredContent as { requestedMode: string }).requestedMode, "paused");
  assert.equal(control.calls.length, 1);

  const shutdownArguments = { action: "arm" as const, operationId: "shutdown-212", target: "queue_drained" as const, reason: "power off after Queue" };
  const shutdownDenied = await client.callTool({ name: "pirx_orchestrator_shutdown", arguments: shutdownArguments });
  assert.equal(shutdownDenied.isError, true);
  const shutdown = await client.callTool({ name: "pirx_orchestrator_shutdown", arguments: shutdownArguments, _meta: { [HOST_AUTHORIZATION_META_KEY]: createHostAuthorization(secret, "pirx_orchestrator_shutdown", shutdownArguments, shutdownArguments.operationId) } });
  assert.notEqual(shutdown.isError, true);
  assert.equal((shutdown.structuredContent as { request: { state: string } }).request.state, "armed");
});

test("unconfigured orchestrator tools remain listed and return controlled results", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-orchestrator-unconfigured-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ environment: { PIRX_TOOL_PROFILE: "operations", XDG_CONFIG_HOME: root }, obsidianVault: new ObsidianVault(root) });
  const client = new Client({ name: "pirx-orchestrator-unconfigured", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const tools = await client.listTools();
  assert.equal(tools.tools.some((tool) => tool.name === "pirx_orchestrator_status"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "pirx_orchestrator_shutdown"), true);
  assert.equal(tools.tools.some((tool) => tool.name === "pirx_execution_report"), true);
  const status = await client.callTool({ name: "pirx_orchestrator_status", arguments: {} });
  assert.equal(status.isError, true);
  assert.match(JSON.stringify(status.structuredContent), /unconfigured/u);
  const report = await client.callTool({ name: "pirx_execution_report", arguments: {} });
  assert.equal(report.isError, true);
  assert.match(JSON.stringify(report.structuredContent), /unconfigured/u);
});

test("MCP reads a blocked Attempt diagnostic from SQLite and distinguishes a failed read", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-orchestrator-blocked-"));
  const filename = join(root, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  context.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });

  const task = createTask({ id: "blocked-task" as TaskId, goal: "Fix fixture", scope: "test", acceptanceCriteria: ["fixed"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: now });
  if (!task.ok) throw new Error("Task fixture failed");
  assert.equal(store.tasks.create(task.value).outcome, "success");
  const attemptId = "blocked-attempt" as AttemptId;
  const started = store.startAttempt(task.value.id, { id: attemptId, worker: "pirx", provider: "claude-code" }, now);
  if (started.outcome !== "success") throw new Error("Attempt fixture failed");
  const at = "2026-10-30T13:01:00.000Z" as UtcTimestamp;
  const diagnostic = createWorkerFailureDiagnostic("timeout", { durationMs: 30_000 });
  const finished = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "FAILED", blockingReason: "Worker timed out", diagnostic }, at);
  const blocked = transitionTask(started.value.task, "in_progress", { type: "block", reason: "Worker timed out" }, at);
  if (!finished.ok || !blocked.ok) throw new Error("Terminal fixture failed");
  assert.equal(store.attempts.update(finished.value, "running").outcome, "success");
  assert.equal(store.tasks.update(blocked.value, { state: "in_progress", updatedAt: started.value.task.updatedAt }).outcome, "success");
  assert.equal(store.selection.synchronize({ taskId: task.value.id, queueOrder: 10, dependencyState: "known", blockers: [], synchronizedAt: at }).outcome, "success");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ environment: { PIRX_TOOL_PROFILE: "operations", XDG_CONFIG_HOME: root, PIRX_ORCHESTRATOR_DATABASE: filename } });
  const client = new Client({ name: "pirx-blocked-status-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    store.database.exec("BEGIN IMMEDIATE");
    const result = await client.callTool({ name: "pirx_orchestrator_status", arguments: {} })
      .finally(() => store.database.exec("ROLLBACK"));
    assert.notEqual(result.isError, true);
    const snapshot = (result.structuredContent as { snapshot: OrchestratorStatusSnapshot }).snapshot;
    assert.equal(snapshot.attentionRequired?.task.id, task.value.id);
    assert.equal(snapshot.attentionRequired?.attempt?.id, attemptId);
    assert.deepEqual(snapshot.attentionRequired?.attempt?.diagnostic, diagnostic);

    store.database.prepare("UPDATE runtime_attempts SET diagnostic_json = ? WHERE id = ?").run('{"unsafe":"private-fixture"}', attemptId);
    const log = context.mock.method(console, "error", () => undefined);
    const failure = await client.callTool({ name: "pirx_orchestrator_status", arguments: {} });
    assert.equal(failure.isError, true);
    const error = failure.structuredContent as { outcome?: string; message?: string };
    assert.equal(error.outcome, "unavailable");
    assert.match(String(error.message), /Attempt history could not be read/u);
    assert.equal(log.mock.callCount(), 1);
    assert.match(String(log.mock.calls[0]?.arguments[0]), /orchestrator_status_read_failed/u);
    assert.doesNotMatch(JSON.stringify([failure, log.mock.calls[0]?.arguments]), /private-fixture/u);

    store.database.prepare("DELETE FROM runtime_schema_migrations WHERE version = ?").run(RUNTIME_STORAGE_SCHEMA_VERSION);
    const incompatible = await client.callTool({ name: "pirx_orchestrator_status", arguments: {} });
    assert.equal(incompatible.isError, true);
    assert.match(JSON.stringify(incompatible.structuredContent), /Incompatible SQLite runtime schema/u);
    assert.equal(store.database.prepare("SELECT version FROM runtime_schema_migrations WHERE version = ?").get(RUNTIME_STORAGE_SCHEMA_VERSION), undefined);
  } finally { await client.close(); await server.close(); }
});

test("MCP Task history pages persisted Attempts and resolves the repository explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-task-history-"));
  const filename = join(root, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  try {
    for (const [taskId, repository] of [["task-one", "first"], ["task-two", "second"], ["task-three", "second"]] as const) {
      const task = createTask({ id: taskId as TaskId, githubReference: { owner: "Pirx", repository, issueNumber: 42 }, goal: "Test fixture", scope: "fixture", acceptanceCriteria: ["ok"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: now });
      if (!task.ok) throw new Error("Task fixture failed");
      assert.equal(store.tasks.create(task.value).outcome, "success");
    }
    const t1 = "2026-10-30T13:01:00.000Z" as UtcTimestamp;
    const first = store.startAttempt("task-one", { id: "attempt-one" as AttemptId, worker: "pirx", provider: "claude-code" }, now);
    if (first.outcome !== "success") throw new Error("Attempt fixture failed");
    const diagnostic = createWorkerFailureDiagnostic("timeout", { stage: "process", correlationId: "fixture-correlation" });
    const failed = transitionAttempt(first.value.attempt, "running", { type: "finish", result: "FAILED", blockingReason: "timed out", diagnostic }, t1);
    if (!failed.ok) throw new Error("Terminal Attempt fixture failed");
    assert.equal(store.attempts.update(failed.value, "running").outcome, "success");
    const branch = "pirx/task-history";
    const revision = "a".repeat(40);
    const second = store.startAttempt("task-one", { id: "attempt-two" as AttemptId, worker: "pirx", provider: "claude-code", branch }, t1);
    if (second.outcome !== "success") throw new Error("Retry fixture failed");
    const terminal = transitionAttempt(second.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: revision }, t1);
    if (!terminal.ok) throw new Error("Completed Attempt fixture failed");
    assert.equal(store.attempts.update(terminal.value, "running").outcome, "success");
    const history = store.attempts.listByTask("task-one");
    if (history.outcome !== "success") throw new Error("History fixture failed");
    const done = transitionTask(second.value.task, "in_progress", { type: "complete", evidence: { attemptId: terminal.value.id, finalCommit: revision, evidenceReference: "test:completed" }, attempts: history.value }, t1);
    if (!done.ok) throw new Error("Task completion fixture failed");
    assert.equal(store.tasks.update(done.value, { state: "in_progress", updatedAt: second.value.task.updatedAt }).outcome, "success");
  } finally { store.close(); }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ environment: { PIRX_TOOL_PROFILE: "operations", XDG_CONFIG_HOME: root, PIRX_ORCHESTRATOR_DATABASE: filename } });
  const client = new Client({ name: "pirx-task-history-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const lookup = async (arguments_: Record<string, unknown>) => {
    const reply = await client.callTool({ name: "pirx_task_history", arguments: arguments_ });
    return JSON.parse(JSON.stringify(reply.structuredContent));
  };
  try {
    const first = await lookup({ repository: "pirx/first", issueNumber: 42, limit: 1 });
    assert.equal(first.task.id, "task-one");
    assert.equal(first.task.state, "completed");
    assert.equal(first.attempts[0].correlationId, "fixture-correlation");
    assert.equal(first.nextAfterOrdinal, 1);
    const second = await lookup({ taskId: first.task.id, afterOrdinal: first.nextAfterOrdinal, limit: 1 });
    assert.equal(second.attempts[0].id, "attempt-two");
    assert.equal(second.nextAfterOrdinal, undefined);
    assert.equal((await lookup(first.attempts[0].diagnosticReference)).diagnostic.code, "timeout");
    assert.equal((await lookup({ attemptId: "attempt-two" })).diagnostic, null);
    assert.deepEqual((await lookup({ repository: "Pirx/second", issueNumber: 42 })).taskIds, ["task-three", "task-two"]);
    assert.equal((await lookup({ repository: "Pirx/missing", issueNumber: 42 })).outcome, "not_found");
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
