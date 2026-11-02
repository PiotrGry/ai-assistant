import { spawn } from "node:child_process";

import type { HeadlessHostShutdownEvaluation, HeadlessHostShutdownPort } from "./headless-service.js";
import { RuntimeSqliteStore, type StorageResult } from "./sqlite.js";
import type { UtcTimestamp } from "./task-domain.js";

export const HOST_SHUTDOWN_SCHEMA_VERSION = 1 as const;
export type HostShutdownTarget = "queue_drained" | "next_checkpoint";
export type HostShutdownState = "armed" | "triggered" | "draining" | "poweroff_requested" | "accepted" | "cancelled" | "failed";

export interface HostShutdownRecord {
  readonly schemaVersion: typeof HOST_SHUTDOWN_SCHEMA_VERSION;
  readonly requestOperationId: string;
  readonly target: HostShutdownTarget;
  readonly state: HostShutdownState;
  readonly checkpointBaseline: number;
  readonly requestedAt: UtcTimestamp;
  readonly requestedBy: string;
  readonly reason: string;
  readonly version: number;
  readonly triggeredAt?: UtcTimestamp;
  readonly terminalAt?: UtcTimestamp;
  readonly terminalOutcome?: string;
}

export type HostShutdownCommand =
  | { readonly action: "arm"; readonly operationId: string; readonly target: HostShutdownTarget; readonly reason: string; readonly requestedBy: string; readonly requestedAt: UtcTimestamp }
  | { readonly action: "cancel"; readonly operationId: string; readonly requestOperationId: string; readonly reason: string; readonly requestedBy: string; readonly requestedAt: UtcTimestamp };

export type HostShutdownCommandResult =
  | { readonly outcome: "applied" | "replayed"; readonly operationId: string; readonly record: HostShutdownRecord; readonly message: string }
  | { readonly outcome: "conflict" | "invalid_request" | "not_found" | "not_cancellable" | "storage_error"; readonly operationId: string; readonly message: string };

export interface HostPowerOffAdapter {
  powerOff(): Promise<{ readonly outcome: "accepted" | "rejected"; readonly message: string }>;
}

export interface SpawnedPowerOffProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type PowerOffSpawn = (executable: string, args: readonly string[], options: { readonly shell: false; readonly stdio: ["ignore", "ignore", "ignore"]; readonly env: NodeJS.ProcessEnv }) => SpawnedPowerOffProcess;

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const STATES = new Set<HostShutdownState>(["armed", "triggered", "draining", "poweroff_requested", "accepted", "cancelled", "failed"]);
const TARGETS = new Set<HostShutdownTarget>(["queue_drained", "next_checkpoint"]);

function text(value: unknown, maximum: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && SAFE_TEXT.test(value); }
function timestamp(value: unknown): value is UtcTimestamp { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)); }
function bounded(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 256); }
function parseRecord(row: Record<string, unknown>): StorageResult<HostShutdownRecord> {
  if (!text(row.request_operation_id, 128) || !OPERATION_ID.test(row.request_operation_id) || !TARGETS.has(row.target as HostShutdownTarget) || !STATES.has(row.state as HostShutdownState) || !Number.isSafeInteger(row.checkpoint_baseline) || (row.checkpoint_baseline as number) < 0 || !timestamp(row.requested_at) || !text(row.requested_by, 128) || !text(row.reason, 256) || !Number.isSafeInteger(row.version) || (row.version as number) < 1) return { outcome: "invalid_record", message: "Stored host shutdown request is invalid." };
  if (row.triggered_at !== null && !timestamp(row.triggered_at) || row.terminal_at !== null && !timestamp(row.terminal_at) || row.terminal_outcome !== null && !text(row.terminal_outcome, 256)) return { outcome: "invalid_record", message: "Stored host shutdown result is invalid." };
  return { outcome: "success", value: Object.freeze({ schemaVersion: 1, requestOperationId: row.request_operation_id, target: row.target as HostShutdownTarget, state: row.state as HostShutdownState, checkpointBaseline: row.checkpoint_baseline as number, requestedAt: row.requested_at, requestedBy: row.requested_by, reason: row.reason, version: row.version as number, ...(row.triggered_at === null ? {} : { triggeredAt: row.triggered_at as UtcTimestamp }), ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at as UtcTimestamp }), ...(row.terminal_outcome === null ? {} : { terminalOutcome: row.terminal_outcome as string }) }) };
}
function commandError(input: HostShutdownCommand): string | undefined {
  if (!text(input.operationId, 128) || !OPERATION_ID.test(input.operationId) || !text(input.reason, 256) || !text(input.requestedBy, 128) || !timestamp(input.requestedAt)) return "Host shutdown command metadata is invalid.";
  if (input.action === "arm") return TARGETS.has(input.target) ? undefined : "Host shutdown target is invalid.";
  return text(input.requestOperationId, 128) && OPERATION_ID.test(input.requestOperationId) ? undefined : "Host shutdown request operation ID is invalid.";
}
function sameCommand(row: Record<string, unknown>, input: HostShutdownCommand): boolean {
  return row.action === input.action && row.target === (input.action === "arm" ? input.target : null) && row.request_operation_id === (input.action === "arm" ? input.operationId : input.requestOperationId) && row.reason === input.reason && row.requested_by === input.requestedBy;
}

