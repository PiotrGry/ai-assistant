import type { HeadlessControlPort, HeadlessServiceEvent } from "./headless-service.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import type { UtcTimestamp } from "./task-domain.js";
import { HostShutdownRepository, type HostShutdownState, type HostShutdownTarget } from "./host-shutdown.js";
import { diagnosticContext } from "./diagnostic-context.js";

export const ORCHESTRATOR_CONTROL_SCHEMA_VERSION = 1 as const;
export type OrchestratorRequestedMode = "running" | "paused";
export type OrchestratorObservedState = "starting" | "running" | "paused" | "stopping" | "stopped" | "error";
export type OrchestratorControlAction = "pause" | "resume";

export interface OrchestratorControlRecord {
  readonly schemaVersion: typeof ORCHESTRATOR_CONTROL_SCHEMA_VERSION;
  readonly requestedMode: OrchestratorRequestedMode;
  readonly requestedAt: UtcTimestamp;
  readonly requestedBy: string;
  readonly reason: string;
  readonly version: number;
  readonly observedState: OrchestratorObservedState;
  readonly heartbeatAt?: UtcTimestamp;
  readonly lastQueueOutcome?: string;
  readonly lastDeliveryOutcome?: string;
  readonly lastCycleOutcome?: string;
}

export interface OrchestratorControlRequest {
  readonly operationId: string;
  readonly action: OrchestratorControlAction;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: UtcTimestamp;
}

export type OrchestratorControlRequestResult =
  | { readonly outcome: "applied" | "replayed"; readonly record: OrchestratorControlRecord; readonly operationId: string; readonly message: string }
  | { readonly outcome: "conflict" | "invalid_request" | "storage_error"; readonly operationId: string; readonly message: string };

export interface OrchestratorEntitySummary { readonly id: string; readonly state: string; readonly issueNumber?: number; readonly ordinal?: number; readonly result?: string; readonly diagnostic?: unknown; readonly queueOrder?: number; readonly expiresAt?: UtcTimestamp; }
export interface OrchestratorHostShutdownSummary { readonly requestOperationId: string; readonly target: HostShutdownTarget; readonly state: HostShutdownState; readonly requestedAt: UtcTimestamp; readonly version: number; readonly triggeredAt?: UtcTimestamp; readonly terminalAt?: UtcTimestamp; readonly terminalOutcome?: string; }
export interface OrchestratorStatusSnapshot {
  readonly schemaVersion: typeof ORCHESTRATOR_CONTROL_SCHEMA_VERSION;
  readonly requestedMode: OrchestratorRequestedMode;
  readonly observedState: OrchestratorObservedState;
  readonly version: number;
  readonly heartbeatAt?: UtcTimestamp;
  readonly heartbeatStale: boolean;
  readonly lastQueueOutcome?: string;
  readonly lastDeliveryOutcome?: string;
  readonly lastCycleOutcome?: string;
  readonly activeTask?: OrchestratorEntitySummary;
  readonly activeAttempt?: OrchestratorEntitySummary;
  readonly activeLease?: OrchestratorEntitySummary;
  readonly nextQueuedTask?: OrchestratorEntitySummary;
  readonly activeRelease?: OrchestratorEntitySummary;
  readonly hostShutdown?: OrchestratorHostShutdownSummary;
  readonly diagnostics?: readonly OrchestratorDiagnostic[];
  readonly attentionRequired?: { readonly task: OrchestratorEntitySummary; readonly attempt?: OrchestratorEntitySummary; readonly reason: string; readonly nextAction: "inspect_blocker" };
}

export interface OrchestratorDiagnostic { readonly sequence: number; readonly recordedAt: string; readonly event: string; readonly outcome: string; readonly reason?: string; readonly details?: unknown; }
export interface OrchestratorDiagnosticChunk { readonly sequence: number; readonly offset: number; readonly totalCharacters: number; readonly text: string; readonly nextOffset?: number; }

