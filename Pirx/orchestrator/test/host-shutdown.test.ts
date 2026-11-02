import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  HostShutdownRepository,
  LinuxSystemctlPowerOffAdapter,
  RuntimeSqliteStore,
  SqliteHeadlessHostShutdownPort,
  createTask,
  type PowerOffSpawn,
  type SpawnedPowerOffProcess,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-11-02T10:00:00.000Z" as UtcTimestamp;
const t1 = "2026-11-02T10:01:00.000Z" as UtcTimestamp;
const t2 = "2026-11-02T10:02:00.000Z" as UtcTimestamp;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pirx-host-shutdown-"));
  const filename = join(directory, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  return { directory, filename, store, repository: new HostShutdownRepository(store) };
}

test("arms, replays, cancels, rejects conflicts, and survives restart", async () => {
  const value = await fixture();
  try {
    const arm = { action: "arm" as const, operationId: "shutdown-arm-1", target: "queue_drained" as const, reason: "finish Queue", requestedBy: "mcp-chat", requestedAt: t0 };
    const armed = value.repository.command(arm);
    assert.equal(armed.outcome, "applied");
    assert.equal(value.repository.command({ ...arm, requestedAt: t1 }).outcome, "replayed");
    assert.equal(value.repository.command({ ...arm, target: "next_checkpoint", requestedAt: t1 }).outcome, "conflict");
    value.store.close();
    value.store = RuntimeSqliteStore.open({ filename: value.filename });
    value.repository = new HostShutdownRepository(value.store);
    const cancelled = value.repository.command({ action: "cancel", operationId: "shutdown-cancel-1", requestOperationId: arm.operationId, reason: "operator changed plan", requestedBy: "mcp-chat", requestedAt: t1 });
    assert.equal(cancelled.outcome, "applied");
    if (cancelled.outcome === "applied") assert.equal(cancelled.record.state, "cancelled");
    assert.equal(value.repository.command({ action: "cancel", operationId: "shutdown-cancel-2", requestOperationId: arm.operationId, reason: "again", requestedBy: "mcp-chat", requestedAt: t2 }).outcome, "not_cancellable");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("queue drain requires fresh exact idle evidence and no queued or active work", async () => {
  const value = await fixture();
  try {
    assert.equal(value.repository.command({ action: "arm", operationId: "shutdown-queue", target: "queue_drained", reason: "finish Queue", requestedBy: "mcp-chat", requestedAt: t0 }).outcome, "applied");
    assert.equal(value.repository.evaluate({ now: t1, adapterConfigured: true }).outcome, "armed");
    assert.equal(value.repository.evaluate({ now: t1, adapterConfigured: true, queueOutcome: "rate_limited", deliveryOutcome: "idle", cycleOutcome: "idle" }).outcome, "armed");
    const queued = createTask({ id: "shutdown-queued-task" as TaskId, goal: "queued", scope: "queued", acceptanceCriteria: ["done"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
    if (!queued.ok) throw new Error("Task fixture failed.");
    assert.equal(value.store.tasks.create(queued.value).outcome, "success");
    assert.equal(value.store.selection.synchronize({ taskId: queued.value.id, queueOrder: 1, dependencyState: "known", synchronizedAt: t0, blockers: [] }).outcome, "success");
    assert.equal(value.repository.evaluate({ now: t1, adapterConfigured: true, queueOutcome: "synchronized", deliveryOutcome: "idle", cycleOutcome: "idle" }).outcome, "armed");
    value.store.database.prepare("UPDATE runtime_task_selection SET queue_order = NULL WHERE task_id = ?").run(queued.value.id);
    const triggered = value.repository.evaluate({ now: t2, adapterConfigured: true, queueOutcome: "synchronized", deliveryOutcome: "idle", cycleOutcome: "idle" });
    assert.equal(triggered.outcome, "triggered");
    assert.equal(value.repository.transition("triggered", "draining", t2).outcome, "success");
    assert.equal(value.repository.transition("draining", "poweroff_requested", t2).outcome, "success");
    assert.equal(value.repository.evaluate({ now: t2, adapterConfigured: true, queueOutcome: "synchronized", deliveryOutcome: "idle", cycleOutcome: "idle" }).outcome, "idle");
    assert.equal(value.repository.transition("poweroff_requested", "accepted", t2, "poweroff_command_accepted").outcome, "success");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("an armed request fails closed when the host adapter is not explicitly configured", async () => {
  const value = await fixture();
  try {
    assert.equal(value.repository.command({ action: "arm", operationId: "shutdown-no-adapter", target: "queue_drained", reason: "finish Queue", requestedBy: "mcp-chat", requestedAt: t0 }).outcome, "applied");
    const result = value.repository.evaluate({ now: t1, adapterConfigured: false, queueOutcome: "synchronized", deliveryOutcome: "idle", cycleOutcome: "idle" });
    assert.equal(result.outcome, "error");
    const durable = value.repository.get();
    assert.equal(durable.outcome, "success");
    if (durable.outcome === "success") assert.deepEqual({ state: durable.value.state, outcome: durable.value.terminalOutcome }, { state: "failed", outcome: "host_poweroff_adapter_not_configured" });
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("next checkpoint ignores the baseline, waits for safe completion, and may leave later Queue work", async () => {
  const value = await fixture();
  try {
    const task = createTask({ id: "checkpoint-shutdown-task" as TaskId, goal: "checkpoint", scope: "checkpoint", acceptanceCriteria: ["saved"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
    const queued = createTask({ id: "later-shutdown-task" as TaskId, goal: "later", scope: "later", acceptanceCriteria: ["later"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
    if (!task.ok || !queued.ok) throw new Error("Task fixture failed.");
    assert.equal(value.store.tasks.create(task.value).outcome, "success");
    assert.equal(value.store.tasks.create(queued.value).outcome, "success");
    assert.equal(value.store.selection.synchronize({ taskId: queued.value.id, queueOrder: 2, dependencyState: "known", synchronizedAt: t0, blockers: [] }).outcome, "success");
    const started = value.store.startAttempt(task.value.id, { id: "checkpoint-shutdown-attempt" as never, worker: "pirx", provider: "claude-code" }, t1);
    assert.equal(started.outcome, "success");
    value.store.database.prepare("INSERT INTO runtime_checkpoints (id, schema_version, task_id, previous_attempt_id, trigger, created_at, created_sequence, content_json, content_hash) VALUES ('shutdown-checkpoint-baseline', 1, ?, 'checkpoint-shutdown-attempt', 'EXPLICIT_PAUSE', ?, 1, '{}', ?)").run(task.value.id, t1, "0".repeat(64));
    assert.equal(value.repository.command({ action: "arm", operationId: "shutdown-checkpoint", target: "next_checkpoint", reason: "stop at checkpoint", requestedBy: "mcp-chat", requestedAt: t1 }).outcome, "applied");
    assert.equal(value.repository.evaluate({ now: t1, adapterConfigured: true }).outcome, "armed");
    value.store.database.prepare("INSERT INTO runtime_checkpoints (id, schema_version, task_id, previous_attempt_id, trigger, created_at, created_sequence, content_json, content_hash) VALUES ('shutdown-checkpoint-1', 1, ?, 'checkpoint-shutdown-attempt', 'EXPLICIT_PAUSE', ?, 2, '{}', ?)").run(task.value.id, t2, "0".repeat(64));
    assert.equal(value.repository.evaluate({ now: t2, adapterConfigured: true }).outcome, "armed");
    value.store.database.prepare("UPDATE runtime_attempts SET state = 'terminal', result = 'FAILED', ended_at = ?, blocking_reason = 'checkpoint saved' WHERE id = 'checkpoint-shutdown-attempt'").run(t2);
    value.store.database.prepare("UPDATE runtime_tasks SET state = 'failed', updated_at = ?, blocking_reason = 'checkpoint saved' WHERE id = ?").run(t2, task.value.id);
    const triggered = value.repository.evaluate({ now: t2, adapterConfigured: true });
    assert.equal(triggered.outcome, "triggered");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("Linux adapter uses one exact shell-free systemctl command and normalizes rejection", async () => {
  const calls: Array<{ executable: string; args: readonly string[]; shell: boolean; env: NodeJS.ProcessEnv }> = [];
  const spawning: PowerOffSpawn = (executable, args, options) => {
    calls.push({ executable, args, shell: options.shell, env: options.env });
    const emitter = new EventEmitter();
    const child: SpawnedPowerOffProcess = {
      stdout: null, stderr: null, kill: () => true,
      once(event, listener) { emitter.once(event, listener); return this; },
    };
    queueMicrotask(() => emitter.emit("close", 0, null));
    return child;
  };
  const accepted = await new LinuxSystemctlPowerOffAdapter({ spawn: spawning, timeoutMs: 100 }).powerOff();
  assert.equal(accepted.outcome, "accepted");
  assert.deepEqual(calls, [{ executable: "/usr/bin/systemctl", args: ["poweroff", "--no-wall"], shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C" } }]);
  const rejectedSpawn: PowerOffSpawn = () => { throw new Error("raw provider detail"); };
  const rejected = await new LinuxSystemctlPowerOffAdapter({ spawn: rejectedSpawn, timeoutMs: 100 }).powerOff();
  assert.deepEqual(rejected, { outcome: "rejected", message: "Host power-off command could not be started." });
});

test("post-close adapter acceptance is persisted once and is never replayed after restart", async () => {
  const value = await fixture();
  let calls = 0;
  const adapter = { powerOff: async () => { calls += 1; return { outcome: "accepted" as const, message: "accepted" }; } };
  try {
    assert.equal(value.repository.command({ action: "arm", operationId: "shutdown-post-close", target: "queue_drained", reason: "finish Queue", requestedBy: "mcp-chat", requestedAt: t0 }).outcome, "applied");
    const port = new SqliteHeadlessHostShutdownPort(value.store, value.filename, adapter, () => t1);
    assert.equal(port.evaluate({ queueOutcome: "synchronized", deliveryOutcome: "idle", cycleOutcome: "idle" }).outcome, "triggered");
    assert.equal(port.beginDrain().outcome, "success");
    assert.equal(port.powerOffRequested().outcome, "success");
    value.store.close();
    assert.equal((await port.powerOffAfterClose()).outcome, "accepted");
    assert.equal(calls, 1);
    value.store = RuntimeSqliteStore.open({ filename: value.filename });
    value.repository = new HostShutdownRepository(value.store);
    const durable = value.repository.get();
    assert.equal(durable.outcome, "success");
    if (durable.outcome === "success") assert.equal(durable.value.state, "accepted");
    assert.equal(value.repository.evaluate({ now: t2, adapterConfigured: true, queueOutcome: "synchronized", deliveryOutcome: "idle", cycleOutcome: "idle" }).outcome, "idle");
    assert.equal(calls, 1);
  } finally { try { value.store.close(); } catch { /* already closed between phases */ } await rm(value.directory, { recursive: true, force: true }); }
});