export class HostShutdownRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public get(): StorageResult<HostShutdownRecord> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_host_shutdown WHERE singleton = 1").get() as Record<string, unknown> | undefined;
        return row === undefined ? { outcome: "not_found", message: "No host shutdown request exists." } : parseRecord(row);
      } catch { return { outcome: "storage_error", message: "Host shutdown request could not be read." }; }
    });
  }

  public command(input: HostShutdownCommand): HostShutdownCommandResult {
    const invalid = commandError(input);
    if (invalid !== undefined) return { outcome: "invalid_request", operationId: input.operationId, message: invalid };
    const transaction = this.#store.transaction((): StorageResult<HostShutdownCommandResult> => {
      try {
        const replay = this.#store.database.prepare("SELECT * FROM runtime_host_shutdown_commands WHERE operation_id = ?").get(input.operationId) as Record<string, unknown> | undefined;
        if (replay !== undefined) {
          if (!sameCommand(replay, input)) return { outcome: "success", value: { outcome: "conflict", operationId: input.operationId, message: "Host shutdown operation ID conflicts with a different command." } };
          const record = this.get();
          return { outcome: "success", value: record.outcome === "success" ? { outcome: "replayed", operationId: input.operationId, record: record.value, message: "Replayed the durable host shutdown command." } : { outcome: "storage_error", operationId: input.operationId, message: record.message } };
        }
        const current = this.get();
        if (current.outcome !== "success" && current.outcome !== "not_found") return { outcome: "success", value: { outcome: "storage_error", operationId: input.operationId, message: current.message } };
        if (input.action === "arm") {
          if (current.outcome === "success" && ["armed", "triggered", "draining", "poweroff_requested"].includes(current.value.state)) return { outcome: "success", value: { outcome: "conflict", operationId: input.operationId, message: "Another host shutdown request is active." } };
          const baseline = (this.#store.database.prepare("SELECT COALESCE(MAX(created_sequence), 0) AS value FROM runtime_checkpoints").get() as { value: number }).value;
          const version = current.outcome === "success" ? current.value.version + 1 : 1;
          this.#store.database.prepare("INSERT INTO runtime_host_shutdown (singleton, request_operation_id, target, state, checkpoint_baseline, requested_at, requested_by, reason, version, triggered_at, terminal_at, terminal_outcome) VALUES (1, ?, ?, 'armed', ?, ?, ?, ?, ?, NULL, NULL, NULL) ON CONFLICT(singleton) DO UPDATE SET request_operation_id = excluded.request_operation_id, target = excluded.target, state = 'armed', checkpoint_baseline = excluded.checkpoint_baseline, requested_at = excluded.requested_at, requested_by = excluded.requested_by, reason = excluded.reason, version = excluded.version, triggered_at = NULL, terminal_at = NULL, terminal_outcome = NULL").run(input.operationId, input.target, baseline, input.requestedAt, input.requestedBy, input.reason, version);
          this.#store.database.prepare("INSERT INTO runtime_host_shutdown_commands (operation_id, action, request_operation_id, target, reason, requested_by, requested_at, resulting_version) VALUES (?, 'arm', ?, ?, ?, ?, ?, ?)").run(input.operationId, input.operationId, input.target, input.reason, input.requestedBy, input.requestedAt, version);
        } else {
          if (current.outcome !== "success") return { outcome: "success", value: { outcome: "not_found", operationId: input.operationId, message: "The requested host shutdown operation was not found." } };
          if (current.value.requestOperationId !== input.requestOperationId) return { outcome: "success", value: { outcome: "not_found", operationId: input.operationId, message: "The requested host shutdown operation was not found." } };
          if (current.value.state !== "armed") return { outcome: "success", value: { outcome: "not_cancellable", operationId: input.operationId, message: "Host shutdown can only be cancelled while armed." } };
          const version = current.value.version + 1;
          this.#store.database.prepare("UPDATE runtime_host_shutdown SET state = 'cancelled', version = ?, terminal_at = ?, terminal_outcome = 'cancelled_by_operator' WHERE singleton = 1 AND state = 'armed'").run(version, input.requestedAt);
          this.#store.database.prepare("INSERT INTO runtime_host_shutdown_commands (operation_id, action, request_operation_id, target, reason, requested_by, requested_at, resulting_version) VALUES (?, 'cancel', ?, NULL, ?, ?, ?, ?)").run(input.operationId, input.requestOperationId, input.reason, input.requestedBy, input.requestedAt, version);
        }
        const saved = this.get();
        return { outcome: "success", value: saved.outcome === "success" ? { outcome: "applied", operationId: input.operationId, record: saved.value, message: "Durable host shutdown command applied." } : { outcome: "storage_error", operationId: input.operationId, message: saved.message } };
      } catch { return { outcome: "storage_error", message: "Host shutdown command could not be stored." }; }
    });
    return transaction.outcome === "success" ? transaction.value : { outcome: "storage_error", operationId: input.operationId, message: transaction.message };
  }

  public evaluate(input: { readonly queueOutcome?: string; readonly deliveryOutcome?: string; readonly cycleOutcome?: string; readonly now: UtcTimestamp; readonly adapterConfigured: boolean }): HeadlessHostShutdownEvaluation {
    if (!timestamp(input.now)) return { outcome: "error", message: "Host shutdown evaluation time is invalid." };
    const transaction = this.#store.transaction((): StorageResult<HeadlessHostShutdownEvaluation> => {
      const current = this.get();
      if (current.outcome === "not_found" || current.outcome === "success" && ["accepted", "cancelled", "failed", "poweroff_requested"].includes(current.value.state)) return { outcome: "success", value: { outcome: "idle" } };
      if (current.outcome !== "success") return { outcome: "success", value: { outcome: "error", message: current.message } };
      if (!input.adapterConfigured) {
        this.#store.database.prepare("UPDATE runtime_host_shutdown SET state = 'failed', version = version + 1, terminal_at = ?, terminal_outcome = 'host_poweroff_adapter_not_configured' WHERE singleton = 1 AND state IN ('armed', 'triggered', 'draining')").run(input.now);
        return { outcome: "success", value: { outcome: "error", message: "Host power-off adapter is not configured." } };
      }
      if (current.value.state === "triggered" || current.value.state === "draining") return { outcome: "success", value: { outcome: "triggered", requestOperationId: current.value.requestOperationId } };
      const work = this.#workState();
      if (work.outcome !== "success") return { outcome: "success", value: { outcome: "error", message: work.message } };
      let satisfied = false;
      if (current.value.target === "next_checkpoint") {
        const sequence = (this.#store.database.prepare("SELECT COALESCE(MAX(created_sequence), 0) AS value FROM runtime_checkpoints").get() as { value: number }).value;
        satisfied = sequence > current.value.checkpointBaseline && !work.value.active;
      } else satisfied = input.queueOutcome === "synchronized" && input.deliveryOutcome === "idle" && input.cycleOutcome === "idle" && !work.value.active && !work.value.queued;
      if (!satisfied) return { outcome: "success", value: { outcome: "armed", requestOperationId: current.value.requestOperationId } };
      const changed = this.#store.database.prepare("UPDATE runtime_host_shutdown SET state = 'triggered', version = version + 1, triggered_at = ? WHERE singleton = 1 AND state = 'armed'").run(input.now);
      if (changed.changes !== 1) return { outcome: "success", value: { outcome: "error", message: "Host shutdown request changed during evaluation." } };
      return { outcome: "success", value: { outcome: "triggered", requestOperationId: current.value.requestOperationId } };
    });
    return transaction.outcome === "success" ? transaction.value : { outcome: "error", message: transaction.message };
  }

  public transition(expected: HostShutdownState, next: HostShutdownState, at: UtcTimestamp, outcome?: string): StorageResult<HostShutdownRecord> {
    const allowed = expected === "triggered" && next === "draining" || expected === "draining" && (next === "poweroff_requested" || next === "failed") || expected === "poweroff_requested" && (next === "accepted" || next === "failed");
    if (!allowed || !timestamp(at) || outcome !== undefined && !text(outcome, 256) || ["accepted", "failed"].includes(next) !== (outcome !== undefined)) return { outcome: "invalid_record", message: "Host shutdown transition is invalid." };
    return this.#store.execute(() => {
      try {
        const terminal = ["accepted", "failed"].includes(next);
        const changed = this.#store.database.prepare("UPDATE runtime_host_shutdown SET state = ?, version = version + 1, terminal_at = CASE WHEN ? THEN ? ELSE terminal_at END, terminal_outcome = CASE WHEN ? THEN ? ELSE terminal_outcome END WHERE singleton = 1 AND state = ?").run(next, terminal ? 1 : 0, at, terminal ? 1 : 0, outcome ?? null, expected);
        if (changed.changes !== 1) return { outcome: "conflict", message: "Host shutdown transition no longer matches durable state." };
        return this.get();
      } catch { return { outcome: "storage_error", message: "Host shutdown transition could not be stored." }; }
    });
  }

  #workState(): StorageResult<{ readonly active: boolean; readonly queued: boolean }> {
    try {
      const task = this.#store.database.prepare("SELECT 1 AS value FROM runtime_tasks WHERE state = 'in_progress' LIMIT 1").get();
      const attempt = this.#store.database.prepare("SELECT 1 AS value FROM runtime_attempts WHERE state = 'running' LIMIT 1").get();
      const lease = this.#store.database.prepare("SELECT 1 AS value FROM runtime_leases WHERE state IN ('active', 'uncertain') LIMIT 1").get();
      const queued = this.#store.database.prepare("SELECT 1 AS value FROM runtime_tasks t JOIN runtime_task_selection s ON s.task_id = t.id WHERE t.state = 'ready' AND s.queue_order IS NOT NULL LIMIT 1").get();
      return { outcome: "success", value: { active: task !== undefined || attempt !== undefined || lease !== undefined, queued: queued !== undefined } };
    } catch { return { outcome: "storage_error", message: "Host shutdown safety state could not be read." }; }
  }
}

