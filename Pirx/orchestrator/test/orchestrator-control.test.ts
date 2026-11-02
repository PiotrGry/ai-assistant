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
  type TaskId,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-10-30T12:00:00.000Z" as UtcTimestamp;
const t1 = "2026-10-30T12:01:00.000Z" as UtcTimestamp;
const t2 = "2026-10-30T12:05:00.000Z" as UtcTimestamp;

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
