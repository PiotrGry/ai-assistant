import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SqliteActionLedger, mutationId } from "../src/action-ledger.js";
import { SqliteStore } from "../src/storage/sqlite.js";

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "pirx-action-ledger-test-"));
  const store = SqliteStore.open({ filename: join(directory, "pirx.sqlite") });
  store.insertRunEnvironment({
    id: "env-1",
    createdAt: "2026-09-09T10:00:00.000Z",
    payload: { schema_version: 1 },
  });
  store.insertSession({
    id: "session-1",
    environmentId: "env-1",
    startedAt: "2026-09-09T10:00:00.000Z",
    status: "active",
  });
  store.insertTurn({
    id: "turn-1",
    sessionId: "session-1",
    sequence: 0,
    startedAt: "2026-09-09T10:00:00.000Z",
    status: "started",
    userPrompt: "Dodaj wpis.",
    payload: { schema_version: 1 },
  });
  store.insertTurn({
    id: "turn-2",
    sessionId: "session-1",
    sequence: 1,
    startedAt: "2026-09-09T10:01:00.000Z",
    status: "started",
    userPrompt: "Dodaj drugi wpis.",
    payload: { schema_version: 1 },
  });
  return { directory, store };
}

const input = {
  sessionId: "session-1",
  turnId: "turn-1",
  sequence: 0,
  target: "obsidian:Notes/test.md",
  toolName: "obsidian_append",
  arguments: { content: "nowy wpis", path: "Notes/test.md" },
  authorization: { user_confirmed: true },
} as const;

test("action ledger persists planned, started and succeeded transitions", async () => {
  const { directory, store } = await createStore();
  try {
    const ledger = new SqliteActionLedger(store);
    const plan = ledger.plan(input);
    assert.equal(plan.alreadySucceeded, false);
    assert.equal(plan.requiresReconciliation, false);
    ledger.start(plan);
    ledger.finish(plan, "succeeded", { external_id: "note-1" });

    assert.equal(store.latestActionState(plan.mutationId)?.state, "succeeded");
    assert.equal(store.count("action_events"), 3);
    assert.equal(store.count("operations"), 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same turn mutation is deduplicated, while a later turn is distinct", async () => {
  const { directory, store } = await createStore();
  try {
    const ledger = new SqliteActionLedger(store);
    const first = ledger.plan(input);
    ledger.start(first);
    ledger.finish(first, "succeeded");

    const duplicate = ledger.plan(input);
    assert.equal(duplicate.alreadySucceeded, true);
    assert.equal(duplicate.operationId, "");

    const laterTurn = ledger.plan({ ...input, turnId: "turn-2" });
    assert.notEqual(laterTurn.mutationId, first.mutationId);
    assert.notEqual(laterTurn.operationId, "");
    assert.notEqual(mutationId(input), mutationId({ ...input, turnId: "turn-2" }));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown outcome requires reconciliation before any retry", async () => {
  const { directory, store } = await createStore();
  try {
    const ledger = new SqliteActionLedger(store);
    const plan = ledger.plan(input);
    ledger.start(plan);
    ledger.finish(plan, "unknown");

    const retry = ledger.plan(input);
    assert.equal(retry.requiresReconciliation, true);
    assert.equal(retry.alreadySucceeded, false);
    assert.equal(retry.operationId, "");
    assert.equal(store.count("operations"), 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
