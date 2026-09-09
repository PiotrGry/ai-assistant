import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SqliteOperationRecorder } from "../src/operation-recorder.js";
import { SqliteStore } from "../src/storage/sqlite.js";

test("operation recorder stores terminal status and payload without fake counters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-operation-test-"));
  const store = SqliteStore.open({ filename: join(directory, "pirx.sqlite") });
  try {
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
      userPrompt: "Zmierz.",
      payload: { schema_version: 1 },
    });

    const recorder = new SqliteOperationRecorder(store);
    const operation = recorder.start({
      sessionId: "session-1",
      turnId: "turn-1",
      sequence: 0,
      kind: "llm",
      startedAt: "2026-09-09T10:00:01.000Z",
      payload: { prompt_eval_count: null },
    });
    recorder.finish(operation, {
      endedAt: "2026-09-09T10:00:02.250Z",
      status: "succeeded",
      payload: { prompt_eval_count: null, wall_duration_ms: 1_250 },
    });

    assert.equal(store.count("operations"), 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
