import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RuntimeSqliteStore,
  evaluateWorkerAvailability,
  normalizeWorkerAvailabilityInput,
  type UtcTimestamp,
  type WorkerAvailabilityInput,
} from "../src/index.js";

const t0 = "2026-10-30T10:00:00.000Z" as UtcTimestamp;
const t1 = "2026-10-30T11:00:00.000Z" as UtcTimestamp;
const t2 = "2026-10-30T12:00:00.000Z" as UtcTimestamp;

async function fixture(): Promise<{ directory: string; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-worker-availability-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}

function cooldown(overrides: Partial<WorkerAvailabilityInput> = {}): WorkerAvailabilityInput {
  return {
    workerId: "pirx-worker-1",
    provider: "claude-code",
    state: "cooldown",
    startedAt: t0,
    expiresAt: t2,
    reason: "Provider quota is exhausted.",
    providerMetadata: { source: "provider_reset", resetAt: t2, quotaBucket: "five-hour-window", providerStatusCode: "quota_exhausted" },
    ...overrides,
  };
}

test("validates bounded Worker availability and cooldown invariants", () => {
  assert.deepEqual(normalizeWorkerAvailabilityInput(cooldown()), cooldown());
  assert.throws(() => normalizeWorkerAvailabilityInput(cooldown({ expiresAt: t0 })), /future expiry/u);
  const { expiresAt: _expiry, ...withoutExpiry } = cooldown();
  assert.throws(() => normalizeWorkerAvailabilityInput(withoutExpiry), /future expiry/u);
  assert.throws(() => normalizeWorkerAvailabilityInput(cooldown({ state: "unavailable", expiresAt: t2 })), /Only a Worker cooldown/u);
  const { expiresAt: _unknownExpiry, reason: _unknownReason, ...unknownWithoutReason } = cooldown({ state: "unknown" });
  assert.throws(() => normalizeWorkerAvailabilityInput(unknownWithoutReason), /requires a reason/u);
  assert.throws(() => normalizeWorkerAvailabilityInput(cooldown({ providerMetadata: { source: "bounded_default", retryAfterMs: 8 * 24 * 60 * 60 * 1_000 } })), /retry-after/u);
});

test("evaluates active and expired cooldowns deterministically without process memory", () => {
  const record = { schemaVersion: 1 as const, sequence: 1, ...cooldown() };
  const active = evaluateWorkerAvailability(record, t1);
  assert.equal(active.availability, "unavailable");
  assert.equal(active.cooldownUntil, t2);
  const expired = evaluateWorkerAvailability(record, t2);
  assert.equal(expired.availability, "available");
  assert.equal(expired.recordedState, "cooldown");
  assert.equal(expired.cooldownUntil, undefined);
  const missing = evaluateWorkerAvailability(undefined, t1, { workerId: "pirx", provider: "codex" });
  assert.equal(missing.availability, "unknown");
  assert.equal(missing.recordedState, "missing");
});

test("persists append-only availability history idempotently and rejects identity conflicts", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    const first = store.workerAvailability.record(cooldown());
    assert.equal(first.outcome, "success");
    if (first.outcome !== "success") return;
    assert.equal(first.value.sequence, 1);
    assert.deepEqual(store.workerAvailability.record(cooldown()), first);
    assert.equal(store.workerAvailability.record(cooldown({ reason: "Conflicting reason." })).outcome, "conflict");

    const available = store.workerAvailability.record({ workerId: "pirx-worker-1", provider: "claude-code", state: "available", startedAt: t2, reason: "Provider probe succeeded." });
    assert.equal(available.outcome, "success");
    const current = store.workerAvailability.current("pirx-worker-1", "claude-code");
    assert.equal(current.outcome, "success");
    if (current.outcome === "success") assert.equal(current.value.state, "available");
    const history = store.workerAvailability.history("pirx-worker-1", "claude-code");
    assert.equal(history.outcome, "success");
    if (history.outcome === "success") assert.deepEqual(history.value.map((value) => value.state), ["cooldown", "available"]);
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("recovers the latest durable cooldown after SQLite restart and evaluates its expiry", async () => {
  const setup = await fixture();
  try {
    const first = RuntimeSqliteStore.open({ filename: setup.filename });
    assert.equal(first.workerAvailability.record(cooldown()).outcome, "success");
    first.close();

    const recovered = RuntimeSqliteStore.open({ filename: setup.filename });
    try {
      const active = recovered.workerAvailability.evaluate("pirx-worker-1", "claude-code", t1);
      assert.equal(active.outcome, "success");
      if (active.outcome === "success") assert.equal(active.value.availability, "unavailable");
      const expired = recovered.workerAvailability.evaluate("pirx-worker-1", "claude-code", t2);
      assert.equal(expired.outcome, "success");
      if (expired.outcome === "success") assert.equal(expired.value.availability, "available");
    } finally { recovered.close(); }
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

test("returns explicit outcomes for missing, invalid and corrupted availability state", async () => {
  const setup = await fixture();
  const store = RuntimeSqliteStore.open({ filename: setup.filename });
  try {
    const missing = store.workerAvailability.evaluate("pirx-worker-1", "claude-code", t1);
    assert.equal(missing.outcome, "success");
    if (missing.outcome === "success") assert.equal(missing.value.availability, "unknown");
    assert.equal(store.workerAvailability.current("bad worker", "claude-code").outcome, "invalid_record");
    assert.equal(store.workerAvailability.record(cooldown({ reason: "x".repeat(513) })).outcome, "invalid_record");

    assert.equal(store.workerAvailability.record(cooldown()).outcome, "success");
    store.database.prepare("UPDATE runtime_worker_availability SET provider_metadata_json = ? WHERE sequence = 1").run(JSON.stringify({ source: "unsupported" }));
    assert.equal(store.workerAvailability.current("pirx-worker-1", "claude-code").outcome, "invalid_record");
  } finally {
    store.close();
    await rm(setup.directory, { recursive: true, force: true });
  }
});
