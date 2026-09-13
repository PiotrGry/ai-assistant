# Pirx Dashboard (Grafana) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every Pirx TUI session with full content in the local SQLite store, import the historical `logs/*.jsonl` turns, and serve three read-only Grafana dashboards (model performance, tools and errors, conversations) on `127.0.0.1:3000`.

**Architecture:** The TUI reuses the existing `SessionLogger` through a small `runRecordedTurn` helper; the default storage mode becomes `full_local`. A one-time importer in `@pirx/agent` writes old JSONL turns into the same schema with deterministic ids. Grafana 13 runs in Docker as uid 1000 with the `frser-sqlite-datasource` plugin, provisioned datasource and dashboards from git, and the admin password decrypted from a sops file at start.

**Tech Stack:** TypeScript (NodeNext, strict), `node:sqlite`, `node:test`, Ink/React (TUI), Docker Compose, Grafana 13.0.8, `frser-sqlite-datasource` 4.0.6, sops 3.9 + age.

**Spec:** `docs/superpowers/specs/2026-09-13-pirx-dashboard-design.md`

---

## Pre-flight

- Repo root: `/home/pepus/ai-assistant` (git). Pirx workspace: `/home/pepus/ai-assistant/Pirx`. All `pnpm`/`npx` commands run from the Pirx workspace unless stated.
- The working tree may still contain the uncommitted tool-chaining fix (`agent/src/agent.ts`, `config.ts`, `tool-result.ts` and their tests). Ask the user to commit it before Task 1 so each task commits only its own files.
- Verified facts this plan relies on:
  - `ChatTurnContext` fields are all optional and `PirxAgent.chat(prompt, context = {})`.
  - `SqliteOperationRecorder.finish` replaces the start payload; finished MCP operations carry `tool_name`, `is_error`, `server_unavailable`, `wall_duration_ms`; the error text is in `operations.error`.
  - The plugin reads variable queries as a plain SQL string and needs columns `__text` and `__value`; panel targets use `rawQueryText` (with variables) and `queryText`; `$__from`/`$__to` are milliseconds.
  - `CAST(strftime('%s', x) AS INTEGER)` parses both `2026-09-12T14:21:29.809Z` and `2026-07-24T18:36:35+02:00` in SQLite 3.37 and 3.53.
  - Grafana 13 installs plugins before start with `GF_PLUGINS_PREINSTALL_SYNC=<id>@<version>`.

## File Structure

| File | Responsibility |
|---|---|
| `Pirx/agent/src/library.ts` (modify) | Export `SessionLogger` and `SessionTurn` for the TUI |
| `Pirx/agent/src/config.ts` (modify) | Default `PIRX_STORAGE_MODE` → `full_local` |
| `Pirx/agent/src/storage/sqlite.ts` (modify) | `sessionExists(id)` and `transaction(fn)` |
| `Pirx/agent/src/import-logs.ts` (create) | Pure importer: JSONL directory → SQLite rows, report |
| `Pirx/agent/src/import-logs-cli.ts` (create) | CLI wrapper: open store, run importer, print report |
| `Pirx/agent/package.json` (modify) | `import:logs` script |
| `Pirx/tui/src/recorded-turn.ts` (create) | `runRecordedTurn`: begin → chat → save/fail, never lets recording break a turn |
| `Pirx/tui/src/index.tsx`, `Pirx/tui/src/app.tsx` (modify) | Create the logger, pass it to `App`, use `runRecordedTurn`, close on exit |
| `Pirx/dashboard/compose.yaml` (create) | Grafana container definition |
| `Pirx/dashboard/provisioning/datasources/pirx.yaml` (create) | SQLite datasource |
| `Pirx/dashboard/provisioning/dashboards/pirx.yaml` (create) | Dashboard file provider |
| `Pirx/dashboard/dashboards/pirx-models.json`, `pirx-tools.json`, `pirx-conversations.json` (create) | Dashboards |
| `Pirx/dashboard/up.sh`, `Pirx/dashboard/down.sh` (create) | Start/stop through `sops exec-env` |
| `Pirx/dashboard/grafana.sops.env` (create, encrypted) | `GF_SECURITY_ADMIN_PASSWORD` |
| `.sops.yaml` (create, repo root) | age recipient rule for the dashboard secret |
| `Pirx/dashboard/README.md` (create) | Start, tunnel, password, troubleshooting |
| `Pirx/agent/test/*.test.ts` (create/modify) | Tests for config, storage, importer, dashboard SQL |
| `Pirx/tui/test/recorded-turn.test.ts` (create) | Tests for `runRecordedTurn` |

---

### Task 1: Export the session logger and record full content by default

**Files:**
- Modify: `Pirx/agent/src/library.ts`
- Modify: `Pirx/agent/src/config.ts` (the `storageMode:` entry in `loadConfig`)
- Modify: `Pirx/agent/test/config.test.ts` (test "agent configuration exposes explicit storage privacy modes")
- Create: `Pirx/agent/test/library.test.ts`
- Modify: `Pirx/README.md` (the `PIRX_STORAGE_MODE` bullet)

- [ ] **Step 1: Write the failing tests**

In `Pirx/agent/test/config.test.ts` replace the body of "agent configuration exposes explicit storage privacy modes" with:

```ts
test("agent configuration exposes explicit storage privacy modes", () => {
  assert.equal(loadConfig({}).storageMode, "full_local");
  assert.equal(
    loadConfig({ PIRX_STORAGE_MODE: "redacted" }).storageMode,
    "redacted",
  );
  assert.throws(
    () => loadConfig({ PIRX_STORAGE_MODE: "secret_dump" }),
    /PIRX_STORAGE_MODE musi być jednym z/u,
  );
});
```

Create `Pirx/agent/test/library.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { SessionLogger } from "../src/library.js";
import type { SessionTurn } from "../src/library.js";

test("library exposes the session logger for other Pirx front ends", () => {
  assert.equal(typeof SessionLogger.create, "function");
  const turn: SessionTurn = { id: "turn", turnId: "turn", sequence: 0 };
  assert.equal(turn.sequence, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsc -p agent/tsconfig.test.json`
Expected: compile error `Module '"../src/library.js"' has no exported member 'SessionLogger'`.

- [ ] **Step 3: Implement**

In `Pirx/agent/src/library.ts` add after `export { loadConfig } from "./config.js";`:

```ts
export { SessionLogger } from "./logger.js";
export type { SessionTurn } from "./logger.js";
```

In `Pirx/agent/src/config.ts` change:

```ts
      environment.PIRX_STORAGE_MODE?.trim() ?? "redacted",
```

to:

```ts
      environment.PIRX_STORAGE_MODE?.trim() ?? "full_local",
```

In `Pirx/README.md` replace the bullet

```
- `PIRX_STORAGE_MODE` — `redacted` (default), `metrics_only`, or `full_local`,
```

with

```
- `PIRX_STORAGE_MODE` — `full_local` (default, keeps message and tool-result bodies for the dashboard), `redacted`, or `metrics_only`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -p agent/tsconfig.test.json && node --test agent/dist-test/test/config.test.js agent/dist-test/test/library.test.js agent/dist-test/test/logger.test.js`
Expected: all tests pass (`ℹ fail 0`). `logger.test.ts` builds its own `AgentConfig`, so its expectations are unaffected.

- [ ] **Step 5: Commit**

```bash
cd /home/pepus/ai-assistant
git add Pirx/agent/src/library.ts Pirx/agent/src/config.ts Pirx/agent/test/config.test.ts Pirx/agent/test/library.test.ts Pirx/README.md
git commit -m "Record full session content by default and export SessionLogger"
```

---

### Task 2: `runRecordedTurn` helper for the TUI

**Files:**
- Create: `Pirx/tui/src/recorded-turn.ts`
- Test: `Pirx/tui/test/recorded-turn.test.ts`

- [ ] **Step 1: Write the failing test**

