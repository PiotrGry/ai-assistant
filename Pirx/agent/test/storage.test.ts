import { hostname } from "node:os";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SqliteStore, STORAGE_SCHEMA_VERSION } from "../src/storage/sqlite.js";

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const onData = (value: Buffer) => {
      stdout += value.toString("utf8");
      if (stdout.includes("READY\n")) {
        cleanup();
        resolve();
      }
    };
    const onErrorData = (value: Buffer) => { stderr += value.toString("utf8"); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Session owner exited before READY (code=${String(code)}, signal=${String(signal)}): ${stderr}`));
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.once("exit", onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

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
    store.insertResourceSample({
      id: "resource-summary-1",
      sessionId: "session-1",
      sampledAt: "2026-09-09T10:00:03.000Z",
      source: "test",
      payload: {
        gpu: { vram_used_mb: 100, utilization_percent: 20 },
      },
    });
    store.insertResourceSample({
      id: "resource-summary-2",
      sessionId: "session-1",
      sampledAt: "2026-09-09T10:00:04.000Z",
      source: "test",
      payload: {
        gpu: { vram_used_mb: 150, utilization_percent: 80 },
      },
    });

    assert.equal(store.count("run_environments"), 1);
    assert.equal(store.count("sessions"), 1);
    assert.equal(store.count("turns"), 1);
    assert.equal(store.count("operations"), 1);
    assert.deepEqual(store.resourceSummary("session-1"), {
      sampleCount: 2,
      gpuSampleCount: 2,
      observedVramPeakMb: 150,
      observedGpuUtilizationPeakPercent: 80,
    });
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

test("SQLite store rejects a newer schema before changing the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-storage-future-schema-"));
  const filename = join(directory, "pirx.db");
  const future = new DatabaseSync(filename);
  future.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, applied_at) VALUES (999, '2026-01-01T00:00:00.000Z');
    CREATE TABLE future_only (id TEXT PRIMARY KEY);
    INSERT INTO future_only (id) VALUES ('preserve-me');
  `);
  future.close();
  const before = await readFile(filename);

  assert.throws(
    () => SqliteStore.open({ filename }),
    /Unsupported storage schema version: 999/u,
  );
  assert.deepEqual(await readFile(filename), before);

  const observed = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(observed.prepare("SELECT id FROM future_only").get()?.id, "preserve-me");
    assert.equal(observed.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sessions'").get()?.n, 0);
    assert.equal(observed.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version, 999);
  } finally {
    observed.close();
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
    payload: { schema_version: 1, process_id: 2147483647, process_hostname: hostname() },
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

test("recovery preserves another live process and recovers its MCP operation once after exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-storage-process-owner-"));
  const filename = join(directory, "pirx.db");
  const storageModule = new URL("../src/storage/sqlite.js", import.meta.url).href;
  const childScript = `
    import { hostname } from "node:os";
    import { SqliteStore } from ${JSON.stringify(storageModule)};
    const [filename, sessionId] = process.argv.slice(1);
    const store = SqliteStore.open({ filename });
    const startedAt = "2026-09-09T10:00:00.000Z";
    store.insertRunEnvironment({ id: "child-env", createdAt: startedAt, payload: { process_id: process.pid, process_hostname: hostname() } });
    store.insertSession({ id: sessionId, environmentId: "child-env", startedAt, status: "active" });
    store.insertTurn({ id: "child-turn", sessionId, sequence: 0, startedAt, status: "started", userPrompt: "child", payload: {} });
    store.insertOperation({ id: "child-mcp", sessionId, turnId: "child-turn", sequence: 0, kind: "mcp", startedAt, status: "started", payload: { tool_name: "fixture_mutation" } });
    process.stdout.write(${JSON.stringify("READY\n")});
    setInterval(() => undefined, 1_000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript, filename, "child-session"]);
  let store: SqliteStore | undefined;
  try {
    await waitForReady(child);
    store = SqliteStore.open({ filename });
    store.insertRunEnvironment({
      id: "parent-env",
      createdAt: "2026-09-09T10:00:01.000Z",
      payload: { process_id: process.pid, process_hostname: hostname() },
    });
    store.insertSession({ id: "parent-session", environmentId: "parent-env", startedAt: "2026-09-09T10:00:01.000Z", status: "active" });
    store.insertTurn({ id: "parent-turn", sessionId: "parent-session", sequence: 0, startedAt: "2026-09-09T10:00:01.000Z", status: "started", userPrompt: "parent", payload: {} });
    store.insertOperation({ id: "parent-mcp", sessionId: "parent-session", turnId: "parent-turn", sequence: 0, kind: "mcp", startedAt: "2026-09-09T10:00:01.000Z", status: "started", payload: { tool_name: "fixture_mutation" } });

    store.recoverInterrupted("2026-09-09T10:01:00.000Z");
    let observed = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(
        observed.prepare("SELECT id, status FROM sessions ORDER BY id").all().map((row) => ({ ...row })),
        [{ id: "child-session", status: "active" }, { id: "parent-session", status: "active" }],
      );
      assert.deepEqual(
        observed.prepare("SELECT id, status FROM operations ORDER BY id").all().map((row) => ({ ...row })),
        [{ id: "child-mcp", status: "started" }, { id: "parent-mcp", status: "started" }],
      );
    } finally { observed.close(); }

    await stopChild(child);
    store.recoverInterrupted("2026-09-09T10:02:00.000Z");
    observed = new DatabaseSync(filename, { readOnly: true });
    let recoveredEndedAt: string;
    try {
      const childSession = observed.prepare("SELECT status, ended_at FROM sessions WHERE id = 'child-session'").get() as { status: string; ended_at: string };
      const childOperation = observed.prepare("SELECT status, error FROM operations WHERE id = 'child-mcp'").get() as { status: string; error: string };
      assert.equal(childSession.status, "failed");
      assert.equal(childOperation.status, "unknown");
      assert.equal(childOperation.error, "process_restart");
      assert.equal(observed.prepare("SELECT status FROM sessions WHERE id = 'parent-session'").get()?.status, "active");
      assert.equal(observed.prepare("SELECT status FROM operations WHERE id = 'parent-mcp'").get()?.status, "started");
      recoveredEndedAt = childSession.ended_at;
    } finally { observed.close(); }

    store.recoverInterrupted("2026-09-09T10:03:00.000Z");
    observed = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(observed.prepare("SELECT ended_at FROM sessions WHERE id = 'child-session'").get()?.ended_at, recoveredEndedAt);
      assert.equal(observed.prepare("SELECT status FROM operations WHERE id = 'child-mcp'").get()?.status, "unknown");
    } finally { observed.close(); }
  } finally {
    await stopChild(child);
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite store reports whether a session exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-storage-test-"));
  const store = SqliteStore.open({ filename: join(directory, "pirx.db") });
  try {
    store.insertRunEnvironment({ id: "env-1", createdAt: "2026-09-13T10:00:00.000Z", payload: {} });
    store.insertSession({
      id: "session-1",
      environmentId: "env-1",
      startedAt: "2026-09-13T10:00:00.000Z",
      status: "active",
    });

    assert.equal(store.sessionExists("session-1"), true);
    assert.equal(store.sessionExists("missing"), false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite store transaction commits the result or rolls back every write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-storage-test-"));
  const store = SqliteStore.open({ filename: join(directory, "pirx.db") });
  try {
    assert.throws(
      () =>
        store.transaction(() => {
          store.insertRunEnvironment({ id: "env-1", createdAt: "2026-09-13T10:00:00.000Z", payload: {} });
          throw new Error("boom");
        }),
      /boom/u,
    );
    assert.equal(store.count("run_environments"), 0);

    const result = store.transaction(() => {
      store.insertRunEnvironment({ id: "env-2", createdAt: "2026-09-13T10:00:00.000Z", payload: {} });
      return 42;
    });
    assert.equal(result, 42);
    assert.equal(store.count("run_environments"), 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test("recovery preserves live, unknown and remote session owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-session-owner-"));
  const filename = join(directory, "chat.sqlite");
  const store = SqliteStore.open({ filename });
  try {
    for (const [id, payload] of Object.entries({ live: { process_id: process.pid, process_hostname: hostname() }, legacy: {}, remote: { process_id: 2147483647, process_hostname: "another-host" } })) {
      store.insertRunEnvironment({ id, createdAt: "2026-01-01T00:00:00Z", payload });
      store.insertSession({ id, environmentId: id, startedAt: "2026-01-01T00:00:00Z", status: "active" });
    }
    store.recoverInterrupted("2026-01-02T00:00:00Z");
    const db = new DatabaseSync(filename, { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE status = 'active'").get()?.n, 3); }
    finally { db.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