export class LinuxSystemctlPowerOffAdapter implements HostPowerOffAdapter {
  readonly #spawn: PowerOffSpawn;
  readonly #timeoutMs: number;
  public constructor(options: { readonly spawn?: PowerOffSpawn; readonly timeoutMs?: number } = {}) {
    const timeout = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) throw new RangeError("Host power-off acceptance timeout is invalid.");
    this.#timeoutMs = timeout;
    this.#spawn = options.spawn ?? ((executable, args, spawnOptions) => spawn(executable, [...args], spawnOptions));
  }
  public powerOff(): Promise<{ readonly outcome: "accepted" | "rejected"; readonly message: string }> {
    return new Promise((resolve) => {
      let settled = false;
      let child: SpawnedPowerOffProcess | undefined;
      const finish = (value: { readonly outcome: "accepted" | "rejected"; readonly message: string }): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => { try { child?.kill("SIGTERM"); } catch { /* bounded rejection */ } finish({ outcome: "rejected", message: "Host power-off command acceptance timed out." }); }, this.#timeoutMs);
      try {
        child = this.#spawn("/usr/bin/systemctl", ["poweroff", "--no-wall"], { shell: false, stdio: ["ignore", "ignore", "ignore"], env: { PATH: "/usr/bin:/bin", LANG: "C" } });
        child.once("error", () => finish({ outcome: "rejected", message: "Host power-off command could not be started." }));
        child.once("close", (code, signal) => finish(code === 0 && signal === null ? { outcome: "accepted", message: "Host power-off command was accepted." } : { outcome: "rejected", message: "Host power-off command was rejected." }));
      } catch { finish({ outcome: "rejected", message: "Host power-off command could not be started." }); }
    });
  }
}