function canonicalTimestamp(value: unknown): value is UtcTimestamp { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function boundedText(value: unknown, maximum: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value); }
function safeOutcome(value: unknown): string | undefined { return boundedText(value, 128) ? value : undefined; }
function parseRecord(row: Record<string, unknown>): StorageResult<OrchestratorControlRecord> {
  if (row.requested_mode !== "running" && row.requested_mode !== "paused") return { outcome: "invalid_record", message: "Stored orchestrator requested mode is invalid." };
  if (!["starting", "running", "paused", "stopping", "stopped", "error"].includes(String(row.observed_state)) || !canonicalTimestamp(row.requested_at) || (row.heartbeat_at !== null && !canonicalTimestamp(row.heartbeat_at)) || !boundedText(row.requested_by, 128) || !boundedText(row.request_reason, 256) || typeof row.request_version !== "number" || !Number.isSafeInteger(row.request_version) || row.request_version <= 0) return { outcome: "invalid_record", message: "Stored orchestrator control state is invalid." };
  const optional = [row.last_queue_outcome, row.last_delivery_outcome, row.last_cycle_outcome];
  if (optional.some((value) => value !== null && safeOutcome(value) === undefined)) return { outcome: "invalid_record", message: "Stored orchestrator outcome is invalid." };
  return { outcome: "success", value: Object.freeze({ schemaVersion: 1, requestedMode: row.requested_mode, requestedAt: row.requested_at, requestedBy: row.requested_by, reason: row.request_reason, version: row.request_version, observedState: row.observed_state as OrchestratorObservedState, ...(row.heartbeat_at === null ? {} : { heartbeatAt: row.heartbeat_at as UtcTimestamp }), ...(row.last_queue_outcome === null ? {} : { lastQueueOutcome: row.last_queue_outcome as string }), ...(row.last_delivery_outcome === null ? {} : { lastDeliveryOutcome: row.last_delivery_outcome as string }), ...(row.last_cycle_outcome === null ? {} : { lastCycleOutcome: row.last_cycle_outcome as string }) }) };
}
function invalidRequest(input: OrchestratorControlRequest): string | undefined {
  if (!boundedText(input.operationId, 128) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.operationId)) return "Control operation ID is invalid.";
  if (input.action !== "pause" && input.action !== "resume") return "Control action is invalid.";
  if (!boundedText(input.reason, 256) || !boundedText(input.requestedBy, 128) || !canonicalTimestamp(input.requestedAt)) return "Control request metadata is invalid.";
  return undefined;
}
function summary(row: Record<string, unknown> | undefined, options: { issue?: boolean; ordinal?: boolean; queue?: boolean; result?: boolean; expiry?: boolean } = {}): OrchestratorEntitySummary | undefined {
  if (row === undefined || typeof row.id !== "string" || typeof row.state !== "string") return undefined;
  return Object.freeze({ id: row.id, state: row.state, ...(options.issue && typeof row.issue_number === "number" ? { issueNumber: row.issue_number } : {}), ...(options.ordinal && typeof row.ordinal === "number" ? { ordinal: row.ordinal } : {}), ...(options.result && typeof row.result === "string" ? { result: row.result } : {}), ...(options.queue && typeof row.queue_order === "number" ? { queueOrder: row.queue_order } : {}), ...(options.expiry && canonicalTimestamp(row.expires_at) ? { expiresAt: row.expires_at } : {}) });
}