Create `Pirx/tui/test/recorded-turn.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import type { ChatTurn, ChatTurnContext, SessionTurn } from "@pirx/agent";

import { runRecordedTurn, type TurnRecorder, type TurnRunner } from "../src/recorded-turn.js";

const sessionTurn: SessionTurn = { id: "turn-1", turnId: "turn-1", sequence: 0, sessionId: "session-1" };
const chatTurn = { content: "Cześć!", messages: [], metrics: {} } as unknown as ChatTurn;

class FakeRecorder implements TurnRecorder {
  readonly calls: string[] = [];
  beginError: Error | undefined;
  saveError: Error | undefined;

  beginTurn(prompt: string): SessionTurn {
    this.calls.push(`begin:${prompt}`);
    if (this.beginError !== undefined) throw this.beginError;
    return sessionTurn;
  }

  async saveTurn(prompt: string, response: string, _metrics: ChatTurn["metrics"], turn: SessionTurn): Promise<void> {
    this.calls.push(`save:${prompt}:${response}:${turn.id}`);
    if (this.saveError !== undefined) throw this.saveError;
  }

  async failTurn(turn: SessionTurn, error: unknown): Promise<void> {
    this.calls.push(`fail:${turn.id}:${error instanceof Error ? error.message : String(error)}`);
  }
}

function runner(result: ChatTurn | Error, contexts: ChatTurnContext[]): TurnRunner {
  return {
    chat: async (_prompt, context) => {
      contexts.push(context);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("records a successful turn with the session turn as chat context", async () => {
  const recorder = new FakeRecorder();
  const contexts: ChatTurnContext[] = [];

  const result = await runRecordedTurn(runner(chatTurn, contexts), recorder, "Cześć");

  assert.equal(result.turn, chatTurn);
  assert.equal(result.recordingError, undefined);
  assert.deepEqual(contexts, [sessionTurn]);
  assert.deepEqual(recorder.calls, ["begin:Cześć", "save:Cześć:Cześć!:turn-1"]);
});

test("marks the turn as failed and rethrows when chat fails", async () => {
  const recorder = new FakeRecorder();

  await assert.rejects(
    runRecordedTurn(runner(new Error("Ollama timeout"), []), recorder, "Cześć"),
    /Ollama timeout/u,
  );
  assert.deepEqual(recorder.calls, ["begin:Cześć", "fail:turn-1:Ollama timeout"]);
});

test("returns the answer with a recording error when saving fails", async () => {
  const recorder = new FakeRecorder();
  recorder.saveError = new Error("database is locked");

  const result = await runRecordedTurn(runner(chatTurn, []), recorder, "Cześć");

  assert.equal(result.turn, chatTurn);
  assert.equal(result.recordingError, "database is locked");
});

test("still runs the turn without context when the recording cannot start", async () => {
  const recorder = new FakeRecorder();
  recorder.beginError = new Error("Session logger is closed.");
  const contexts: ChatTurnContext[] = [];

  const result = await runRecordedTurn(runner(chatTurn, contexts), recorder, "Cześć");

  assert.equal(result.turn, chatTurn);
  assert.equal(result.recordingError, "Session logger is closed.");
  assert.deepEqual(contexts, [{}]);
  assert.deepEqual(recorder.calls, ["begin:Cześć"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p agent/tsconfig.json && npx tsc -p tui/tsconfig.test.json`
Expected: compile error `Cannot find module '../src/recorded-turn.js'`.

- [ ] **Step 3: Implement**

Create `Pirx/tui/src/recorded-turn.ts`:

```ts
import type { ChatTurn, ChatTurnContext, SessionTurn } from "@pirx/agent";

export interface TurnRecorder {
  beginTurn(prompt: string): SessionTurn;
  saveTurn(
    prompt: string,
    response: string,
    metrics: ChatTurn["metrics"],
    turn: SessionTurn,
    messages: ChatTurn["messages"],
  ): Promise<void>;
  failTurn(turn: SessionTurn, error: unknown): Promise<void>;
}

export interface TurnRunner {
  chat(prompt: string, context: ChatTurnContext): Promise<ChatTurn>;
}

export interface RecordedTurn {
  readonly turn: ChatTurn;
  readonly recordingError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Recording is best effort: a storage failure is reported next to the answer but never loses the turn.
export async function runRecordedTurn(
  agent: TurnRunner,
  recorder: TurnRecorder,
  prompt: string,
): Promise<RecordedTurn> {
  let sessionTurn: SessionTurn | undefined;
  let recordingError: string | undefined;
  try {
    sessionTurn = recorder.beginTurn(prompt);
  } catch (error: unknown) {
    recordingError = errorMessage(error);
  }

  let turn: ChatTurn;
  try {
    turn = await agent.chat(prompt, sessionTurn ?? {});
  } catch (error: unknown) {
    if (sessionTurn !== undefined) {
      await recorder.failTurn(sessionTurn, error).catch(() => undefined);
    }
    throw error;
  }

  if (sessionTurn === undefined) {
    return recordingError === undefined ? { turn } : { turn, recordingError };
  }
  try {
    await recorder.saveTurn(prompt, turn.content, turn.metrics, sessionTurn, turn.messages);
    return { turn };
  } catch (error: unknown) {
    return { turn, recordingError: errorMessage(error) };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -p agent/tsconfig.json && npx tsc -p tui/tsconfig.test.json && node --test tui/dist-test/test/recorded-turn.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/pepus/ai-assistant
git add Pirx/tui/src/recorded-turn.ts Pirx/tui/test/recorded-turn.test.ts
git commit -m "Add best-effort turn recording helper for the TUI"
```

### Task 3: Record TUI sessions

**Files:**
- Modify: `Pirx/tui/src/index.tsx`
- Modify: `Pirx/tui/src/app.tsx` (imports, `AppProps`, `App` signature, `notice` state, `submit`)

No new unit test: the behavior lives in `runRecordedTurn` (Task 2). This task is wiring, verified by typecheck and a manual session.

- [ ] **Step 1: Wire the logger in `index.tsx`**

Change the import line:

```tsx
import { PirxAgent, loadConfig } from "@pirx/agent";
```

to:

```tsx
import { PirxAgent, SessionLogger, loadConfig } from "@pirx/agent";
```

Directly after the `const agent = await PirxAgent.create(config, { ... });` statement add:

```tsx
  let logger: SessionLogger | undefined;
  let recordingNotice: string | undefined;
  try {
    logger = await SessionLogger.create(config, agent.systemPrompt);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    recordingNotice = `Sesja nie będzie zapisana: ${detail}`;
  }
```

Change the render call:

```tsx
    instance = render(<App agent={agent} events={events} />, {
```

to:

```tsx
    instance = render(
      <App agent={agent} events={events} recorder={logger} initialNotice={recordingNotice} />,
      {
```

and close the extra parenthesis so the call reads:

```tsx
    instance = render(
      <App agent={agent} events={events} recorder={logger} initialNotice={recordingNotice} />,
      {
        exitOnCtrlC: false,
      },
    );
```

In the outer `finally`, replace:

```tsx
    await agent.close();
```

with:

```tsx
    await logger?.close().catch(() => undefined);
    await agent.close();
```

- [ ] **Step 2: Use the recorder in `app.tsx`**

After `import { calculateTuiLayout } from "./layout.js";` add:

```tsx
import { runRecordedTurn, type RecordedTurn, type TurnRecorder } from "./recorded-turn.js";
```

Replace the `AppProps` interface and the `App` signature:

```tsx
interface AppProps {
  readonly agent: PirxAgent;
  readonly events: TuiEventBus;
  readonly recorder?: TurnRecorder | undefined;
  readonly initialNotice?: string | undefined;
}
```

```tsx
export function App({ agent, events, recorder, initialNotice }: AppProps): React.JSX.Element {
```

Replace:

```tsx
  const [notice, setNotice] = useState<string | undefined>();
```

with:

```tsx
  const [notice, setNotice] = useState<string | undefined>(initialNotice);
```

In `submit`, replace the block starting at `void agent.chat(value).then((turn: ChatTurn) => {` up to and including `}).finally(() => setBusy(false));` with:

```tsx
    const run: Promise<RecordedTurn> = recorder === undefined
      ? agent.chat(value).then((turn) => ({ turn }))
      : runRecordedTurn(agent, recorder, value);
    void run.then(({ turn, recordingError }) => {
      setLastMetrics(turn.metrics);
      setHistory((current) => [...current, { kind: "assistant", content: turn.content }]);
      if (recordingError !== undefined) {
        setNotice(`Nie zapisano tury: ${recordingError}`);
      }
    }).catch((error: unknown) => {
      const detail = errorMessage(error);
      setNotice(detail);
      setHistory((current) => [...current, { kind: "error", content: detail }]);
    }).finally(() => setBusy(false));
```

In the `@pirx/agent` type import at the top of `app.tsx`, remove `ChatTurn` if it is no longer referenced:

```tsx
import type { PirxAgent, TurnMetrics } from "@pirx/agent";
```

- [ ] **Step 3: Typecheck and run the TUI tests**

Run: `npx tsc -p agent/tsconfig.json && npx tsc -p tui/tsconfig.json && npx tsc -p tui/tsconfig.test.json && node --test tui/dist-test/test/*.test.js`
Expected: no compile errors, all TUI tests pass.

- [ ] **Step 4: Verify a real session is recorded**

Run: `pnpm tui`, send `Cześć`, wait for the answer, exit with `/exit`.

Then run:

```bash
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
const db = new DatabaseSync(`${homedir()}/.local/share/pirx/pirx.sqlite`, { readOnly: true });
const rows = db.prepare(`SELECT s.status AS session, t.sequence, t.status AS turn, t.user_prompt,
  json_extract(t.payload_json, "$.response") AS response,
  (SELECT COUNT(*) FROM messages m WHERE m.turn_id = t.id) AS messages
  FROM sessions s JOIN turns t ON t.session_id = s.id
  ORDER BY s.started_at DESC, t.sequence LIMIT 1`).all();
console.log(rows);'
```

Expected: one row with `session: 'completed'`, `turn: 'completed'`, `user_prompt: 'Cześć'`, a non-empty `response` and `messages` ≥ 2.

- [ ] **Step 5: Commit**

```bash
cd /home/pepus/ai-assistant
git add Pirx/tui/src/index.tsx Pirx/tui/src/app.tsx
git commit -m "Record TUI sessions in the local Pirx store"
```

