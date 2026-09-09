import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SqliteStore, STORAGE_SCHEMA_VERSION } from "../src/storage/sqlite.js";

test("SQLite store creates the versioned durable schema and keeps relations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-storage-test-"));
  const filename = join(directory, "pirx.db");
  const store = SqliteStore.open({ filename });

  try {
    store.insertRunEnvironment({
      id: "env-1",
      createdAt: "2026-09-09T10:00:00.000Z",
      payload: { model: "test", prompt_sha256: "abc" },
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
      startedAt: "2026-09-09T10:00:01.000Z",
      status: "started",
      userPrompt: "Sprawdź stan.",
      payload: { schema_version: 1 },
    });
    store.insertOperation({
      id: "operation-1",
      sessionId: "session-1",
      turnId: "turn-1",
      sequence: 0,
      kind: "llm",
      startedAt: "2026-09-09T10:00:02.000Z",
      status: "succeeded",
      payload: { prompt_eval_count: null },
    });

    assert.equal(store.count("run_environments"), 1);
    assert.equal(store.count("sessions"), 1);
    assert.equal(store.count("turns"), 1);
    assert.equal(store.count("operations"), 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite store rejects orphan records and remains reopenable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-storage-fk-test-"));
  const filename = join(directory, "pirx.db");
  const store = SqliteStore.open({ filename });

  try {
    assert.throws(
      () =>
        store.insertSession({
          id: "orphan-session",
          environmentId: "missing",
          startedAt: "2026-09-09T10:00:00.000Z",
          status: "active",
        }),
      /FOREIGN KEY|foreign key/iu,
    );
  } finally {
    store.close();
  }

  const reopened = SqliteStore.open({ filename });
  try {
    assert.equal(reopened.count("sessions"), 0);
    assert.equal(STORAGE_SCHEMA_VERSION, 2);
    assert.match(await readFile(filename, "utf8"), /./u);
  } finally {
    reopened.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite recovery closes interrupted work without hiding MCP uncertainty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-storage-recovery-test-"));
  const filename = join(directory, "pirx.db");
  const store = SqliteStore.open({ filename });

  store.insertRunEnvironment({
    id: "env-recovery",
    createdAt: "2026-09-09T10:00:00.000Z",
    payload: { schema_version: 1 },
  });
  store.insertSession({
    id: "session-recovery",
    environmentId: "env-recovery",
    startedAt: "2026-09-09T10:00:00.000Z",
    status: "active",
  });
  store.insertTurn({
    id: "turn-recovery",
    sessionId: "session-recovery",
    sequence: 0,
    startedAt: "2026-09-09T10:00:01.000Z",
    status: "started",
    userPrompt: "recover",
    payload: { schema_version: 1 },
  });
  store.insertOperation({
    id: "llm-recovery",
    sessionId: "session-recovery",
    turnId: "turn-recovery",
    sequence: 0,
    kind: "llm",
    startedAt: "2026-09-09T10:00:02.000Z",
    status: "started",
    payload: { schema_version: 1 },
  });
  store.insertOperation({
    id: "mcp-recovery",
    sessionId: "session-recovery",
    turnId: "turn-recovery",
    sequence: 1,
    kind: "mcp",
    startedAt: "2026-09-09T10:00:03.000Z",
    status: "started",
    payload: { schema_version: 1 },
  });
  store.close();

  const reopened = SqliteStore.open({ filename });
  reopened.recoverInterrupted("2026-09-09T10:05:00.000Z");
  reopened.close();

  const database = new DatabaseSync(filename);
  try {
    const session = database
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get("session-recovery") as { status: string };
    const turn = database
      .prepare("SELECT status FROM turns WHERE id = ?")
      .get("turn-recovery") as { status: string };
    const operations = database
      .prepare("SELECT id, status, error FROM operations ORDER BY sequence")
      .all() as Array<{ id: string; status: string; error: string }>;
    assert.equal(session.status, "failed");
    assert.equal(turn.status, "failed");
    assert.deepEqual(operations.map((operation) => ({ ...operation })), [
      { id: "llm-recovery", status: "failed", error: "process_restart" },
      { id: "mcp-recovery", status: "unknown", error: "process_restart" },
    ]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
