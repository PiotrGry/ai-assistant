import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { importId, importSessionLogs } from "../src/import-logs.js";
import { SqliteStore } from "../src/storage/sqlite.js";

function line(values: Record<string, unknown>): string {
  return JSON.stringify(values);
}

test("imports JSONL session logs once and reports skipped input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-import-test-"));
  const logs = join(directory, "logs");
  const filename = join(directory, "pirx.sqlite");
  await mkdir(logs);
  await writeFile(
    join(logs, "session_20260724_183611.jsonl"),
    [
      line({
        timestamp: "2026-07-24T18:36:35+02:00",
        model: "qwen3:14b",
        context: 8192,
        temperature: 0.3,
        time_zone: "Europe/Warsaw",
        system_prompt_file: "/tmp/system.md",
        system_prompt_sha256: "abc",
        prompt: "Cześć",
        response: "Hej",
        turn_duration_ms: 1500,
        tool_calls: 0,
      }),
      "{not json",
      line({
        timestamp: "2026-07-24T18:40:00+02:00",
        model: "qwen3:14b",
        prompt: "Pogoda?",
        response: "Nie wiem",
        turn_duration_ms: 2500,
        tool_calls: 1,
      }),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(logs, "session_broken.jsonl"), '{"timestamp": "2026-07-25T10:00:00Z"}\n', "utf8");
  await writeFile(join(logs, "notes.txt"), "ignored", "utf8");

  const store = SqliteStore.open({ filename });
  try {
    const first = await importSessionLogs(store, logs);
    assert.deepEqual(first.importedFiles, ["session_20260724_183611.jsonl"]);
    assert.deepEqual(first.skippedFiles, [{ file: "session_broken.jsonl", reason: "no_valid_lines" }]);
    assert.equal(first.importedTurns, 2);
    assert.deepEqual(first.skippedLines, [
      { file: "session_20260724_183611.jsonl", line: 2, reason: "invalid_json" },
      { file: "session_broken.jsonl", line: 1, reason: "missing_fields" },
    ]);

    const second = await importSessionLogs(store, logs);
    assert.deepEqual(second.importedFiles, []);
    assert.equal(second.importedTurns, 0);
    assert.deepEqual(second.skippedFiles, [
      { file: "session_20260724_183611.jsonl", reason: "already_imported" },
      { file: "session_broken.jsonl", reason: "no_valid_lines" },
    ]);
  } finally {
    store.close();
  }

  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const sessions = database
      .prepare("SELECT id, status, started_at, ended_at FROM sessions")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(sessions, [
      {
        id: importId("pirx-import:session:session_20260724_183611.jsonl"),
        status: "completed",
        started_at: "2026-07-24T18:36:35+02:00",
        ended_at: "2026-07-24T16:40:02.500Z",
      },
    ]);

    const environment = database
      .prepare(
        "SELECT json_extract(payload_json, '$.model') AS model, json_extract(payload_json, '$.imported_from') AS source FROM run_environments",
      )
      .get();
    assert.deepEqual({ ...environment }, { model: "qwen3:14b", source: "session_20260724_183611.jsonl" });

    const turns = database
      .prepare(
        `SELECT sequence, status, user_prompt,
           json_extract(payload_json, '$.response') AS response,
           json_extract(payload_json, '$.metrics.model') AS model,
           json_extract(payload_json, '$.metrics.prompt') AS leaked_prompt,
           json_extract(payload_json, '$.imported.line') AS line,
           ended_at
         FROM turns ORDER BY sequence`,
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(turns, [
      {
        sequence: 0,
        status: "completed",
        user_prompt: "Cześć",
        response: "Hej",
        model: "qwen3:14b",
        leaked_prompt: null,
        line: 1,
        ended_at: "2026-07-24T16:36:36.500Z",
      },
      {
        sequence: 2,
        status: "completed",
        user_prompt: "Pogoda?",
        response: "Nie wiem",
        model: "qwen3:14b",
        leaked_prompt: null,
        line: 3,
        ended_at: "2026-07-24T16:40:02.500Z",
      },
    ]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