---

### Task 4: Store helpers for the importer

**Files:**
- Modify: `Pirx/agent/src/storage/sqlite.ts` (inside `class SqliteStore`, after `get filename()`)
- Test: `Pirx/agent/test/storage.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `Pirx/agent/test/storage.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsc -p agent/tsconfig.test.json`
Expected: compile errors `Property 'sessionExists' does not exist on type 'SqliteStore'` and `Property 'transaction' does not exist on type 'SqliteStore'`.

- [ ] **Step 3: Implement**

In `Pirx/agent/src/storage/sqlite.ts`, directly after the `get filename(): string { ... }` getter add:

```ts
  sessionExists(id: string): boolean {
    this.#assertOpen();
    return this.#database
      .prepare("SELECT 1 AS found FROM sessions WHERE id = ?")
      .get(id) !== undefined;
  }

  transaction<T>(operation: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -p agent/tsconfig.test.json && node --test agent/dist-test/test/storage.test.js`
Expected: all storage tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/pepus/ai-assistant
git add Pirx/agent/src/storage/sqlite.ts Pirx/agent/test/storage.test.ts
git commit -m "Add session lookup and transactions to the SQLite store"
```

---

### Task 5: Import historical session logs

**Files:**
- Create: `Pirx/agent/src/import-logs.ts`
- Create: `Pirx/agent/src/import-logs-cli.ts`
- Modify: `Pirx/agent/package.json` (`scripts`)
- Test: `Pirx/agent/test/import-logs.test.ts`

- [ ] **Step 1: Write the failing test**

Create `Pirx/agent/test/import-logs.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p agent/tsconfig.test.json`
Expected: compile error `Cannot find module '../src/import-logs.js'`.

- [ ] **Step 3: Implement the importer**

Create `Pirx/agent/src/import-logs.ts`:

```ts
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SqliteStore } from "./storage/sqlite.js";

export interface SkippedImportFile {
  readonly file: string;
  readonly reason: "already_imported" | "no_valid_lines";
}

export interface SkippedImportLine {
  readonly file: string;
  readonly line: number;
  readonly reason: "invalid_json" | "missing_fields";
}

export interface ImportReport {
  readonly importedFiles: readonly string[];
  readonly skippedFiles: readonly SkippedImportFile[];
  readonly importedTurns: number;
  readonly skippedLines: readonly SkippedImportLine[];
}

interface LoggedTurn {
  readonly line: number;
  readonly timestamp: string;
  readonly prompt: string;
  readonly response: string;
  readonly metrics: Record<string, unknown>;
}

const SESSION_FILE = /^session_.+\.jsonl$/u;

// Name-based UUID (version 5 layout) so a re-run maps the same log line to the same row id.
export function importId(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseLines(file: string, text: string, skipped: SkippedImportLine[]): LoggedTurn[] {
  const turns: LoggedTurn[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = index + 1;
    if (raw.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      skipped.push({ file, line, reason: "invalid_json" });
      continue;
    }
    if (!isRecord(value)) {
      skipped.push({ file, line, reason: "missing_fields" });
      continue;
    }
    const { timestamp, prompt, response } = value;
    if (
      typeof timestamp !== "string" ||
      !Number.isFinite(Date.parse(timestamp)) ||
      typeof prompt !== "string" ||
      typeof response !== "string"
    ) {
      skipped.push({ file, line, reason: "missing_fields" });
      continue;
    }
    const metrics = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "prompt" && key !== "response"),
    );
    turns.push({ line, timestamp, prompt, response, metrics });
  }
  return turns;
}

function endedAt(turn: LoggedTurn): string {
  const duration = numberOrNull(turn.metrics.turn_duration_ms) ?? 0;
  return new Date(Date.parse(turn.timestamp) + duration).toISOString();
}

export async function importSessionLogs(store: SqliteStore, directory: string): Promise<ImportReport> {
  const files = (await readdir(directory)).filter((name) => SESSION_FILE.test(name)).sort();
  const importedFiles: string[] = [];
  const skippedFiles: SkippedImportFile[] = [];
  const skippedLines: SkippedImportLine[] = [];
  let importedTurns = 0;

  for (const file of files) {
    const turns = parseLines(file, await readFile(join(directory, file), "utf8"), skippedLines);
    const first = turns[0];
    const last = turns.at(-1);
    if (first === undefined || last === undefined) {
      skippedFiles.push({ file, reason: "no_valid_lines" });
      continue;
    }
    const sessionId = importId(`pirx-import:session:${file}`);
    if (store.sessionExists(sessionId)) {
      skippedFiles.push({ file, reason: "already_imported" });
      continue;
    }
    const environmentId = importId(`pirx-import:environment:${file}`);

    store.transaction(() => {
      store.insertRunEnvironment({
        id: environmentId,
        createdAt: first.timestamp,
        payload: {
          schema_version: 1,
          model: stringOrNull(first.metrics.model),
          num_ctx: numberOrNull(first.metrics.context),
          temperature: numberOrNull(first.metrics.temperature),
          time_zone: stringOrNull(first.metrics.time_zone),
          prompt_file: stringOrNull(first.metrics.system_prompt_file),
          prompt_sha256: stringOrNull(first.metrics.system_prompt_sha256),
          storage_mode: "full_local",
          imported_from: file,
        },
      });
      store.insertSession({ id: sessionId, environmentId, startedAt: first.timestamp, status: "active" });
      for (const turn of turns) {
        const turnId = importId(`pirx-import:turn:${file}:${turn.line}`);
        store.insertTurn({
          id: turnId,
          sessionId,
          sequence: turn.line - 1,
          startedAt: turn.timestamp,
          status: "started",
          userPrompt: turn.prompt,
          payload: { schema_version: 1, storage_mode: "full_local" },
        });
        store.finishTurn(turnId, endedAt(turn), "completed", {
          schema_version: 1,
          storage_mode: "full_local",
          response: turn.response,
          metrics: turn.metrics,
          imported: { source: file, line: turn.line },
        });
      }
      store.finishSession(sessionId, endedAt(last), "completed");
    });

    importedFiles.push(file);
    importedTurns += turns.length;
  }

  return { importedFiles, skippedFiles, importedTurns, skippedLines };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsc -p agent/tsconfig.test.json && node --test agent/dist-test/test/import-logs.test.js`
Expected: 1 test passes.

- [ ] **Step 5: Add the CLI and script**

Create `Pirx/agent/src/import-logs-cli.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "./config.js";
import { importSessionLogs } from "./import-logs.js";
import { SqliteStore } from "./storage/sqlite.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.storagePath === undefined) {
    throw new Error("Brak ścieżki bazy Pirxa (PIRX_STORAGE_FILE).");
  }
  const directory = resolve(process.argv[2] ?? config.logDir);
  await mkdir(dirname(config.storagePath), { recursive: true, mode: 0o700 });
  const store = SqliteStore.open({ filename: config.storagePath });
  try {
    const report = await importSessionLogs(store, directory);
    console.log(`Katalog logów: ${directory}`);
    console.log(`Baza: ${config.storagePath}`);
    console.log(`Zaimportowane pliki: ${report.importedFiles.length}, tury: ${report.importedTurns}`);
    for (const skipped of report.skippedFiles) {
      console.log(`Pominięty plik ${skipped.file}: ${skipped.reason}`);
    }
    for (const skipped of report.skippedLines) {
      console.log(`Pominięta linia ${skipped.file}:${skipped.line}: ${skipped.reason}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Import logów nie powiódł się: ${detail}\n`);
  process.exitCode = 1;
});
```

In `Pirx/agent/package.json` add to `scripts` (after `"start"`):

```json
    "import:logs": "node --enable-source-maps dist/import-logs-cli.js"
```

(remember the comma after the `"start"` entry).

- [ ] **Step 6: Back up the real database and run the import**

Stop any running `pnpm tui` / `pnpm start` first (the importer is safe with WAL, but a backup is simpler with no writer).

```bash
mkdir -p -m 700 ~/.local/share/pirx/backup-2026-09-13
cp ~/.local/share/pirx/pirx.sqlite* ~/.local/share/pirx/backup-2026-09-13/
cd /home/pepus/ai-assistant/Pirx
pnpm --filter @pirx/agent build
pnpm --filter @pirx/agent import:logs
pnpm --filter @pirx/agent import:logs
```

Expected on the first run: `Zaimportowane pliki: 34, tury: 105` (inventory from 2026-09-13; any difference must be explained by `Pominięta linia …` lines). Expected on the second run: `Zaimportowane pliki: 0, tury: 0` and 34 lines `Pominięty plik …: already_imported`.

- [ ] **Step 7: Commit**

```bash
cd /home/pepus/ai-assistant
git add Pirx/agent/src/import-logs.ts Pirx/agent/src/import-logs-cli.ts Pirx/agent/package.json Pirx/agent/test/import-logs.test.ts
git commit -m "Import historical Pirx session logs into SQLite"
```

---

### Task 6: Grafana container, datasource and secret

**Files:**
- Create: `.sops.yaml` (repo root `/home/pepus/ai-assistant`)
- Create: `Pirx/dashboard/grafana.sops.env` (encrypted)
- Create: `Pirx/dashboard/compose.yaml`
- Create: `Pirx/dashboard/provisioning/datasources/pirx.yaml`
- Create: `Pirx/dashboard/provisioning/dashboards/pirx.yaml`
- Create: `Pirx/dashboard/dashboards/.gitkeep`
- Create: `Pirx/dashboard/up.sh`, `Pirx/dashboard/down.sh`, `Pirx/dashboard/query.sh`
- Create: `Pirx/dashboard/README.md`

This task is infrastructure; it is verified by running the container, not by unit tests. It also settles the three risks from the spec (plugin on Grafana 13, WAL read, plugin SQLite version).

- [ ] **Step 1: sops rule and encrypted admin password**

Create `/home/pepus/ai-assistant/.sops.yaml`:

```yaml
creation_rules:
  # Pirx dashboard: whole-file dotenv encryption of the local Grafana admin password.
  - path_regex: grafana\.sops\.env$
    age: age1rdg9cfj48m3j34x6w3wy7m0mpppn9azzns2v72k7mcpj4mw4ap3qj3gk2m
```

Create and encrypt the secret (plaintext exists only until the `sops` call):

```bash
cd /home/pepus/ai-assistant
mkdir -p Pirx/dashboard
umask 077
printf 'GF_SECURITY_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-28)" > Pirx/dashboard/grafana.sops.env
sops --encrypt --in-place Pirx/dashboard/grafana.sops.env
grep -c '^GF_SECURITY_ADMIN_PASSWORD=ENC\[AES256_GCM' Pirx/dashboard/grafana.sops.env
sops --decrypt Pirx/dashboard/grafana.sops.env | cut -d= -f1
git check-ignore -v Pirx/dashboard/grafana.sops.env || echo "not ignored"
```

Expected: `1`, then `GF_SECURITY_ADMIN_PASSWORD` (the name only), then `not ignored`.

- [ ] **Step 2: Compose file and provisioning**

Create `Pirx/dashboard/compose.yaml`:

```yaml
name: pirx-dashboard

services:
  grafana:
    image: grafana/grafana:13.0.8
    # Same uid as the owner of ~/.local/share/pirx (drwx------), so the SQLite file and its WAL are readable.
    user: "1000:1000"
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      GF_PLUGINS_PREINSTALL_SYNC: frser-sqlite-datasource@4.0.6
      GF_SECURITY_ADMIN_PASSWORD: ${GF_SECURITY_ADMIN_PASSWORD:?start the dashboard with ./up.sh}
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_ANALYTICS_REPORTING_ENABLED: "false"
      GF_ANALYTICS_CHECK_FOR_UPDATES: "false"
      GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false"
      GF_LOG_MODE: console
      GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: /etc/grafana/dashboards/pirx/pirx-models.json
    volumes:
      - ${HOME}/.local/share/pirx:/var/lib/pirx
      - ${HOME}/.local/share/pirx-grafana:/var/lib/grafana
      - ./provisioning:/etc/grafana/provisioning:ro
      - ./dashboards:/etc/grafana/dashboards/pirx:ro
```

Create `Pirx/dashboard/provisioning/datasources/pirx.yaml`:

```yaml
apiVersion: 1

datasources:
  - name: Pirx SQLite
    uid: pirx-sqlite
    type: frser-sqlite-datasource
    access: proxy
    isDefault: true
    editable: false
    jsonData:
      # The plugin adds _pragma=query_only(1) itself; no mode=ro because WAL readers need the -shm file.
      path: /var/lib/pirx/pirx.sqlite
```

Create `Pirx/dashboard/provisioning/dashboards/pirx.yaml`:

```yaml
apiVersion: 1

providers:
  - name: pirx
    folder: Pirx
    type: file
    disableDeletion: true
    allowUiUpdates: false
    options:
      path: /etc/grafana/dashboards/pirx
```

Create the empty file `Pirx/dashboard/dashboards/.gitkeep` (dashboards arrive in Task 7).

- [ ] **Step 3: Start, stop and query scripts**

Create `Pirx/dashboard/up.sh`:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$(readlink -f "$0")")"

DATABASE="${HOME}/.local/share/pirx/pirx.sqlite"
DATA_DIR="${HOME}/.local/share/pirx-grafana"
AGE_KEY="${SOPS_AGE_KEY_FILE:-${HOME}/.config/sops/age/keys.txt}"

if [[ ! -f "$DATABASE" ]]; then
  echo "Brak bazy Pirxa: $DATABASE. Uruchom najpierw Pirx albo import logów." >&2
  exit 1
fi
if [[ ! -f "$AGE_KEY" ]]; then
  echo "Brak klucza age: $AGE_KEY. Bez niego sops nie odszyfruje grafana.sops.env." >&2
  exit 1
fi

mkdir -p -m 700 "$DATA_DIR"
exec sops exec-env grafana.sops.env 'docker compose -f compose.yaml up -d --wait'
```

Create `Pirx/dashboard/down.sh`:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$(readlink -f "$0")")"
exec sops exec-env grafana.sops.env 'docker compose -f compose.yaml down'
```

Create `Pirx/dashboard/query.sh` (runs one SQL statement through the provisioned datasource; used for verification):

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$(readlink -f "$0")")"

SQL="${1:?użycie: ./query.sh \"SELECT ...\"}"
BODY="$(SQL="$SQL" python3 -c '
import json, os
sql = os.environ["SQL"]
print(json.dumps({
    "queries": [{
        "refId": "A",
        "datasource": {"uid": "pirx-sqlite"},
        "rawQueryText": sql,
        "queryText": sql,
        "queryType": "table",
        "timeColumns": [],
    }],
    "from": "now-365d",
    "to": "now",
}))')"
export BODY
exec sops exec-env grafana.sops.env 'curl -sS --fail-with-body -u "admin:${GF_SECURITY_ADMIN_PASSWORD}" -H "content-type: application/json" --data "$BODY" http://127.0.0.1:3000/api/ds/query'
```

```bash
chmod +x Pirx/dashboard/up.sh Pirx/dashboard/down.sh Pirx/dashboard/query.sh
```

- [ ] **Step 4: Start Grafana and check the risks**

```bash
cd /home/pepus/ai-assistant/Pirx/dashboard
./up.sh
curl -s http://127.0.0.1:3000/api/health
docker exec pirx-dashboard-grafana-1 ls /var/lib/grafana/plugins
docker logs pirx-dashboard-grafana-1 2>&1 | grep -iE "frser|signature|error" | tail -20
./query.sh "SELECT sqlite_version() AS version, (SELECT COUNT(*) FROM turns) AS turns" | python3 -c 'import json, sys; frame = json.load(sys.stdin)["results"]["A"]["frames"][0]; print(frame["data"]["values"])'
```

Expected:
- health JSON with `"database": "ok"`,
- `frser-sqlite-datasource` listed in the plugins directory,
- no `invalid signature` / plugin load errors in the log,
- values like `[['3.46.1'], [106]]`: a version string and the turn count (≥ 105 after Task 5).

If the plugin is not installed or refuses to load, stop and report the log lines; do not enable unsigned plugins. If `sqlite_version()` is below `3.31.0`, stop and report: the dashboards in Task 7 use the JSON path `[#-1]`, which needs 3.31.

WAL check: while Grafana runs, send one message in `pnpm tui`, exit, and run the `query.sh` line again. Expected: `turns` grew by 1.

- [ ] **Step 5: README**

Create `Pirx/dashboard/README.md`:

````markdown
# Dashboard Pirxa (Grafana)

Trzy dashboardy tylko do odczytu na bazie `~/.local/share/pirx/pirx.sqlite`:
wydajność modeli, narzędzia i błędy, rozmowy.

## Start i stop

```bash
./up.sh     # odszyfrowuje grafana.sops.env przez sops i uruchamia Grafanę na 127.0.0.1:3000
./down.sh
```

Wymaga Dockera, `sops` i klucza age w `~/.config/sops/age/keys.txt`.
Stan Grafany leży w `~/.local/share/pirx-grafana`.

## Dostęp z Maca

```bash
ssh -L 3000:127.0.0.1:3000 pepus@pepus-pc.taild372e3.ts.net
```

Potem `http://localhost:3000`, użytkownik `admin`. Hasło:

```bash
sops --decrypt grafana.sops.env
```

`GF_SECURITY_ADMIN_PASSWORD` działa tylko przy pierwszym starcie z pustym
`~/.local/share/pirx-grafana`. Zmiana hasła później:

```bash
docker exec -it pirx-dashboard-grafana-1 grafana cli admin reset-admin-password '<nowe hasło>'
sops edit grafana.sops.env   # wpisz to samo hasło
```

## Diagnostyka

```bash
./query.sh "SELECT COUNT(*) AS turns FROM turns"
docker logs pirx-dashboard-grafana-1 2>&1 | tail -50
```

Dane historyczne sprzed zapisu z TUI importuje `pnpm --filter @pirx/agent import:logs`
(z katalogu `Pirx`). Operacje narzędzi są tylko dla nowych sesji.
````

- [ ] **Step 6: Commit**

```bash
cd /home/pepus/ai-assistant
git add .sops.yaml Pirx/dashboard/grafana.sops.env Pirx/dashboard/compose.yaml Pirx/dashboard/provisioning Pirx/dashboard/dashboards/.gitkeep Pirx/dashboard/up.sh Pirx/dashboard/down.sh Pirx/dashboard/query.sh Pirx/dashboard/README.md
git commit -m "Run a local Grafana for Pirx with a sops-managed admin password"
```

---

### Task 7: Dashboard query test harness and the model performance dashboard

**Files:**
- Create: `Pirx/agent/test/dashboard-queries.test.ts`
- Create: `Pirx/dashboard/dashboards/pirx-models.json`

The test reads every `Pirx/dashboard/dashboards/*.json`, substitutes Grafana variables with fixed values, and runs each SQL statement with `node:sqlite` against a temporary database filled by the importer (Task 5) and one recorded session built with `SqliteStore`. Tasks 8 and 9 add their dashboards and assertions to the same file.

- [ ] **Step 1: Write the failing test**

Create `Pirx/agent/test/dashboard-queries.test.ts`:

```ts
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
      comparison.map((row) => [row["Model"], row["Tury"], row["Mediana czasu [s]"], row["p95 czasu [s]"]]).sort(),
      [
        ["gemma4:12b", 1, 4, 4],
        ["qwen3:14b", 1, 1.5, 1.5],
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p agent/tsconfig.test.json && node --test agent/dist-test/test/dashboard-queries.test.js`
Expected: FAIL with `no dashboards found` and `dashboard pirx-models is missing`.

- [ ] **Step 3: Create the dashboard**

Create `Pirx/dashboard/dashboards/pirx-models.json`:

```json
{
  "uid": "pirx-models",
  "title": "Pirx · Wydajność modeli",
  "tags": ["pirx"],
  "timezone": "browser",
  "schemaVersion": 41,
  "version": 1,
  "editable": false,
  "refresh": "1m",
  "time": { "from": "now-90d", "to": "now" },
  "templating": {
    "list": [
      {
        "name": "model",
        "label": "Model",
        "type": "query",
        "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
        "query": "SELECT DISTINCT json_extract(payload_json, '$.metrics.model') AS __text, json_extract(payload_json, '$.metrics.model') AS __value FROM turns WHERE json_extract(payload_json, '$.metrics.model') IS NOT NULL ORDER BY 1",
        "definition": "SELECT DISTINCT json_extract(payload_json, '$.metrics.model') AS __text, json_extract(payload_json, '$.metrics.model') AS __value FROM turns WHERE json_extract(payload_json, '$.metrics.model') IS NOT NULL ORDER BY 1",
        "refresh": 1,
        "multi": true,
        "includeAll": true,
        "current": { "text": ["All"], "value": ["$__all"] },
        "options": [],
        "sort": 1
      }
    ]
  },
  "panels": [
    {
      "id": 1,
      "type": "timeseries",
      "title": "Czas tury [s]",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": ["time"],
          "rawQueryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') AS model, json_extract(t.payload_json, '$.metrics.turn_duration_ms') / 1000.0 AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.turn_duration_ms') IS NOT NULL ORDER BY time",
          "queryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') AS model, json_extract(t.payload_json, '$.metrics.turn_duration_ms') / 1000.0 AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.turn_duration_ms') IS NOT NULL ORDER BY time"
        }
      ],
      "transformations": [{ "id": "prepareTimeSeries", "options": { "format": "multi" } }],
      "fieldConfig": { "defaults": { "unit": "s", "custom": { "drawStyle": "points", "pointSize": 6 } }, "overrides": [] },
      "options": { "legend": { "displayMode": "list", "placement": "bottom" }, "tooltip": { "mode": "multi" } }
    },
    {
      "id": 2,
      "type": "timeseries",
      "title": "Generacja [tok/s]",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": ["time"],
          "rawQueryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') AS model, json_extract(t.payload_json, '$.metrics.generation_tokens_per_second') AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.generation_tokens_per_second') IS NOT NULL ORDER BY time",
          "queryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') AS model, json_extract(t.payload_json, '$.metrics.generation_tokens_per_second') AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.generation_tokens_per_second') IS NOT NULL ORDER BY time"
        }
      ],
      "transformations": [{ "id": "prepareTimeSeries", "options": { "format": "multi" } }],
      "fieldConfig": { "defaults": { "custom": { "drawStyle": "points", "pointSize": 6 } }, "overrides": [] },
      "options": { "legend": { "displayMode": "list", "placement": "bottom" }, "tooltip": { "mode": "multi" } }
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Prefill [tok/s]",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": ["time"],
          "rawQueryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') AS model, json_extract(t.payload_json, '$.metrics.prompt_tokens_per_second') AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.prompt_tokens_per_second') IS NOT NULL ORDER BY time",
          "queryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') AS model, json_extract(t.payload_json, '$.metrics.prompt_tokens_per_second') AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.prompt_tokens_per_second') IS NOT NULL ORDER BY time"
        }
      ],
      "transformations": [{ "id": "prepareTimeSeries", "options": { "format": "multi" } }],
      "fieldConfig": { "defaults": { "custom": { "drawStyle": "points", "pointSize": 6 } }, "overrides": [] },
      "options": { "legend": { "displayMode": "list", "placement": "bottom" }, "tooltip": { "mode": "multi" } }
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Tokeny na turę",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": ["time"],
          "rawQueryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') || ' · wejście' AS series, json_extract(t.payload_json, '$.metrics.input_tokens') AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.input_tokens') IS NOT NULL UNION ALL SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') || ' · wyjście' AS series, json_extract(t.payload_json, '$.metrics.output_tokens') AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.output_tokens') IS NOT NULL ORDER BY time",
          "queryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') || ' · wejście' AS series, json_extract(t.payload_json, '$.metrics.input_tokens') AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.input_tokens') IS NOT NULL UNION ALL SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') || ' · wyjście' AS series, json_extract(t.payload_json, '$.metrics.output_tokens') AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.output_tokens') IS NOT NULL ORDER BY time"
        }
      ],
      "transformations": [{ "id": "prepareTimeSeries", "options": { "format": "multi" } }],
      "fieldConfig": { "defaults": { "custom": { "drawStyle": "points", "pointSize": 6 } }, "overrides": [] },
      "options": { "legend": { "displayMode": "list", "placement": "bottom" }, "tooltip": { "mode": "multi" } }
    },
    {
      "id": 5,
      "type": "timeseries",
      "title": "Zajętość kontekstu [%]",
      "gridPos": { "h": 8, "w": 24, "x": 0, "y": 16 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": ["time"],
          "rawQueryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') AS model, ROUND(100.0 * json_extract(t.payload_json, '$.metrics.context_estimates[#-1].estimatedInputTokens') / json_extract(t.payload_json, '$.metrics.context_estimates[#-1].inputBudgetTokens'), 1) AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.context_estimates[#-1].inputBudgetTokens') > 0 ORDER BY time",
          "queryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS time, json_extract(t.payload_json, '$.metrics.model') AS model, ROUND(100.0 * json_extract(t.payload_json, '$.metrics.context_estimates[#-1].estimatedInputTokens') / json_extract(t.payload_json, '$.metrics.context_estimates[#-1].inputBudgetTokens'), 1) AS value FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring}) AND json_extract(t.payload_json, '$.metrics.context_estimates[#-1].inputBudgetTokens') > 0 ORDER BY time"
        }
      ],
      "transformations": [{ "id": "prepareTimeSeries", "options": { "format": "multi" } }],
      "fieldConfig": { "defaults": { "unit": "percent", "min": 0, "max": 100, "custom": { "drawStyle": "points", "pointSize": 6 } }, "overrides": [] },
      "options": { "legend": { "displayMode": "list", "placement": "bottom" }, "tooltip": { "mode": "multi" } }
    },
    {
      "id": 6,
      "type": "table",
      "title": "Porównanie modeli",
      "gridPos": { "h": 8, "w": 24, "x": 0, "y": 24 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": [],
          "rawQueryText": "WITH turn_stats AS (SELECT json_extract(t.payload_json, '$.metrics.model') AS model, json_extract(t.payload_json, '$.metrics.turn_duration_ms') AS duration_ms, json_extract(t.payload_json, '$.metrics.generation_tokens_per_second') AS generation_tps, json_extract(t.payload_json, '$.metrics.model_calls') AS model_calls, json_extract(t.payload_json, '$.metrics.tool_calls') AS tool_calls FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring})), ranked AS (SELECT model, duration_ms, generation_tps, model_calls, tool_calls, ROW_NUMBER() OVER (PARTITION BY model ORDER BY duration_ms) AS position, COUNT(*) OVER (PARTITION BY model) AS total FROM turn_stats WHERE duration_ms IS NOT NULL) SELECT model AS `Model`, MAX(total) AS `Tury`, ROUND(MAX(CASE WHEN position = (total + 1) / 2 THEN duration_ms END) / 1000.0, 2) AS `Mediana czasu [s]`, ROUND(MAX(CASE WHEN position = CAST(0.95 * total + 0.999999 AS INTEGER) THEN duration_ms END) / 1000.0, 2) AS `p95 czasu [s]`, ROUND(AVG(generation_tps), 1) AS `Generacja [tok/s]`, ROUND(AVG(model_calls), 2) AS `Wywołania modelu`, ROUND(AVG(tool_calls), 2) AS `Wywołania narzędzi` FROM ranked GROUP BY model ORDER BY `Tury` DESC",
          "queryText": "WITH turn_stats AS (SELECT json_extract(t.payload_json, '$.metrics.model') AS model, json_extract(t.payload_json, '$.metrics.turn_duration_ms') AS duration_ms, json_extract(t.payload_json, '$.metrics.generation_tokens_per_second') AS generation_tps, json_extract(t.payload_json, '$.metrics.model_calls') AS model_calls, json_extract(t.payload_json, '$.metrics.tool_calls') AS tool_calls FROM turns t WHERE t.status = 'completed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND json_extract(t.payload_json, '$.metrics.model') IN (${model:sqlstring})), ranked AS (SELECT model, duration_ms, generation_tps, model_calls, tool_calls, ROW_NUMBER() OVER (PARTITION BY model ORDER BY duration_ms) AS position, COUNT(*) OVER (PARTITION BY model) AS total FROM turn_stats WHERE duration_ms IS NOT NULL) SELECT model AS `Model`, MAX(total) AS `Tury`, ROUND(MAX(CASE WHEN position = (total + 1) / 2 THEN duration_ms END) / 1000.0, 2) AS `Mediana czasu [s]`, ROUND(MAX(CASE WHEN position = CAST(0.95 * total + 0.999999 AS INTEGER) THEN duration_ms END) / 1000.0, 2) AS `p95 czasu [s]`, ROUND(AVG(generation_tps), 1) AS `Generacja [tok/s]`, ROUND(AVG(model_calls), 2) AS `Wywołania modelu`, ROUND(AVG(tool_calls), 2) AS `Wywołania narzędzi` FROM ranked GROUP BY model ORDER BY `Tury` DESC"
        }
      ],
      "fieldConfig": { "defaults": { "custom": { "inspect": true } }, "overrides": [] },
      "options": { "showHeader": true }
    }
  ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -p agent/tsconfig.test.json && node --test agent/dist-test/test/dashboard-queries.test.js`
Expected: 2 tests pass.

- [ ] **Step 5: Check the dashboard in Grafana**

The file provider re-reads the directory every 10 seconds, so no restart is needed.

```bash
cd /home/pepus/ai-assistant/Pirx/dashboard
sleep 15
sops exec-env grafana.sops.env 'curl -sS -u "admin:${GF_SECURITY_ADMIN_PASSWORD}" "http://127.0.0.1:3000/api/search?query=Pirx"' | python3 -m json.tool
```

Expected: an entry with `"uid": "pirx-models"` in folder `Pirx`. Open it through the tunnel (see `Pirx/dashboard/README.md`) and confirm the `Model` variable lists the imported models and that all six panels show data without a red error corner.

- [ ] **Step 6: Commit**

```bash
cd /home/pepus/ai-assistant
git add Pirx/agent/test/dashboard-queries.test.ts Pirx/dashboard/dashboards/pirx-models.json
git commit -m "Add the Pirx model performance dashboard with SQL tests"
```

---

### Task 8: Tools and errors dashboard

**Files:**
- Modify: `Pirx/agent/test/dashboard-queries.test.ts` (append one test)
- Create: `Pirx/dashboard/dashboards/pirx-tools.json`

Every query filters by the Grafana time range on `started_at` of the table it reads. Operations exist only for sessions recorded after Task 3; imported history has none.

- [ ] **Step 1: Write the failing test**

Append to `Pirx/agent/test/dashboard-queries.test.ts`:

```ts
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
```

(`1789290000000` ms is 2026-09-13T09:00:00Z, one hour before the seeded operations, so the range check must return no rows.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p agent/tsconfig.test.json && node --test agent/dist-test/test/dashboard-queries.test.js`
Expected: the new test fails with `dashboard pirx-tools is missing`; the two earlier tests still pass.

- [ ] **Step 3: Create the dashboard**

Create `Pirx/dashboard/dashboards/pirx-tools.json`:

```json
{
  "uid": "pirx-tools",
  "title": "Pirx · Narzędzia i błędy",
  "tags": ["pirx"],
  "timezone": "browser",
  "schemaVersion": 41,
  "version": 1,
  "editable": false,
  "refresh": "1m",
  "time": { "from": "now-30d", "to": "now" },
  "templating": { "list": [] },
  "panels": [
    {
      "id": 1,
      "type": "barchart",
      "title": "Wywołania na narzędzie",
      "gridPos": { "h": 9, "w": 12, "x": 0, "y": 0 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": [],
          "rawQueryText": "SELECT json_extract(o.payload_json, '$.tool_name') AS `Narzędzie`, COUNT(*) AS `Wywołania` FROM operations o WHERE o.kind = 'mcp' AND CAST(strftime('%s', o.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', o.started_at) AS INTEGER) < $__to / 1000 GROUP BY 1 ORDER BY 2 DESC",
          "queryText": "SELECT json_extract(o.payload_json, '$.tool_name') AS `Narzędzie`, COUNT(*) AS `Wywołania` FROM operations o WHERE o.kind = 'mcp' AND CAST(strftime('%s', o.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', o.started_at) AS INTEGER) < $__to / 1000 GROUP BY 1 ORDER BY 2 DESC"
        }
      ],
      "fieldConfig": { "defaults": {}, "overrides": [] },
      "options": { "xField": "Narzędzie", "orientation": "horizontal", "legend": { "showLegend": false } }
    },
    {
      "id": 2,
      "type": "table",
      "title": "Narzędzia: błędy i czasy",
      "gridPos": { "h": 9, "w": 12, "x": 12, "y": 0 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": [],
          "rawQueryText": "WITH calls AS (SELECT json_extract(o.payload_json, '$.tool_name') AS tool, o.status AS status, json_extract(o.payload_json, '$.wall_duration_ms') AS duration_ms FROM operations o WHERE o.kind = 'mcp' AND CAST(strftime('%s', o.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', o.started_at) AS INTEGER) < $__to / 1000), ranked AS (SELECT tool, status, duration_ms, ROW_NUMBER() OVER (PARTITION BY tool ORDER BY duration_ms IS NULL, duration_ms) AS position, COUNT(duration_ms) OVER (PARTITION BY tool) AS timed FROM calls) SELECT tool AS `Narzędzie`, COUNT(*) AS `Wywołania`, SUM(CASE WHEN status <> 'succeeded' THEN 1 ELSE 0 END) AS `Błędy`, ROUND(100.0 * SUM(CASE WHEN status <> 'succeeded' THEN 1 ELSE 0 END) / COUNT(*), 1) AS `Błędy [%]`, ROUND(MAX(CASE WHEN duration_ms IS NOT NULL AND position = (timed + 1) / 2 THEN duration_ms END)) AS `Mediana [ms]`, ROUND(MAX(CASE WHEN duration_ms IS NOT NULL AND position = CAST(0.95 * timed + 0.999999 AS INTEGER) THEN duration_ms END)) AS `p95 [ms]` FROM ranked GROUP BY tool ORDER BY `Wywołania` DESC",
          "queryText": "WITH calls AS (SELECT json_extract(o.payload_json, '$.tool_name') AS tool, o.status AS status, json_extract(o.payload_json, '$.wall_duration_ms') AS duration_ms FROM operations o WHERE o.kind = 'mcp' AND CAST(strftime('%s', o.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', o.started_at) AS INTEGER) < $__to / 1000), ranked AS (SELECT tool, status, duration_ms, ROW_NUMBER() OVER (PARTITION BY tool ORDER BY duration_ms IS NULL, duration_ms) AS position, COUNT(duration_ms) OVER (PARTITION BY tool) AS timed FROM calls) SELECT tool AS `Narzędzie`, COUNT(*) AS `Wywołania`, SUM(CASE WHEN status <> 'succeeded' THEN 1 ELSE 0 END) AS `Błędy`, ROUND(100.0 * SUM(CASE WHEN status <> 'succeeded' THEN 1 ELSE 0 END) / COUNT(*), 1) AS `Błędy [%]`, ROUND(MAX(CASE WHEN duration_ms IS NOT NULL AND position = (timed + 1) / 2 THEN duration_ms END)) AS `Mediana [ms]`, ROUND(MAX(CASE WHEN duration_ms IS NOT NULL AND position = CAST(0.95 * timed + 0.999999 AS INTEGER) THEN duration_ms END)) AS `p95 [ms]` FROM ranked GROUP BY tool ORDER BY `Wywołania` DESC"
        }
      ],
      "fieldConfig": { "defaults": { "custom": { "inspect": true } }, "overrides": [] },
      "options": { "showHeader": true }
    },
    {
      "id": 3,
      "type": "table",
      "title": "Ostatnie błędy narzędzi",
      "gridPos": { "h": 9, "w": 24, "x": 0, "y": 9 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": ["Czas"],
          "rawQueryText": "SELECT CAST(strftime('%s', o.started_at) AS INTEGER) AS `Czas`, json_extract(o.payload_json, '$.tool_name') AS `Narzędzie`, o.status AS `Status`, COALESCE(o.error, '') AS `Błąd`, t.user_prompt AS `Pytanie` FROM operations o JOIN turns t ON t.id = o.turn_id WHERE o.kind = 'mcp' AND o.status <> 'succeeded' AND CAST(strftime('%s', o.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', o.started_at) AS INTEGER) < $__to / 1000 ORDER BY o.started_at DESC LIMIT 100",
          "queryText": "SELECT CAST(strftime('%s', o.started_at) AS INTEGER) AS `Czas`, json_extract(o.payload_json, '$.tool_name') AS `Narzędzie`, o.status AS `Status`, COALESCE(o.error, '') AS `Błąd`, t.user_prompt AS `Pytanie` FROM operations o JOIN turns t ON t.id = o.turn_id WHERE o.kind = 'mcp' AND o.status <> 'succeeded' AND CAST(strftime('%s', o.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', o.started_at) AS INTEGER) < $__to / 1000 ORDER BY o.started_at DESC LIMIT 100"
        }
      ],
      "fieldConfig": { "defaults": { "custom": { "inspect": true } }, "overrides": [] },
      "options": { "showHeader": true }
    },
    {
      "id": 4,
      "type": "table",
      "title": "Nieudane tury",
      "gridPos": { "h": 9, "w": 12, "x": 0, "y": 18 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": ["Czas"],
          "rawQueryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS `Czas`, t.user_prompt AS `Pytanie`, COALESCE(json_extract(t.payload_json, '$.error'), '') AS `Błąd`, t.session_id AS `Sesja` FROM turns t WHERE t.status = 'failed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 ORDER BY t.started_at DESC LIMIT 100",
          "queryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS `Czas`, t.user_prompt AS `Pytanie`, COALESCE(json_extract(t.payload_json, '$.error'), '') AS `Błąd`, t.session_id AS `Sesja` FROM turns t WHERE t.status = 'failed' AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 ORDER BY t.started_at DESC LIMIT 100"
        }
      ],
      "fieldConfig": { "defaults": { "custom": { "inspect": true } }, "overrides": [] },
      "options": { "showHeader": true }
    },
    {
      "id": 5,
      "type": "stat",
      "title": "Tury przerwane przez limit",
      "gridPos": { "h": 9, "w": 4, "x": 12, "y": 18 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": [],
          "rawQueryText": "SELECT COUNT(*) AS `Tury` FROM turns t WHERE json_extract(t.payload_json, '$.metrics.done_reason') IN ('tool_iteration_limit', 'unexpected_loop_end') AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000",
          "queryText": "SELECT COUNT(*) AS `Tury` FROM turns t WHERE json_extract(t.payload_json, '$.metrics.done_reason') IN ('tool_iteration_limit', 'unexpected_loop_end') AND CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000"
        }
      ],
      "fieldConfig": { "defaults": { "thresholds": { "mode": "absolute", "steps": [{ "color": "green", "value": null }, { "color": "orange", "value": 1 }] } }, "overrides": [] },
      "options": { "reduceOptions": { "calcs": ["lastNotNull"], "fields": "", "values": false }, "colorMode": "value", "graphMode": "none" }
    },
    {
      "id": 6,
      "type": "table",
      "title": "Nieudane sesje",
      "gridPos": { "h": 9, "w": 8, "x": 16, "y": 18 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": ["Czas"],
          "rawQueryText": "SELECT CAST(strftime('%s', s.started_at) AS INTEGER) AS `Czas`, s.id AS `Sesja`, COALESCE(json_extract(e.payload_json, '$.model'), '') AS `Model`, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS `Tury` FROM sessions s JOIN run_environments e ON e.id = s.environment_id WHERE s.status = 'failed' AND CAST(strftime('%s', s.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', s.started_at) AS INTEGER) < $__to / 1000 ORDER BY s.started_at DESC LIMIT 100",
          "queryText": "SELECT CAST(strftime('%s', s.started_at) AS INTEGER) AS `Czas`, s.id AS `Sesja`, COALESCE(json_extract(e.payload_json, '$.model'), '') AS `Model`, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS `Tury` FROM sessions s JOIN run_environments e ON e.id = s.environment_id WHERE s.status = 'failed' AND CAST(strftime('%s', s.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', s.started_at) AS INTEGER) < $__to / 1000 ORDER BY s.started_at DESC LIMIT 100"
        }
      ],
      "fieldConfig": { "defaults": { "custom": { "inspect": true } }, "overrides": [] },
      "options": { "showHeader": true }
    }
  ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -p agent/tsconfig.test.json && node --test agent/dist-test/test/dashboard-queries.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Check the dashboard in Grafana**