export class SqliteHeadlessHostShutdownPort implements HeadlessHostShutdownPort {
  readonly #repository: HostShutdownRepository;
  readonly #databasePath: string;
  readonly #adapter: HostPowerOffAdapter | undefined;
  readonly #now: () => UtcTimestamp;
  #requestOperationId: string | undefined;
  public constructor(store: RuntimeSqliteStore, databasePath: string, adapter: HostPowerOffAdapter | undefined, now: () => UtcTimestamp = () => new Date().toISOString() as UtcTimestamp) { this.#repository = new HostShutdownRepository(store); this.#databasePath = databasePath; this.#adapter = adapter; this.#now = now; }
  public evaluate(input: Omit<Parameters<HostShutdownRepository["evaluate"]>[0], "now" | "adapterConfigured">): HeadlessHostShutdownEvaluation {
    const value = this.#repository.evaluate({ ...input, now: this.#now(), adapterConfigured: this.#adapter !== undefined });
    if (value.outcome === "triggered") this.#requestOperationId = value.requestOperationId;
    return value;
  }
  public beginDrain(): { readonly outcome: "success" } | { readonly outcome: "error"; readonly message: string } {
    const current = this.#repository.get();
    if (current.outcome === "success" && current.value.state === "draining") return { outcome: "success" };
    const value = this.#repository.transition("triggered", "draining", this.#now());
    return value.outcome === "success" ? { outcome: "success" } : { outcome: "error", message: value.message };
  }
  public powerOffRequested(): { readonly outcome: "success" } | { readonly outcome: "error"; readonly message: string } {
    const current = this.#repository.get();
    if (current.outcome === "success" && current.value.state === "poweroff_requested") return { outcome: "success" };
    const value = this.#repository.transition("draining", "poweroff_requested", this.#now());
    return value.outcome === "success" ? { outcome: "success" } : { outcome: "error", message: value.message };
  }
  public failBeforeClose(reason: string): void {
    const current = this.#repository.get();
    if (current.outcome === "success" && current.value.state === "draining") this.#repository.transition("draining", "failed", this.#now(), bounded(reason));
  }
  public async powerOffAfterClose(): Promise<{ readonly outcome: "accepted" | "failed"; readonly message: string }> {
    if (this.#adapter === undefined || this.#requestOperationId === undefined) return { outcome: "failed", message: "Host power-off request is unavailable." };
    const result = await this.#adapter.powerOff();
    let store: RuntimeSqliteStore | undefined;
    try {
      store = RuntimeSqliteStore.open({ filename: this.#databasePath, busyTimeoutMs: 1_000 });
      const repository = new HostShutdownRepository(store);
      repository.transition("poweroff_requested", result.outcome === "accepted" ? "accepted" : "failed", this.#now(), result.outcome === "accepted" ? "poweroff_command_accepted" : "poweroff_command_rejected");
    } catch { /* poweroff_requested is the fail-closed durable fallback */ }
    finally { try { store?.close(); } catch { /* preserve adapter outcome */ } }
    return result.outcome === "accepted" ? { outcome: "accepted", message: result.message } : { outcome: "failed", message: result.message };
  }
}
