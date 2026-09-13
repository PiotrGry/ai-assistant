import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { importSessionLogs } from "../src/import-logs.js";
import { SqliteStore } from "../src/storage/sqlite.js";

// Compiled to Pirx/agent/dist-test/test, so three levels up is the Pirx workspace.
const DASHBOARD_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dashboard",
  "dashboards",
);

interface Target {
  readonly refId: string;
  readonly datasource?: { readonly uid?: string };
  readonly rawQueryText?: string;
  readonly queryText?: string;
  readonly timeColumns?: readonly string[];
}

interface Panel {
  readonly title: string;
  readonly type: string;
  readonly targets?: readonly Target[];
}

interface Variable {
  readonly name: string;
  readonly type: string;
  readonly query?: unknown;
  readonly datasource?: { readonly uid?: string };
}

interface Dashboard {
  readonly uid: string;
  readonly panels: readonly Panel[];
  readonly templating?: { readonly list: readonly Variable[] };
}

type Row = Record<string, unknown>;

const GRAFANA_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ["${model:sqlstring}", "'gemma4:12b','qwen3:14b'"],
  ["${session:sqlstring}", "'__all'"],
  ["${turn:sqlstring}", "'turn-1'"],
  ["${search:sqlstring}", "''"],
  ["$__from", "0"],
  ["$__to", "4102444800000"],
];

function interpolate(sql: string, overrides: ReadonlyArray<readonly [string, string]> = []): string {
  let result = sql;
  for (const [name, value] of [...overrides, ...GRAFANA_VARIABLES]) {
    result = result.replaceAll(name, value);
  }
  assert.doesNotMatch(result, /\$\{|\$__/u, `unreplaced Grafana variable in: ${sql}`);
  return result;
}

async function loadDashboards(): Promise<Dashboard[]> {
  const files = (await readdir(DASHBOARD_DIRECTORY)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => JSON.parse(await readFile(join(DASHBOARD_DIRECTORY, file), "utf8")) as Dashboard),
  );
}