export class OrchestratorControlRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public recordDiagnostic(event: HeadlessServiceEvent, at: UtcTimestamp): StorageResult<number> {
    if (!canonicalTimestamp(at)) return { outcome: "invalid_record", message: "Diagnostic timestamp is invalid." };
    return this.#store.execute(() => {
      const details = event.details;
      const taskId = details !== null && typeof details === "object" && "taskId" in details ? details.taskId : undefined;
      const history = typeof taskId === "string" ? this.#store.attempts.listByTask(taskId) : undefined;
      const workerFailures = history?.outcome === "success" ? history.value.slice(-3).flatMap((attempt) => attempt.state === "terminal" ? [{ attemptId: attempt.id, ordinal: attempt.ordinal, result: attempt.result, diagnostic: attempt.diagnostic }] : []) : [];
      const enriched = workerFailures.length > 0 ? { ...event, details: { ...details as object, workerFailures } } : event;
      const result = this.#store.database.prepare("INSERT INTO runtime_orchestrator_diagnostics (recorded_at,event,outcome,diagnostic_json) VALUES (?,?,?,?)").run(at, event.event, event.outcome, JSON.stringify(diagnosticContext(enriched)));
      return { outcome: "success", value: Number(result.lastInsertRowid) };
    });
  }

  public diagnostic(sequence: number, offset = 0, length = 6_000): StorageResult<OrchestratorDiagnosticChunk> {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 8_000) return { outcome: "invalid_record", message: "Diagnostic chunk bounds are invalid." };
    return this.#store.execute(() => {
      const row = this.#store.database.prepare("SELECT diagnostic_json FROM runtime_orchestrator_diagnostics WHERE sequence = ?").get(sequence) as { diagnostic_json: string } | undefined;
      if (row === undefined) return { outcome: "not_found", message: "Diagnostic record was not found." };
      const text = JSON.stringify(diagnosticContext(JSON.parse(row.diagnostic_json)));
      const next = Math.min(text.length, offset + length);
      return { outcome: "success", value: { sequence, offset, totalCharacters: text.length, text: text.slice(offset, next), ...(next < text.length ? { nextOffset: next } : {}) } };
    });
  }

  public get(): StorageResult<OrchestratorControlRecord> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_orchestrator_control WHERE singleton = 1").get() as Record<string, unknown> | undefined;
        return row === undefined ? { outcome: "not_found", message: "Orchestrator control state has not been initialized." } : parseRecord(row);
      } catch { return { outcome: "storage_error", message: "Orchestrator control state could not be read." }; }
    });
  }

  public request(input: OrchestratorControlRequest): OrchestratorControlRequestResult {
    const invalid = invalidRequest(input);
    if (invalid !== undefined) return { outcome: "invalid_request", operationId: input.operationId, message: invalid };
    const transaction = this.#store.transaction((): StorageResult<OrchestratorControlRequestResult> => {
      try {
        const command = this.#store.database.prepare("SELECT * FROM runtime_orchestrator_control_commands WHERE operation_id = ?").get(input.operationId) as Record<string, unknown> | undefined;
        if (command !== undefined) {
          if (command.action !== input.action || command.reason !== input.reason || command.requested_by !== input.requestedBy) return { outcome: "success", value: { outcome: "conflict", operationId: input.operationId, message: "Control operation ID conflicts with a different request." } };
          const current = this.get();
          return { outcome: "success", value: current.outcome === "success" ? { outcome: "replayed", record: current.value, operationId: input.operationId, message: "Replayed the durable control request." } : { outcome: "storage_error", operationId: input.operationId, message: current.message } };
        }
        const current = this.get();
        if (current.outcome !== "success" && current.outcome !== "not_found") return { outcome: "success", value: { outcome: "storage_error", operationId: input.operationId, message: current.message } };
        const version = current.outcome === "success" ? current.value.version + 1 : 1;
        const mode = input.action === "pause" ? "paused" : "running";
        if (current.outcome === "success") this.#store.database.prepare("UPDATE runtime_orchestrator_control SET requested_mode = ?, requested_at = ?, requested_by = ?, request_reason = ?, request_version = ? WHERE singleton = 1").run(mode, input.requestedAt, input.requestedBy, input.reason, version);
        else this.#store.database.prepare("INSERT INTO runtime_orchestrator_control (singleton, requested_mode, requested_at, requested_by, request_reason, request_version, observed_state, heartbeat_at, last_queue_outcome, last_delivery_outcome, last_cycle_outcome) VALUES (1, ?, ?, ?, ?, ?, 'stopped', NULL, NULL, NULL, NULL)").run(mode, input.requestedAt, input.requestedBy, input.reason, version);
        this.#store.database.prepare("INSERT INTO runtime_orchestrator_control_commands (operation_id, action, reason, requested_by, requested_at, resulting_version) VALUES (?, ?, ?, ?, ?, ?)").run(input.operationId, input.action, input.reason, input.requestedBy, input.requestedAt, version);
        const saved = this.get();
        return { outcome: "success", value: saved.outcome === "success" ? { outcome: "applied", record: saved.value, operationId: input.operationId, message: "Durable orchestrator control request applied." } : { outcome: "storage_error", operationId: input.operationId, message: saved.message } };
      } catch { return { outcome: "storage_error", message: "Orchestrator control request could not be stored." }; }
    });
    return transaction.outcome === "success" ? transaction.value : { outcome: "storage_error", operationId: input.operationId, message: transaction.message };
  }

  public heartbeat(state: OrchestratorObservedState, at: UtcTimestamp, outcomes: { readonly queue?: string; readonly delivery?: string; readonly cycle?: string } = {}): StorageResult<OrchestratorControlRecord> {
    if (!["starting", "running", "paused", "stopping", "stopped", "error"].includes(state) || !canonicalTimestamp(at) || Object.values(outcomes).some((value) => value !== undefined && safeOutcome(value) === undefined)) return { outcome: "invalid_record", message: "Orchestrator heartbeat is invalid." };
    return this.#store.execute(() => {
      try {
        const current = this.get();
        if (current.outcome === "not_found") this.#store.database.prepare("INSERT INTO runtime_orchestrator_control (singleton, requested_mode, requested_at, requested_by, request_reason, request_version, observed_state, heartbeat_at, last_queue_outcome, last_delivery_outcome, last_cycle_outcome) VALUES (1, 'running', ?, 'service-bootstrap', 'service startup', 1, ?, ?, ?, ?, ?)").run(at, state, at, outcomes.queue ?? null, outcomes.delivery ?? null, outcomes.cycle ?? null);
        else if (current.outcome === "success") this.#store.database.prepare("UPDATE runtime_orchestrator_control SET observed_state = ?, heartbeat_at = ?, last_queue_outcome = COALESCE(?, last_queue_outcome), last_delivery_outcome = COALESCE(?, last_delivery_outcome), last_cycle_outcome = COALESCE(?, last_cycle_outcome) WHERE singleton = 1").run(state, at, outcomes.queue ?? null, outcomes.delivery ?? null, outcomes.cycle ?? null);
        else return current;
        return this.get();
      } catch { return { outcome: "storage_error", message: "Orchestrator heartbeat could not be stored." }; }
    });
  }

  public status(now: UtcTimestamp, staleAfterMs: number): StorageResult<OrchestratorStatusSnapshot> {
    if (!canonicalTimestamp(now) || !Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0 || staleAfterMs > 3_600_000) return { outcome: "invalid_record", message: "Orchestrator status bounds are invalid." };
    return this.#store.execute(() => {
      const control = this.get();
      if (control.outcome !== "success" && control.outcome !== "not_found") return control;
      const shutdown = new HostShutdownRepository(this.#store).get();
      if (shutdown.outcome !== "success" && shutdown.outcome !== "not_found") return shutdown;
      try {
        const activeTask = this.#store.database.prepare("SELECT id, state, github_issue_number AS issue_number FROM runtime_tasks WHERE state = 'in_progress' ORDER BY updated_at, id LIMIT 1").get() as Record<string, unknown> | undefined;
        const activeAttempt = activeTask === undefined || typeof activeTask.id !== "string" ? undefined : this.#store.database.prepare("SELECT id, state, ordinal, result FROM runtime_attempts WHERE task_id = ? ORDER BY ordinal DESC LIMIT 1").get(activeTask.id) as Record<string, unknown> | undefined;
        const lease = this.#store.database.prepare("SELECT id, state, expires_at FROM runtime_leases WHERE state = 'active' ORDER BY acquired_at, id LIMIT 1").get() as Record<string, unknown> | undefined;
        const next = this.#store.database.prepare("SELECT t.id, t.state, t.github_issue_number AS issue_number, s.queue_order FROM runtime_tasks t JOIN runtime_task_selection s ON s.task_id = t.id WHERE t.state = 'ready' AND s.queue_order IS NOT NULL ORDER BY s.queue_order, t.id LIMIT 1").get() as Record<string, unknown> | undefined;
        const release = this.#store.database.prepare("SELECT id, state FROM runtime_releases WHERE state NOT IN ('deployed', 'rolled_back') ORDER BY updated_at, id LIMIT 1").get() as Record<string, unknown> | undefined;
        const record = control.outcome === "success" ? control.value : undefined;
        const heartbeatStale = record?.heartbeatAt === undefined || Date.parse(now) - Date.parse(record.heartbeatAt) > staleAfterMs;
        const activeTaskSummary = summary(activeTask, { issue: true });
        const activeAttemptSummary = summary(activeAttempt, { ordinal: true, result: true });
        const activeLeaseSummary = summary(lease, { expiry: true });
        const nextTaskSummary = summary(next, { issue: true, queue: true });
        const activeReleaseSummary = summary(release);
        const hostShutdown = shutdown.outcome === "success" ? { requestOperationId: shutdown.value.requestOperationId, target: shutdown.value.target, state: shutdown.value.state, requestedAt: shutdown.value.requestedAt, version: shutdown.value.version, ...(shutdown.value.triggeredAt === undefined ? {} : { triggeredAt: shutdown.value.triggeredAt }), ...(shutdown.value.terminalAt === undefined ? {} : { terminalAt: shutdown.value.terminalAt }), ...(shutdown.value.terminalOutcome === undefined ? {} : { terminalOutcome: shutdown.value.terminalOutcome }) } : undefined;
        const snapshot: OrchestratorStatusSnapshot = { schemaVersion: 1, requestedMode: record?.requestedMode ?? "running", observedState: record?.observedState ?? "stopped", version: record?.version ?? 0, ...(record?.heartbeatAt === undefined ? {} : { heartbeatAt: record.heartbeatAt }), heartbeatStale, ...(record?.lastQueueOutcome === undefined ? {} : { lastQueueOutcome: record.lastQueueOutcome }), ...(record?.lastDeliveryOutcome === undefined ? {} : { lastDeliveryOutcome: record.lastDeliveryOutcome }), ...(record?.lastCycleOutcome === undefined ? {} : { lastCycleOutcome: record.lastCycleOutcome }), ...(activeTaskSummary === undefined ? {} : { activeTask: activeTaskSummary }), ...(activeAttemptSummary === undefined ? {} : { activeAttempt: activeAttemptSummary }), ...(activeLeaseSummary === undefined ? {} : { activeLease: activeLeaseSummary }), ...(nextTaskSummary === undefined ? {} : { nextQueuedTask: nextTaskSummary }), ...(activeReleaseSummary === undefined ? {} : { activeRelease: activeReleaseSummary }), ...(hostShutdown === undefined ? {} : { hostShutdown }) };
        const rows = this.#store.database.prepare("SELECT * FROM runtime_orchestrator_diagnostics WHERE sequence IN (SELECT MAX(sequence) FROM runtime_orchestrator_diagnostics GROUP BY event) OR sequence = (SELECT MAX(sequence) FROM runtime_orchestrator_diagnostics WHERE event = 'cycle' AND outcome <> 'idle') ORDER BY sequence DESC LIMIT 12").all() as Array<{ sequence: number; recorded_at: string; diagnostic_json: string }>;
        const diagnostics = rows.map((row): OrchestratorDiagnostic => {
          const parsed = diagnosticContext(JSON.parse(row.diagnostic_json)) as HeadlessServiceEvent;
          return { sequence: row.sequence, recordedAt: row.recorded_at, event: parsed.event, outcome: parsed.outcome, ...(parsed.reason === undefined ? {} : { reason: parsed.reason }), ...(parsed.details === undefined ? {} : { details: parsed.details }) };
        });
        const attention = this.#store.database.prepare("SELECT t.id, t.state, t.github_issue_number AS issue_number, t.blocking_reason, s.queue_order FROM runtime_tasks t JOIN runtime_task_selection s ON s.task_id = t.id WHERE t.state IN ('blocked','failed') AND s.queue_order IS NOT NULL ORDER BY s.queue_order, t.updated_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
        const attentionTask = summary(attention, { issue: true, queue: true });
        const attentionAttempt = attentionTask === undefined ? undefined : summary(this.#store.database.prepare("SELECT id, state, ordinal, result FROM runtime_attempts WHERE task_id = ? ORDER BY ordinal DESC LIMIT 1").get(attentionTask.id) as Record<string, unknown> | undefined, { ordinal: true, result: true });
        const attemptEvidence = attentionTask === undefined ? undefined : this.#store.attempts.listByTask(attentionTask.id);
        const latestAttempt = attemptEvidence?.outcome === "success" ? attemptEvidence.value.at(-1) : undefined;
        const latestDiagnostic = latestAttempt?.state === "terminal" ? latestAttempt.diagnostic : undefined;
        if (attentionAttempt !== undefined && latestDiagnostic !== undefined) Object.assign(attentionAttempt, { diagnostic: diagnosticContext(latestDiagnostic) });
        const attentionRequired = attentionTask === undefined ? undefined : { task: attentionTask, ...(attentionAttempt === undefined ? {} : { attempt: attentionAttempt }), reason: String(diagnosticContext(attention?.blocking_reason ?? "Task requires reconciliation.")), nextAction: "inspect_blocker" as const };
        return { outcome: "success", value: Object.freeze({ ...snapshot, diagnostics, ...(attentionRequired === undefined ? {} : { attentionRequired }) }) };
      } catch { return { outcome: "storage_error", message: "Orchestrator status snapshot could not be read." }; }
    });
  }
}

