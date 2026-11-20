import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Pirx's own local state for coordination (docs/control-center-refactor.md):
 * the Task's worktree and worker session, the single-worker lock, and the journal.
 * Everything else (Issues, PRs, checks, merges, queue) is read live from git and GitHub.
 */

export interface CoordinationTask {
  readonly key: string;
  readonly repository: string;
  readonly issue: number;
  readonly branch: string;
  readonly worktree: string;
  readonly sessionId?: string;
  readonly state: "active" | "parked" | "closed";
  readonly note?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type JournalKind = "tool" | "tick" | "note" | "question" | "verdict";

export interface JournalEntry {
  readonly seq: number;
  readonly at: string;
  readonly tick?: string;
  readonly task?: string;
  readonly kind: JournalKind;
  readonly name: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly ok: boolean;
}

export interface WorkerLock {
  readonly task: string;
  readonly pid: number;
  /** Kernel start time of `pid` (from /proc), so a reused pid is not mistaken for the worker. */
  readonly pidStart?: string;
  readonly startedAt: string;
  readonly logPath: string;
  readonly reportPath: string;
}

export function defaultStoragePath(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.PIRX_STORAGE_FILE?.trim();
  if (explicit) return explicit;
  return join(environment.XDG_DATA_HOME?.trim() || join(environment.HOME ?? homedir(), ".local", "share"), "pirx", "pirx.sqlite");
}

export function taskKey(repository: string, issue: number): string {
  return `${repository}#${issue}`;
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try { return JSON.parse(value); } catch { return value; }
}

export class CoordinationStore {
  readonly #db: DatabaseSync;
  readonly #now: () => string;
  public readonly path: string;