function seedRecordedSession(store: SqliteStore): void {
  store.insertRunEnvironment({
    id: "env-1",
    createdAt: "2026-09-13T10:00:00.000Z",
    payload: { schema_version: 1, model: "gemma4:12b", storage_mode: "full_local" },
  });
  store.insertSession({ id: "session-1", environmentId: "env-1", startedAt: "2026-09-13T10:00:00.000Z", status: "active" });
  store.insertTurn({
    id: "turn-1",
    sessionId: "session-1",
    sequence: 0,
    startedAt: "2026-09-13T10:00:01.000Z",
    status: "started",
    userPrompt: "pokaż zadania z milestone 1",
    payload: { schema_version: 1, storage_mode: "full_local" },
  });

  store.insertOperation({
    id: "op-llm",
    sessionId: "session-1",
    turnId: "turn-1",
    sequence: 0,
    kind: "llm",
    startedAt: "2026-09-13T10:00:01.100Z",
    status: "started",
    payload: { schema_version: 1, model: "gemma4:12b", iteration: 0 },
  });
  store.finishOperation("op-llm", "2026-09-13T10:00:02.000Z", "succeeded", undefined, {
    schema_version: 1,
    eval_count: 16,
    wall_duration_ms: 900,
  });
  store.insertOperation({
    id: "op-mcp-ok",
    sessionId: "session-1",
    turnId: "turn-1",
    sequence: 1,
    kind: "mcp",
    startedAt: "2026-09-13T10:00:02.100Z",
    status: "started",
    payload: { schema_version: 1, tool_name: "github_issue_list", arguments: { milestone: 1 } },
  });
  store.finishOperation("op-mcp-ok", "2026-09-13T10:00:02.550Z", "succeeded", undefined, {
    schema_version: 1,
    tool_name: "github_issue_list",
    is_error: false,
    server_unavailable: false,
    wall_duration_ms: 450,
  });
  store.insertOperation({
    id: "op-mcp-fail",
    sessionId: "session-1",
    turnId: "turn-1",
    sequence: 2,
    kind: "mcp",
    startedAt: "2026-09-13T10:00:02.600Z",
    status: "started",
    payload: { schema_version: 1, tool_name: "github_issue_get", arguments: { issueNumber: 9999 } },
  });
  store.finishOperation("op-mcp-fail", "2026-09-13T10:00:02.720Z", "failed", "Błąd narzędzia: not found", {
    schema_version: 1,
    tool_name: "github_issue_get",
    is_error: true,
    server_unavailable: false,
    wall_duration_ms: 120,
  });

  const messages = [
    { role: "user", content: "pokaż zadania z milestone 1" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "github_issue_list", arguments: { milestone: 1 } } }],
    },
    { role: "tool", tool_name: "github_issue_list", content: "{\"page\":{\"items\":[]}}" },
    { role: "assistant", content: "Oto zadania." },
  ];
  for (const [sequence, message] of messages.entries()) {
    store.insertMessage({
      id: `message-${sequence}`,
      sessionId: "session-1",
      turnId: "turn-1",
      sequence,
      role: message.role,
      content: message.content,
      ...(message.tool_name === undefined ? {} : { toolName: message.tool_name }),
      payload: message,
      createdAt: "2026-09-13T10:00:05.000Z",
    });
  }
  store.finishTurn("turn-1", "2026-09-13T10:00:05.000Z", "completed", {
    schema_version: 1,
    storage_mode: "full_local",
    response: "Oto zadania.",
    metrics: {
      model: "gemma4:12b",
      turn_duration_ms: 4000,
      total_seconds: 3.6,
      generation_tokens_per_second: 68,
      prompt_tokens_per_second: 4300,
      input_tokens: 7000,
      output_tokens: 120,
      model_calls: 4,
      tool_calls: 2,
      done_reason: "stop",
      context_estimates: [{ estimatedInputTokens: 7800, inputBudgetTokens: 30720 }],
    },
  });

  store.insertTurn({
    id: "turn-2",
    sessionId: "session-1",
    sequence: 1,
    startedAt: "2026-09-13T10:01:00.000Z",
    status: "started",
    userPrompt: "a teraz kalendarz",
    payload: { schema_version: 1, storage_mode: "full_local" },
  });
  store.finishTurn("turn-2", "2026-09-13T10:03:00.000Z", "failed", { schema_version: 1, error: "Ollama timeout" });
  store.finishSession("session-1", "2026-09-13T10:05:00.000Z", "completed");

  store.insertRunEnvironment({ id: "env-2", createdAt: "2026-09-13T11:00:00.000Z", payload: { schema_version: 1, model: "gemma4:12b" } });
  store.insertSession({ id: "session-2", environmentId: "env-2", startedAt: "2026-09-13T11:00:00.000Z", status: "active" });
  store.finishSession("session-2", "2026-09-13T11:00:01.000Z", "failed");
}