export class SqliteHeadlessControlPort implements HeadlessControlPort {
  readonly #repository: OrchestratorControlRepository;
  readonly #now: () => UtcTimestamp;
  public constructor(store: RuntimeSqliteStore, now: () => UtcTimestamp = () => new Date().toISOString() as UtcTimestamp) { this.#repository = new OrchestratorControlRepository(store); this.#now = now; }
  public read(): { readonly outcome: "success"; readonly mode: OrchestratorRequestedMode } | { readonly outcome: "error"; readonly message: string } {
    const value = this.#repository.get();
    if (value.outcome === "not_found") return { outcome: "success", mode: "running" };
    return value.outcome === "success" ? { outcome: "success", mode: value.value.requestedMode } : { outcome: "error", message: value.message };
  }
  public observe(event: HeadlessServiceEvent): void {
    this.#repository.recordDiagnostic(event, this.#now());
    const observed: OrchestratorObservedState = event.event === "starting" ? "starting" : event.event === "stopping" || event.event === "host_shutdown" ? "stopping" : event.event === "stopped" ? "stopped" : event.event === "cycle_error" ? "error" : event.event === "control" && event.outcome === "paused" ? "paused" : "running";
    const outcomes = event.event === "queue" ? { queue: event.outcome } : event.event === "delivery" ? { delivery: event.outcome } : event.event === "cycle" || event.event === "cycle_error" ? { cycle: event.outcome } : {};
    this.#repository.heartbeat(observed, this.#now(), outcomes);
  }
  public paused(): void { this.#repository.heartbeat("paused", this.#now()); }
}