```bash
cd /home/pepus/ai-assistant/Pirx/dashboard
sleep 15
sops exec-env grafana.sops.env 'curl -sS -u "admin:${GF_SECURITY_ADMIN_PASSWORD}" "http://127.0.0.1:3000/api/search?query=Pirx"' | python3 -m json.tool
```

Expected: `pirx-tools` listed. Through the tunnel, the panels load without errors (tables may be empty until a recorded session used tools).

- [ ] **Step 6: Commit**

```bash
cd /home/pepus/ai-assistant
git add Pirx/agent/test/dashboard-queries.test.ts Pirx/dashboard/dashboards/pirx-tools.json
git commit -m "Add the Pirx tools and errors dashboard"
```

---

### Task 9: Conversations dashboard

**Files:**
- Modify: `Pirx/agent/test/dashboard-queries.test.ts` (append one test)
- Create: `Pirx/dashboard/dashboards/pirx-conversations.json`

Variables: `session` (all or one session), `search` (text), `turn` (turns of the selected session). The `Id tury` column links back to the same dashboard with `session` and `turn` set, so a click opens the turn's messages and operations.

- [ ] **Step 1: Write the failing test**

Append to `Pirx/agent/test/dashboard-queries.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsc -p agent/tsconfig.test.json && node --test agent/dist-test/test/dashboard-queries.test.js`
Expected: the new test fails with `dashboard pirx-conversations is missing`; the three earlier tests pass.