async function seededDatabase(): Promise<{ readonly database: DatabaseSync; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-dashboard-test-"));
  const filename = join(directory, "pirx.sqlite");
  const logs = join(directory, "logs");
  await mkdir(logs);
  await writeFile(
    join(logs, "session_20260724_183611.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-07-24T18:36:35+02:00",
      model: "qwen3:14b",
      prompt: "Cześć",
      response: "Hej",
      turn_duration_ms: 1500,
      total_seconds: 1.2,
      generation_tokens_per_second: 40,
      prompt_tokens_per_second: 900,
      input_tokens: 3000,
      output_tokens: 50,
      model_calls: 1,
      tool_calls: 0,
      done_reason: "stop",
      context_estimates: [],
    })}\n`,
    "utf8",
  );
  const store = SqliteStore.open({ filename });
  try {
    await importSessionLogs(store, logs);
    seedRecordedSession(store);
  } finally {
    store.close();
  }
  const database = new DatabaseSync(filename, { readOnly: true });
  return {
    database,
    cleanup: async () => {
      database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function rows(database: DatabaseSync, sql: string, overrides: ReadonlyArray<readonly [string, string]> = []): Row[] {
  return database.prepare(interpolate(sql, overrides)).all().map((row) => ({ ...row }));
}

function panel(dashboards: readonly Dashboard[], uid: string, title: string): Panel {
  const dashboard = dashboards.find((candidate) => candidate.uid === uid);
  assert.ok(dashboard, `dashboard ${uid} is missing`);
  const found = dashboard.panels.find((candidate) => candidate.title === title);
  assert.ok(found, `panel "${title}" is missing in ${uid}`);
  return found;
}

function panelSql(found: Panel): string {
  const sql = found.targets?.[0]?.rawQueryText;
  assert.ok(sql, `panel "${found.title}" has no rawQueryText`);
  return sql;
}

test("every dashboard query runs against the Pirx schema", async () => {
  const dashboards = await loadDashboards();
  assert.ok(dashboards.length > 0, "no dashboards found");
  const { database, cleanup } = await seededDatabase();
  try {
    for (const dashboard of dashboards) {
      for (const variable of dashboard.templating?.list ?? []) {
        if (variable.type !== "query") continue;
        assert.equal(variable.datasource?.uid, "pirx-sqlite", `${dashboard.uid}/${variable.name} datasource`);
        assert.equal(typeof variable.query, "string", `${dashboard.uid}/${variable.name} query must be SQL text`);
        const result = rows(database, variable.query as string);
        for (const row of result) {
          assert.ok("__text" in row && "__value" in row, `${dashboard.uid}/${variable.name} needs __text and __value`);
        }
      }
      for (const found of dashboard.panels) {
        for (const target of found.targets ?? []) {
          assert.equal(target.datasource?.uid, "pirx-sqlite", `${dashboard.uid}/${found.title} datasource`);
          assert.equal(target.rawQueryText, target.queryText, `${dashboard.uid}/${found.title} query texts differ`);
          const result = rows(database, target.rawQueryText ?? "");
          if (found.type === "timeseries") {
            assert.ok(result.length > 0, `${dashboard.uid}/${found.title} returned no rows`);
            assert.equal(Object.keys(result[0] ?? {})[0], "time", `${dashboard.uid}/${found.title} must start with time`);
            assert.deepEqual(target.timeColumns, ["time"]);
          }
        }
      }
    }
  } finally {
    await cleanup();
  }
});

test("model performance dashboard compares imported and recorded models", async () => {
  const dashboards = await loadDashboards();
  const { database, cleanup } = await seededDatabase();
  try {
    const comparison = rows(database, panelSql(panel(dashboards, "pirx-models", "Porównanie modeli")));
    assert.deepEqual(
      comparison
        .map((row) => [row["Model"], row["Tury"], row["Mediana czasu modelu [s]"], row["p95 czasu modelu [s]"]])
        .sort(),
      [
        ["gemma4:12b", 1, 3.6, 3.6],
        ["qwen3:14b", 1, 1.2, 1.2],
      ],
    );

    const context = rows(database, panelSql(panel(dashboards, "pirx-models", "Zajętość kontekstu [%]")));
    assert.deepEqual(context.map((row) => [row["model"], row["value"]]), [["gemma4:12b", 25.4]]);

    const onlyQwen = rows(
      database,
      panelSql(panel(dashboards, "pirx-models", "Czas tury [s]")),
      [["${model:sqlstring}", "'qwen3:14b'"]],
    );
    assert.deepEqual(onlyQwen.map((row) => row["model"]), ["qwen3:14b"]);
  } finally {
    await cleanup();
  }
});

test("tools dashboard reports calls, errors and failed work", async () => {
  const dashboards = await loadDashboards();
  const { database, cleanup } = await seededDatabase();
  try {
    const perTool = rows(database, panelSql(panel(dashboards, "pirx-tools", "Wywołania na narzędzie")));
    assert.deepEqual(perTool.map((row) => [row["Narzędzie"], row["Wywołania"]]).sort(), [
      ["github_issue_get", 1],
      ["github_issue_list", 1],
    ]);

    const summary = rows(database, panelSql(panel(dashboards, "pirx-tools", "Narzędzia: błędy i czasy")));
    assert.deepEqual(
      summary
        .map((row) => [row["Narzędzie"], row["Wywołania"], row["Błędy"], row["Błędy [%]"], row["Mediana [ms]"], row["p95 [ms]"]])
        .sort(),
      [
        ["github_issue_get", 1, 1, 100, 120, 120],
        ["github_issue_list", 1, 0, 0, 450, 450],
      ],
    );

    const errors = rows(database, panelSql(panel(dashboards, "pirx-tools", "Ostatnie błędy narzędzi")));
    assert.deepEqual(errors.map((row) => [row["Narzędzie"], row["Status"], row["Błąd"], row["Pytanie"]]), [
      ["github_issue_get", "failed", "Błąd narzędzia: not found", "pokaż zadania z milestone 1"],
    ]);

    const failedTurns = rows(database, panelSql(panel(dashboards, "pirx-tools", "Nieudane tury")));
    assert.deepEqual(failedTurns.map((row) => [row["Pytanie"], row["Błąd"]]), [["a teraz kalendarz", "Ollama timeout"]]);

    const limited = rows(database, panelSql(panel(dashboards, "pirx-tools", "Tury przerwane przez limit")));
    assert.deepEqual(limited, [{ Tury: 0 }]);

    const failedSessions = rows(database, panelSql(panel(dashboards, "pirx-tools", "Nieudane sesje")));
    assert.deepEqual(failedSessions.map((row) => [row["Sesja"], row["Model"], row["Tury"]]), [["session-2", "gemma4:12b", 0]]);

    const outsideRange = rows(
      database,
      panelSql(panel(dashboards, "pirx-tools", "Wywołania na narzędzie")),
      [["$__to", "1789290000000"]],
    );
    assert.deepEqual(outsideRange, []);
  } finally {
    await cleanup();
  }
});

test("conversation dashboard lists sessions, turns, messages and operations", async () => {
  const dashboards = await loadDashboards();
  const { database, cleanup } = await seededDatabase();
  try {
    const dashboard = dashboards.find((candidate) => candidate.uid === "pirx-conversations");
    assert.ok(dashboard, "dashboard pirx-conversations is missing");
    const sessionQuery = dashboard.templating?.list.find((variable) => variable.name === "session")?.query;
    assert.equal(typeof sessionQuery, "string");
    const sessions = rows(database, sessionQuery as string);
    assert.equal(sessions.length, 3);
    assert.ok(sessions.some((row) => row["__value"] === "session-1" && row["__text"] === "2026-09-13 10:00 · gemma4:12b · 2 tur"));
    assert.ok(sessions.some((row) => String(row["__text"]).endsWith(" · import")));

    const turnsSql = panelSql(panel(dashboards, "pirx-conversations", "Tury"));
    assert.deepEqual(
      rows(database, turnsSql).map((row) => [row["Pytanie"], row["Odpowiedź"], row["Status"]]),
      [
        ["a teraz kalendarz", "Ollama timeout", "failed"],
        ["pokaż zadania z milestone 1", "Oto zadania.", "completed"],
        ["Cześć", "Hej", "completed"],
      ],
    );
    assert.equal(rows(database, turnsSql, [["${session:sqlstring}", "'session-1'"]]).length, 2);
    assert.deepEqual(
      rows(database, turnsSql, [["${search:sqlstring}", "'kalendarz'"]]).map((row) => row["Pytanie"]),
      ["a teraz kalendarz"],
    );
    assert.deepEqual(
      rows(database, turnsSql, [["${search:sqlstring}", "'Hej'"]]).map((row) => row["Pytanie"]),
      ["Cześć"],
    );

    const messages = rows(database, panelSql(panel(dashboards, "pirx-conversations", "Wiadomości tury")));
    assert.deepEqual(
      messages.map((row) => [row["Nr"], row["Rola"], row["Narzędzie"], row["Treść"]]),
      [
        [0, "user", "", "pokaż zadania z milestone 1"],
        [1, "assistant", "github_issue_list", ""],
        [2, "tool", "github_issue_list", "{\"page\":{\"items\":[]}}"],
        [3, "assistant", "", "Oto zadania."],
      ],
    );

    const operations = rows(database, panelSql(panel(dashboards, "pirx-conversations", "Operacje tury")));
    assert.deepEqual(
      operations.map((row) => [row["Nr"], row["Rodzaj"], row["Narzędzie"], row["Status"], row["Czas [ms]"], row["Błąd"]]),
      [
        [0, "llm", "", "succeeded", 900, ""],
        [1, "mcp", "github_issue_list", "succeeded", 450, ""],
        [2, "mcp", "github_issue_get", "failed", 120, "Błąd narzędzia: not found"],
      ],
    );
  } finally {
    await cleanup();
  }
});