  public constructor(filename: string, now: () => string = () => new Date().toISOString()) {
    this.path = filename;
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.#db = new DatabaseSync(filename);
    this.#now = now;
    this.#db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS coord_tasks (
        key TEXT PRIMARY KEY, repository TEXT NOT NULL, issue INTEGER NOT NULL,
        branch TEXT NOT NULL, worktree TEXT NOT NULL, session_id TEXT,
        state TEXT NOT NULL DEFAULT 'active', note TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coord_journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, tick TEXT, task TEXT,
        kind TEXT NOT NULL, name TEXT NOT NULL, input TEXT, output TEXT, ok INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS coord_journal_task ON coord_journal(task, seq);
      CREATE INDEX IF NOT EXISTS coord_journal_tick ON coord_journal(tick, seq);
      CREATE TABLE IF NOT EXISTS coord_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1), task TEXT NOT NULL, pid INTEGER NOT NULL,
        started_at TEXT NOT NULL, log_path TEXT NOT NULL, report_path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coord_watch (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const lockColumns = (this.#db.prepare("PRAGMA table_info(coord_lock)").all() as { name: string }[]).map((column) => column.name);
    if (!lockColumns.includes("pid_start")) this.#db.exec("ALTER TABLE coord_lock ADD COLUMN pid_start TEXT");
  }

  public close(): void { this.#db.close(); }
  public now(): string { return this.#now(); }

  // ── tasks ──────────────────────────────────────────────────────────────
  public getTask(key: string): CoordinationTask | undefined {
    const row = this.#db.prepare("SELECT * FROM coord_tasks WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  public listTasks(state?: CoordinationTask["state"]): CoordinationTask[] {
    const rows = (state === undefined
      ? this.#db.prepare("SELECT * FROM coord_tasks ORDER BY updated_at DESC").all()
      : this.#db.prepare("SELECT * FROM coord_tasks WHERE state = ? ORDER BY updated_at DESC").all(state)) as Record<string, unknown>[];
    return rows.map(toTask);
  }

  public upsertTask(task: Omit<CoordinationTask, "createdAt" | "updatedAt" | "key"> & { readonly key?: string }): CoordinationTask {
    const key = task.key ?? taskKey(task.repository, task.issue);
    const at = this.#now();
    this.#db.prepare(`INSERT INTO coord_tasks (key, repository, issue, branch, worktree, session_id, state, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET branch = excluded.branch, worktree = excluded.worktree, session_id = excluded.session_id,
        state = excluded.state, note = excluded.note, updated_at = excluded.updated_at`)
      .run(key, task.repository, task.issue, task.branch, task.worktree, task.sessionId ?? null, task.state, task.note ?? null, at, at);
    return this.getTask(key)!;
  }

  // ── journal ────────────────────────────────────────────────────────────
  public append(entry: Omit<JournalEntry, "seq" | "at">): JournalEntry {
    const at = this.#now();
    const result = this.#db.prepare("INSERT INTO coord_journal (at, tick, task, kind, name, input, output, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(at, entry.tick ?? null, entry.task ?? null, entry.kind, entry.name,
        entry.input === undefined ? null : JSON.stringify(entry.input),
        entry.output === undefined ? null : JSON.stringify(entry.output),
        entry.ok ? 1 : 0);
    return { ...entry, seq: Number(result.lastInsertRowid), at };
  }

  public journal(filter: { readonly task?: string; readonly tick?: string; readonly kind?: JournalKind; readonly limit?: number; readonly afterSeq?: number } = {}): JournalEntry[] {
    const where: string[] = []; const args: (string | number)[] = [];
    if (filter.task !== undefined) { where.push("task = ?"); args.push(filter.task); }
    if (filter.tick !== undefined) { where.push("tick = ?"); args.push(filter.tick); }
    if (filter.kind !== undefined) { where.push("kind = ?"); args.push(filter.kind); }
    if (filter.afterSeq !== undefined) { where.push("seq > ?"); args.push(filter.afterSeq); }
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
    const rows = this.#db.prepare(`SELECT * FROM (SELECT * FROM coord_journal ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`} ORDER BY seq DESC LIMIT ${limit}) ORDER BY seq ASC`)
      .all(...args) as Record<string, unknown>[];
    return rows.map(toEntry);
  }

  /** Successful calls of a tool, optionally for one Task, since a time. Used by the per-day caps. */
  public countCalls(name: string, sinceIso: string, filter: { readonly task?: string; readonly inputContains?: string } = {}): number {
    const where = ["kind = 'tool'", "name = ?", "ok = 1", "at >= ?"]; const args: string[] = [name, sinceIso];
    if (filter.task !== undefined) { where.push("task = ?"); args.push(filter.task); }
    if (filter.inputContains !== undefined) { where.push("instr(input, ?) > 0"); args.push(filter.inputContains); }
    const row = this.#db.prepare(`SELECT count(*) AS n FROM coord_journal WHERE ${where.join(" AND ")}`).get(...args) as { n: number };
    return Number(row.n);
  }

  // ── lock ───────────────────────────────────────────────────────────────
  public lock(): WorkerLock | undefined {
    const row = this.#db.prepare("SELECT * FROM coord_lock WHERE id = 1").get() as Record<string, unknown> | undefined;
    return row === undefined ? undefined : { task: String(row.task), pid: Number(row.pid), ...(typeof row.pid_start === "string" ? { pidStart: row.pid_start } : {}), startedAt: String(row.started_at), logPath: String(row.log_path), reportPath: String(row.report_path) };
  }

  /** Takes the lock only when it is free. Returns false while another worker holds it. */
  public acquire(lock: WorkerLock): boolean {
    const result = this.#db.prepare("INSERT OR IGNORE INTO coord_lock (id, task, pid, pid_start, started_at, log_path, report_path) VALUES (1, ?, ?, ?, ?, ?, ?)")
      .run(lock.task, lock.pid, lock.pidStart ?? null, lock.startedAt, lock.logPath, lock.reportPath);
    return Number(result.changes) === 1;
  }

  public setLockPid(pid: number, pidStart?: string): void { this.#db.prepare("UPDATE coord_lock SET pid = ?, pid_start = ? WHERE id = 1").run(pid, pidStart ?? null); }
  public release(): void { this.#db.prepare("DELETE FROM coord_lock WHERE id = 1").run(); }

  // ── watcher cursor ─────────────────────────────────────────────────────
  public watchValue(name: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM coord_watch WHERE name = ?").get(name) as { value: string } | undefined;
    return row?.value;
  }
  public setWatchValue(name: string, value: string): void {
    this.#db.prepare("INSERT INTO coord_watch (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(name, value, this.#now());
  }
}

function toTask(row: Record<string, unknown>): CoordinationTask {
  return {
    key: String(row.key), repository: String(row.repository), issue: Number(row.issue), branch: String(row.branch), worktree: String(row.worktree),
    ...(typeof row.session_id === "string" ? { sessionId: row.session_id } : {}),
    state: String(row.state) as CoordinationTask["state"],
    ...(typeof row.note === "string" ? { note: row.note } : {}),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function toEntry(row: Record<string, unknown>): JournalEntry {
  return {
    seq: Number(row.seq), at: String(row.at),
    ...(typeof row.tick === "string" ? { tick: row.tick } : {}),
    ...(typeof row.task === "string" ? { task: row.task } : {}),
    kind: String(row.kind) as JournalKind, name: String(row.name),
    ...(row.input === null ? {} : { input: parse(row.input) }),
    ...(row.output === null ? {} : { output: parse(row.output) }),
    ok: Number(row.ok) === 1,
  };
}
