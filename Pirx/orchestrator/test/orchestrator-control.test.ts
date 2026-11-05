import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  OrchestratorControlRepository,
  SqliteHeadlessControlPort,
  HostShutdownRepository,
  RuntimeSqliteStore,
  createTask,
  transitionTask,
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-10-30T12:00:00.000Z" as UtcTimestamp;
const t1 = "2026-10-30T12:01:00.000Z" as UtcTimestamp;
const t2 = "2026-10-30T12:05:00.000Z" as UtcTimestamp;

test("status identifies a missing diagnostic even when its heartbeat was stored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-observation-failure-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  try {
    store.database.exec("CREATE TRIGGER fail_diagnostic BEFORE INSERT ON runtime_orchestrator_diagnostics BEGIN SELECT RAISE(FAIL, 'injected'); END");
    new SqliteHeadlessControlPort(store, () => t1).observe({ schemaVersion: 1, event: "queue", outcome: "failed" });
    const status = new OrchestratorControlRepository(store).status(t1, 120_000);
    assert.equal(status.outcome, "success");
    if (status.outcome !== "success") return;
    assert.equal(status.value.heartbeatStale, false);
    assert.equal((status.value as { lastPersistedObservationIncomplete?: boolean }).lastPersistedObservationIncomplete, true);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("reports each independent persistence failure and recovers without exposing secrets", async () => {
  for (const [failDiagnostic, failHeartbeat] of [[true, false], [false, true], [true, true]] as const) {
    const directory = await mkdtemp(join(tmpdir(), "pirx-observation-faults-"));
    const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
    const reports: Array<{ stage: string; code: string; otherWrite: string; correlationId?: string }> = [];
    try {
      let now = t0;
      const control = new SqliteHeadlessControlPort(store, () => now, (failure) => reports.push(failure));
      control.observe({ schemaVersion: 1, event: "starting", outcome: "starting" });
      now = t1;
      if (failDiagnostic) store.database.exec("CREATE TRIGGER fail_diagnostic BEFORE INSERT ON runtime_orchestrator_diagnostics BEGIN SELECT RAISE(FAIL, 'private diagnostic'); END");
      if (failHeartbeat) store.database.exec("CREATE TRIGGER fail_heartbeat BEFORE UPDATE ON runtime_orchestrator_control BEGIN SELECT RAISE(FAIL, 'private heartbeat'); END");
      control.observe({ schemaVersion: 1, event: "queue", outcome: "failed", details: { correlationId: "Bearer hidden-token" } });
      assert.deepEqual(reports.map((item) => item.stage), [...(failDiagnostic ? ["diagnostic"] : []), ...(failHeartbeat ? ["heartbeat"] : [])]);
      assert.ok(reports.every((item) => item.code === "storage_error" && item.correlationId === "Bearer [REDACTED]"));
      assert.ok(reports.every((item) => item.otherWrite === (failDiagnostic && failHeartbeat ? "failed" : "success")));
      assert.doesNotMatch(JSON.stringify(reports), /hidden-token|private diagnostic|private heartbeat/u);
      const repository = new OrchestratorControlRepository(store);
      const status = repository.status(t1, 120_000);
      assert.equal(status.outcome, "success");
      if (status.outcome === "success" && !(failDiagnostic && failHeartbeat)) assert.equal(status.value.lastPersistedObservationIncomplete, true);
      if (status.outcome === "success" && failDiagnostic && failHeartbeat) assert.equal(status.value.heartbeatAt, t0);
      if (failDiagnostic) store.database.exec("DROP TRIGGER fail_diagnostic");
      if (failHeartbeat) store.database.exec("DROP TRIGGER fail_heartbeat");
      control.observe({ schemaVersion: 1, event: "queue", outcome: "recovered" });
      const recovered = repository.status(t1, 120_000);
      assert.equal(recovered.outcome, "success");
      if (recovered.outcome === "success") assert.equal(recovered.value.lastPersistedObservationIncomplete, false);
      const throwingLogger = new SqliteHeadlessControlPort(store, () => t1, () => { throw new Error("logger failed"); });
      store.database.exec("CREATE TRIGGER fail_again BEFORE INSERT ON runtime_orchestrator_diagnostics BEGIN SELECT RAISE(FAIL, 'injected'); END");
      assert.doesNotThrow(() => throwingLogger.observe({ schemaVersion: 1, event: "cycle", outcome: "idle" }));
      const absentCorrelation: Array<{ correlationId?: string }> = [];
      new SqliteHeadlessControlPort(store, () => t1, (failure) => absentCorrelation.push(failure)).observe({ schemaVersion: 1, event: "cycle", outcome: "idle" });
      assert.equal(absentCorrelation[0]?.correlationId, undefined);
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("upgrades an existing control record conservatively", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-observation-migration-"));
  const filename = join(directory, "runtime.sqlite");
  let store = RuntimeSqliteStore.open({ filename });
  try {
    assert.equal(new OrchestratorControlRepository(store).heartbeat("running", t0).outcome, "success");
    store.database.exec("DROP INDEX runtime_agent_questions_attempt; ALTER TABLE runtime_agent_questions DROP COLUMN failure_code; ALTER TABLE runtime_agent_questions DROP COLUMN owner_pid; ALTER TABLE runtime_agent_questions DROP COLUMN owner_host; DELETE FROM runtime_schema_migrations WHERE version = 34; ALTER TABLE runtime_orchestrator_control DROP COLUMN diagnostic_incomplete; ALTER TABLE runtime_orchestrator_control DROP COLUMN diagnostic_sequence; DELETE FROM runtime_schema_migrations WHERE version = 33");
    store.close();
    store = RuntimeSqliteStore.open({ filename });
    const status = new OrchestratorControlRepository(store).status(t1, 120_000);
    assert.equal(status.outcome, "success");
    if (status.outcome === "success") {
      assert.equal(status.value.heartbeatAt, t0);
      assert.equal(status.value.lastPersistedObservationIncomplete, true);
    }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("one status read identifies the queued blocked Task without searching journal history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-control-attention-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  try {
    const task = createTask({ id: "attention-task" as TaskId, githubReference: { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 462 }, goal: "Fix assigned bug", scope: "test", acceptanceCriteria: ["fixed"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: t0 });
    assert.equal(task.ok, true); if (!task.ok) return;
    assert.equal(store.tasks.create(task.value).outcome, "success");
    const blocked = transitionTask(task.value, "ready", { type: "block", reason: "binding mismatch" }, t1);
    assert.equal(blocked.ok, true); if (!blocked.ok) return;
    assert.equal(store.tasks.update(blocked.value, { state: "ready", updatedAt: task.value.updatedAt }).outcome, "success");
    assert.equal(store.selection.synchronize({ taskId: task.value.id, queueOrder: 10, dependencyState: "known", blockers: [], synchronizedAt: t1 }).outcome, "success");
    const status = new OrchestratorControlRepository(store).status(t2, 120_000);
    assert.equal(status.outcome, "success"); if (status.outcome !== "success") return;
    assert.equal(status.value.attentionRequired?.task.issueNumber, 462);
    assert.equal(status.value.attentionRequired?.task.state, "blocked");
    assert.equal(status.value.attentionRequired?.reason, "binding mismatch");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("status keeps the last meaningful execution result after idle cycles and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-control-last-result-"));
  const filename = join(directory, "runtime.sqlite");
  let store = RuntimeSqliteStore.open({ filename });
  try {
    const control = new SqliteHeadlessControlPort(store, () => t1);
    control.observe({ schemaVersion: 1, event: "cycle", outcome: "failed", reason: "Worker identity or workspace binding did not match.", details: { taskId: "gh-462", attemptId: "attempt-2" } });
    for (let i = 0; i < 20; i++) control.observe({ schemaVersion: 1, event: "cycle", outcome: "idle", reason: "no_runnable_task" });
    store.close(); store = RuntimeSqliteStore.open({ filename });
    const status = new OrchestratorControlRepository(store).status(t2, 120_000);
    assert.equal(status.outcome, "success");
    if (status.outcome !== "success") return;
    assert.equal(status.value.lastCycleOutcome, "idle");
    const cycles = status.value.diagnostics?.filter((item) => item.event === "cycle");
    assert.deepEqual(cycles?.map((item) => item.outcome), ["idle", "failed"]);
    assert.deepEqual(cycles?.[1]?.details, { taskId: "gh-462", attemptId: "attempt-2" });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("preserves complete source diagnostics across restart and paginates without losing details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-full-diagnostic-"));
  const filename = join(directory, "runtime.sqlite");
  let store = RuntimeSqliteStore.open({ filename });
  try {
    const reason = `Duplicate order in closed Issues. ${"detailed source context; ".repeat(600)} END`;
    const control = new SqliteHeadlessControlPort(store, () => t1);
    control.observe({ schemaVersion: 1, event: "queue", outcome: "invalid_snapshot", reason, details: { issues: [48, 189], authorization: "Bearer never-expose-me", nested: { token: "private-value" } } });
    control.observe({ schemaVersion: 1, event: "control", outcome: "running" });
    store.close(); store = RuntimeSqliteStore.open({ filename });
    const repository = new OrchestratorControlRepository(store);
    const status = repository.status(t2, 120_000);
    assert.equal(status.outcome, "success");
    if (status.outcome !== "success") return;
    const queue = status.value.diagnostics?.find((item) => item.event === "queue");
    assert.equal(queue?.reason, reason);
    let reconstructed = ""; let offset = 0;
    do {
      const chunk = repository.diagnostic(queue!.sequence, offset, 1000);
      assert.equal(chunk.outcome, "success"); if (chunk.outcome !== "success") return;
      reconstructed += chunk.value.text;
      if (chunk.value.nextOffset === undefined) break;
      offset = chunk.value.nextOffset;
    } while (true);
    assert.equal(JSON.parse(reconstructed).reason, reason);
    assert.deepEqual(JSON.parse(reconstructed).details.issues, [48, 189]);
    assert.equal(reconstructed.includes("never-expose-me"), false);
    assert.equal(reconstructed.includes("private-value"), false);
    assert.equal(repository.diagnostic(999).outcome, "not_found");
    assert.equal(repository.diagnostic(1, -1).outcome, "invalid_record");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("persists idempotent pause/resume control and stale heartbeat across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-control-"));
  const filename = join(directory, "runtime.sqlite");
  let store = RuntimeSqliteStore.open({ filename });
  try {
    let control = new OrchestratorControlRepository(store);
    assert.equal(control.get().outcome, "not_found");
    assert.equal(control.heartbeat("running", t0, { queue: "synchronized", cycle: "idle" }).outcome, "success");
    const pause = control.request({ operationId: "control-pause-1", action: "pause", reason: "operator review", requestedBy: "mcp-chat", requestedAt: t1 });
    assert.equal(pause.outcome, "applied");
    if (pause.outcome === "applied") assert.equal(pause.record.requestedMode, "paused");
    const replay = control.request({ operationId: "control-pause-1", action: "pause", reason: "operator review", requestedBy: "mcp-chat", requestedAt: t2 });
    assert.equal(replay.outcome, "replayed");
    assert.equal(control.request({ operationId: "control-pause-1", action: "resume", reason: "operator review", requestedBy: "mcp-chat", requestedAt: t2 }).outcome, "conflict");
    store.close();
    store = RuntimeSqliteStore.open({ filename });
    control = new OrchestratorControlRepository(store);
    const snapshot = control.status(t2, 60_000);
    assert.equal(snapshot.outcome, "success");
    if (snapshot.outcome === "success") {
      assert.equal(snapshot.value.requestedMode, "paused");
      assert.equal(snapshot.value.heartbeatStale, true);
      assert.equal(snapshot.value.lastQueueOutcome, "synchronized");
    }
    const resumed = control.request({ operationId: "control-resume-1", action: "resume", reason: "continue Queue", requestedBy: "mcp-chat", requestedAt: t2 });
    assert.equal(resumed.outcome, "applied");
    if (resumed.outcome === "applied") assert.equal(resumed.record.requestedMode, "running");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("returns bounded active and next Queue entity summaries without task content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-control-status-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  try {
    const active = createTask({ id: "active-control-task" as TaskId, githubReference: { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 211 }, goal: "secret-free status", scope: "do not expose this scope", acceptanceCriteria: ["bounded"], priority: 100, risk: "high", requiredCapabilities: ["repository.read"], createdAt: t0 });
    const next = createTask({ id: "next-control-task" as TaskId, githubReference: { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 212 }, goal: "next", scope: "next scope", acceptanceCriteria: ["queued"], priority: 100, risk: "high", requiredCapabilities: ["repository.read"], createdAt: t0 });
    if (!active.ok || !next.ok) throw new Error("Task fixtures failed.");
    assert.equal(store.tasks.create(active.value).outcome, "success");
    assert.equal(store.tasks.create(next.value).outcome, "success");
    assert.equal(store.selection.synchronize({ taskId: next.value.id, queueOrder: 500, dependencyState: "known", synchronizedAt: t0, blockers: [] }).outcome, "success");
    assert.equal(store.startAttempt(active.value.id, { id: "active-control-attempt" as never, worker: "pirx", provider: "claude-code", branch: "pirx/task-control" }, t1).outcome, "success");
    const control = new OrchestratorControlRepository(store);
    assert.equal(new HostShutdownRepository(store).command({ action: "arm", operationId: "status-shutdown", target: "next_checkpoint", reason: "private operator reason", requestedBy: "mcp-chat", requestedAt: t1 }).outcome, "applied");
    assert.equal(control.heartbeat("running", t1).outcome, "success");
    const result = control.status(t1, 120_000);
    assert.equal(result.outcome, "success");
    if (result.outcome === "success") {
      assert.equal(result.value.activeTask?.issueNumber, 211);
      assert.equal(result.value.activeAttempt?.ordinal, 1);
      assert.equal(result.value.nextQueuedTask?.issueNumber, 212);
      assert.equal(result.value.nextQueuedTask?.queueOrder, 500);
      assert.equal(result.value.hostShutdown?.state, "armed");
      assert.equal(JSON.stringify(result.value).includes("do not expose"), false);
      assert.equal(JSON.stringify(result.value).includes("private operator reason"), false);
    }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