- [ ] **Step 3: Create the dashboard**

Create `Pirx/dashboard/dashboards/pirx-conversations.json`:

```json
{
  "uid": "pirx-conversations",
  "title": "Pirx · Rozmowy",
  "tags": ["pirx"],
  "timezone": "browser",
  "schemaVersion": 41,
  "version": 1,
  "editable": false,
  "refresh": "",
  "time": { "from": "now-90d", "to": "now" },
  "templating": {
    "list": [
      {
        "name": "session",
        "label": "Sesja",
        "type": "query",
        "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
        "query": "SELECT s.id AS __value, strftime('%Y-%m-%d %H:%M', s.started_at) || ' · ' || COALESCE(json_extract(e.payload_json, '$.model'), '?') || ' · ' || (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) || ' tur' || CASE WHEN json_extract(e.payload_json, '$.imported_from') IS NOT NULL THEN ' · import' ELSE '' END AS __text FROM sessions s JOIN run_environments e ON e.id = s.environment_id ORDER BY CAST(strftime('%s', s.started_at) AS INTEGER) DESC",
        "definition": "SELECT s.id AS __value, strftime('%Y-%m-%d %H:%M', s.started_at) || ' · ' || COALESCE(json_extract(e.payload_json, '$.model'), '?') || ' · ' || (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) || ' tur' || CASE WHEN json_extract(e.payload_json, '$.imported_from') IS NOT NULL THEN ' · import' ELSE '' END AS __text FROM sessions s JOIN run_environments e ON e.id = s.environment_id ORDER BY CAST(strftime('%s', s.started_at) AS INTEGER) DESC",
        "refresh": 2,
        "multi": false,
        "includeAll": true,
        "allValue": "__all",
        "current": { "text": "All", "value": "$__all" },
        "options": [],
        "sort": 0
      },
      {
        "name": "search",
        "label": "Szukaj w pytaniach i odpowiedziach",
        "type": "textbox",
        "query": "",
        "current": { "text": "", "value": "" }
      },
      {
        "name": "turn",
        "label": "Tura",
        "type": "query",
        "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
        "query": "SELECT t.id AS __value, t.sequence || ': ' || substr(t.user_prompt, 1, 60) AS __text FROM turns t WHERE t.session_id = ${session:sqlstring} ORDER BY t.sequence",
        "definition": "SELECT t.id AS __value, t.sequence || ': ' || substr(t.user_prompt, 1, 60) AS __text FROM turns t WHERE t.session_id = ${session:sqlstring} ORDER BY t.sequence",
        "refresh": 1,
        "multi": false,
        "includeAll": false,
        "current": {},
        "options": [],
        "sort": 0
      }
    ]
  },
  "panels": [
    {
      "id": 1,
      "type": "table",
      "title": "Tury",
      "gridPos": { "h": 12, "w": 24, "x": 0, "y": 0 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": ["Czas"],
          "rawQueryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS `Czas`, t.sequence AS `Nr`, t.user_prompt AS `Pytanie`, COALESCE(json_extract(t.payload_json, '$.response'), json_extract(t.payload_json, '$.error'), '') AS `Odpowiedź`, COALESCE(json_extract(t.payload_json, '$.metrics.model'), '') AS `Model`, json_extract(t.payload_json, '$.metrics.tool_calls') AS `Narzędzia`, ROUND(json_extract(t.payload_json, '$.metrics.turn_duration_ms') / 1000.0, 1) AS `Czas tury [s]`, t.status AS `Status`, t.session_id AS `Sesja`, t.id AS `Id tury` FROM turns t WHERE CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND (${session:sqlstring} = '__all' OR t.session_id = ${session:sqlstring}) AND (${search:sqlstring} = '' OR t.user_prompt LIKE '%' || ${search:sqlstring} || '%' OR json_extract(t.payload_json, '$.response') LIKE '%' || ${search:sqlstring} || '%') ORDER BY CAST(strftime('%s', t.started_at) AS INTEGER) DESC, t.sequence DESC LIMIT 500",
          "queryText": "SELECT CAST(strftime('%s', t.started_at) AS INTEGER) AS `Czas`, t.sequence AS `Nr`, t.user_prompt AS `Pytanie`, COALESCE(json_extract(t.payload_json, '$.response'), json_extract(t.payload_json, '$.error'), '') AS `Odpowiedź`, COALESCE(json_extract(t.payload_json, '$.metrics.model'), '') AS `Model`, json_extract(t.payload_json, '$.metrics.tool_calls') AS `Narzędzia`, ROUND(json_extract(t.payload_json, '$.metrics.turn_duration_ms') / 1000.0, 1) AS `Czas tury [s]`, t.status AS `Status`, t.session_id AS `Sesja`, t.id AS `Id tury` FROM turns t WHERE CAST(strftime('%s', t.started_at) AS INTEGER) >= $__from / 1000 AND CAST(strftime('%s', t.started_at) AS INTEGER) < $__to / 1000 AND (${session:sqlstring} = '__all' OR t.session_id = ${session:sqlstring}) AND (${search:sqlstring} = '' OR t.user_prompt LIKE '%' || ${search:sqlstring} || '%' OR json_extract(t.payload_json, '$.response') LIKE '%' || ${search:sqlstring} || '%') ORDER BY CAST(strftime('%s', t.started_at) AS INTEGER) DESC, t.sequence DESC LIMIT 500"
        }
      ],
      "fieldConfig": {
        "defaults": { "custom": { "inspect": true } },
        "overrides": [
          {
            "matcher": { "id": "byName", "options": "Id tury" },
            "properties": [
              {
                "id": "links",
                "value": [
                  {
                    "title": "Pokaż wiadomości i operacje tury",
                    "url": "/d/pirx-conversations?${__url_time_range}&var-session=${__data.fields.Sesja}&var-turn=${__value.raw}"
                  }
                ]
              }
            ]
          },
          { "matcher": { "id": "byName", "options": "Pytanie" }, "properties": [{ "id": "custom.width", "value": 360 }] },
          { "matcher": { "id": "byName", "options": "Odpowiedź" }, "properties": [{ "id": "custom.width", "value": 480 }] }
        ]
      },
      "options": { "showHeader": true }
    },
    {
      "id": 2,
      "type": "table",
      "title": "Wiadomości tury",
      "gridPos": { "h": 14, "w": 14, "x": 0, "y": 12 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": [],
          "rawQueryText": "SELECT m.sequence AS `Nr`, m.role AS `Rola`, COALESCE(m.tool_name, (SELECT group_concat(json_extract(c.value, '$.function.name'), ', ') FROM json_each(m.payload_json, '$.tool_calls') c), '') AS `Narzędzie`, COALESCE(m.content, '') AS `Treść` FROM messages m WHERE m.turn_id = ${turn:sqlstring} ORDER BY m.sequence",
          "queryText": "SELECT m.sequence AS `Nr`, m.role AS `Rola`, COALESCE(m.tool_name, (SELECT group_concat(json_extract(c.value, '$.function.name'), ', ') FROM json_each(m.payload_json, '$.tool_calls') c), '') AS `Narzędzie`, COALESCE(m.content, '') AS `Treść` FROM messages m WHERE m.turn_id = ${turn:sqlstring} ORDER BY m.sequence"
        }
      ],
      "fieldConfig": { "defaults": { "custom": { "inspect": true } }, "overrides": [] },
      "options": { "showHeader": true }
    },
    {
      "id": 3,
      "type": "table",
      "title": "Operacje tury",
      "gridPos": { "h": 14, "w": 10, "x": 14, "y": 12 },
      "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
      "targets": [
        {
          "refId": "A",
          "datasource": { "type": "frser-sqlite-datasource", "uid": "pirx-sqlite" },
          "queryType": "table",
          "timeColumns": [],
          "rawQueryText": "SELECT o.sequence AS `Nr`, o.kind AS `Rodzaj`, COALESCE(json_extract(o.payload_json, '$.tool_name'), '') AS `Narzędzie`, o.status AS `Status`, ROUND(json_extract(o.payload_json, '$.wall_duration_ms')) AS `Czas [ms]`, COALESCE(o.error, '') AS `Błąd` FROM operations o WHERE o.turn_id = ${turn:sqlstring} ORDER BY o.sequence",
          "queryText": "SELECT o.sequence AS `Nr`, o.kind AS `Rodzaj`, COALESCE(json_extract(o.payload_json, '$.tool_name'), '') AS `Narzędzie`, o.status AS `Status`, ROUND(json_extract(o.payload_json, '$.wall_duration_ms')) AS `Czas [ms]`, COALESCE(o.error, '') AS `Błąd` FROM operations o WHERE o.turn_id = ${turn:sqlstring} ORDER BY o.sequence"
        }
      ],
      "fieldConfig": { "defaults": { "custom": { "inspect": true } }, "overrides": [] },
      "options": { "showHeader": true }
    }
  ]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc -p agent/tsconfig.test.json && node --test agent/dist-test/test/dashboard-queries.test.js`
Expected: 4 tests pass.

- [ ] **Step 5: Check the dashboard in Grafana**

Through the tunnel open `http://localhost:3000/d/pirx-conversations`. Expected:
- `Sesja` lists sessions with `· import` on the historical ones,
- typing in `Szukaj…` filters the `Tury` table,
- clicking an `Id tury` value opens the same dashboard with `Wiadomości tury` and `Operacje tury` filled for that turn (for imported turns both tables are empty, because the logs never had messages or operations).

If the `Sesja`/`Tura` dropdowns show an error about `__text`/`__value`, check the panel query inspector and report the plugin message; do not change the column names without re-running the tests.

- [ ] **Step 6: Commit**

```bash
cd /home/pepus/ai-assistant
git add Pirx/agent/test/dashboard-queries.test.ts Pirx/dashboard/dashboards/pirx-conversations.json
git commit -m "Add the Pirx conversations dashboard"
```

---

### Task 10: Full verification

**Files:** none changed (fix-forward only if a check fails).

- [ ] **Step 1: Whole workspace test suite**

Run: `cd /home/pepus/ai-assistant/Pirx && npm test`
Expected: exit code 0; orchestrator, mcp-server, agent and tui report `ℹ fail 0`. The agent suite now includes `library`, `import-logs`, `dashboard-queries` and the new storage tests; the TUI suite includes `recorded-turn`.

- [ ] **Step 2: Live end-to-end check**

1. Restart the TUI with the new build: `pnpm build && pnpm tui`.
2. Ask: `chce bys odfiltrowal zadania jakie sie znaduja w tym samym milestone jak zadanie 181`, wait for the answer, exit with `/exit`.
3. Make sure Grafana runs: `cd Pirx/dashboard && ./up.sh`.
4. On the Mac: `ssh -L 3000:127.0.0.1:3000 pepus@pepus-pc.taild372e3.ts.net`, open `http://localhost:3000`, log in as `admin` with the password from `sops --decrypt grafana.sops.env`.

Expected:
- **Pirx · Rozmowy:** the newest session is first; its turn shows the question and the answer; clicking `Id tury` shows the messages including `github_issue_get` and `github_issue_list`, and the operations with durations.
- **Pirx · Narzędzia i błędy:** `github_issue_get` and `github_issue_list` each have at least one call.
- **Pirx · Wydajność modeli:** points for `gemma4:12b` on 2026-09-13 plus the imported history back to 2026-07-24; the comparison table lists gemma4:12b, qwen3:14b, gpt-oss:20b and lfm-32k.

- [ ] **Step 3: Security spot checks**

```bash
ss -ltnp | grep ':3000'
git -C /home/pepus/ai-assistant status --short Pirx/dashboard
grep -c 'ENC\[AES256_GCM' /home/pepus/ai-assistant/Pirx/dashboard/grafana.sops.env
```

Expected: Grafana listens only on `127.0.0.1:3000`; no untracked plaintext secret files in `Pirx/dashboard`; the committed secret file contains encrypted values only.

- [ ] **Step 4: Report**

Summarize for the user: test counts per package, the import report numbers, anything that behaved differently from this plan (plugin version, `sqlite_version()`, variable dropdowns), and the commit list.

