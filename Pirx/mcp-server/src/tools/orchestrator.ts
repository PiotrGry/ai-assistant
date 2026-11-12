import type { RuntimeBindingCheck } from "../runtime-binding.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { existsSync } from "node:fs";
import * as z from "zod/v4";

import {
  ExecutionObservabilityQueryService,
  OrchestratorControlRepository,
  HostShutdownRepository,
  RuntimeSqliteStore,
  RuntimeStorageError,
  unblockEscalatedTask,
  type ExecutionReportQuery,
  type ExecutionReportResult,
  type OrchestratorDiagnosticChunk,
  type HostShutdownCommand,
  type HostShutdownCommandResult,
  type OrchestratorControlRequest,
  type OrchestratorControlRequestResult,
  type OrchestratorStatusSnapshot,
  type OperatorDecisionAcceptance,
  type OperatorDecisionInput,
  type OperatorQuestionRecord,
  type OperatorUnblockAcceptance,
  type OperatorUnblockInput,
  type WorkIntakeInput,
  type WorkIntakeRecord,
  type StorageResult,
  type UtcTimestamp,
} from "@pirx/orchestrator";

import { verifyHostAuthorization } from "../authorization.js";

export interface OrchestratorControlToolPort {
  status(now: UtcTimestamp, staleAfterMs: number): StorageResult<OrchestratorStatusSnapshot>;
  request(input: OrchestratorControlRequest): OrchestratorControlRequestResult;
  shutdown(input: HostShutdownCommand): HostShutdownCommandResult;
  diagnostic?(sequence: number, offset: number, length: number): StorageResult<OrchestratorDiagnosticChunk>;
  operatorQuestions?(): StorageResult<readonly OperatorQuestionRecord[]>;
  answerOperatorQuestion?(input: OperatorDecisionInput): StorageResult<OperatorDecisionAcceptance>;
  unblockTask?(input: OperatorUnblockInput): StorageResult<OperatorUnblockAcceptance>;
  submitWork?(input: WorkIntakeInput): StorageResult<WorkIntakeRecord>;
  workStatus?(intakeId: string): StorageResult<WorkIntakeRecord>;
}

export interface ExecutionObservabilityToolPort {
  report(input: ExecutionReportQuery): ExecutionReportResult;
}

export class SqliteExecutionObservabilityToolPort implements ExecutionObservabilityToolPort {
  readonly #filename: string;
  public constructor(filename: string, private readonly checkBinding: RuntimeBindingCheck = () => {}) { this.#filename = filename; }
  public report(input: ExecutionReportQuery): ExecutionReportResult {
    if (!existsSync(this.#filename)) return { outcome: "storage_error", message: "Orchestrator runtime database does not exist. Start the configured orchestrator service first." };
    let store: RuntimeSqliteStore | undefined;
    try {
      this.checkBinding();
      store = RuntimeSqliteStore.open({ filename: this.#filename, busyTimeoutMs: 1_000, mode: "read_only" });
      return new ExecutionObservabilityQueryService(store).query(input);
    } catch (error: unknown) {
      return { outcome: "storage_error", message: error instanceof RuntimeStorageError ? error.message : "Orchestrator runtime database is unavailable." };
    } finally {
      try { store?.close(); } catch { /* preserve bounded query result */ }
    }
  }
}

export class SqliteOrchestratorControlToolPort implements OrchestratorControlToolPort {
  readonly #filename: string;
  public constructor(filename: string, private readonly checkBinding: RuntimeBindingCheck = () => {}) { this.#filename = filename; }
  public status(now: UtcTimestamp, staleAfterMs: number): StorageResult<OrchestratorStatusSnapshot> {
    const result = this.#withStore((_store, repository) => repository.status(now, staleAfterMs), "read_only");
    if (result.outcome === "storage_error") {
      console.error(JSON.stringify({ event: "orchestrator_status_read_failed", code: result.outcome, reason: result.message }));
    }
    return result;
  }
  public diagnostic(sequence: number, offset: number, length: number): StorageResult<OrchestratorDiagnosticChunk> { return this.#withStore((_store, repository) => repository.diagnostic(sequence, offset, length), "read_only"); }
  public operatorQuestions(): StorageResult<readonly OperatorQuestionRecord[]> { return this.#withStore((store) => store.operatorDecisions.listOpen(), "read_only"); }
  public answerOperatorQuestion(input: OperatorDecisionInput): StorageResult<OperatorDecisionAcceptance> { return this.#withStore((store) => store.operatorDecisions.answer(input)); }
  public unblockTask(input: OperatorUnblockInput): StorageResult<OperatorUnblockAcceptance> { return this.#withStore((store) => unblockEscalatedTask(store, input)); }
  public submitWork(input: WorkIntakeInput): StorageResult<WorkIntakeRecord> { return this.#withStore((store) => store.workIntakes.create(input)); }
  public workStatus(intakeId: string): StorageResult<WorkIntakeRecord> { return this.#withStore((store) => store.workIntakes.get(intakeId), "read_only"); }
  public request(input: OrchestratorControlRequest): OrchestratorControlRequestResult {
    const value = this.#withStore((_store, repository) => ({ outcome: "success" as const, value: repository.request(input) }));
    return value.outcome === "success" ? value.value : { outcome: "storage_error", operationId: input.operationId, message: value.message };
  }
  public shutdown(input: HostShutdownCommand): HostShutdownCommandResult {
    const value = this.#withStore((store) => ({ outcome: "success" as const, value: new HostShutdownRepository(store).command(input) }));
    return value.outcome === "success" ? value.value : { outcome: "storage_error", operationId: input.operationId, message: value.message };
  }
  #withStore<T>(operation: (store: RuntimeSqliteStore, repository: OrchestratorControlRepository) => StorageResult<T>, mode: "read_only" | "existing" = "existing"): StorageResult<T> {
    if (!existsSync(this.#filename)) return { outcome: "storage_error", message: "Orchestrator runtime database does not exist. Start the configured orchestrator service first." };
    let store: RuntimeSqliteStore | undefined;
    try { this.checkBinding(); store = RuntimeSqliteStore.open({ filename: this.#filename, busyTimeoutMs: 1_000, mode }); return operation(store, new OrchestratorControlRepository(store)); }
    catch (error: unknown) { return { outcome: "storage_error", message: error instanceof RuntimeStorageError ? error.message : "Orchestrator runtime database is unavailable." }; }
    finally { try { store?.close(); } catch { /* preserve bounded operation result */ } }
  }
}

const entitySchema = z.object({ diagnostic: z.unknown().optional(), id: z.string(), state: z.string(), issueNumber: z.number().int().positive().optional(), ordinal: z.number().int().positive().optional(), result: z.string().optional(), queueOrder: z.number().int().positive().optional(), expiresAt: z.string().optional() });
const hostShutdownSchema = z.object({ requestOperationId: z.string(), target: z.enum(["queue_drained", "next_checkpoint"]), state: z.enum(["armed", "triggered", "draining", "poweroff_requested", "accepted", "cancelled", "failed"]), requestedAt: z.string(), version: z.number().int().positive(), triggeredAt: z.string().optional(), terminalAt: z.string().optional(), terminalOutcome: z.string().optional() });
const snapshotSchema = z.object({
  attentionRequired: z.object({ task: entitySchema, attempt: entitySchema.optional(), reason: z.string(), nextAction: z.literal("inspect_blocker") }).optional(),
  diagnostics: z.array(z.object({ sequence: z.number().int().positive(), recordedAt: z.string(), event: z.string(), outcome: z.string(), reason: z.string().optional(), details: z.unknown().optional() })).optional(),
  schemaVersion: z.literal(1), requestedMode: z.enum(["running", "paused"]), observedState: z.enum(["starting", "running", "paused", "stopping", "stopped", "error"]), version: z.number().int().nonnegative(), heartbeatAt: z.string().optional(), heartbeatStale: z.boolean(), lastPersistedObservationIncomplete: z.boolean().optional(), lastQueueOutcome: z.string().optional(), lastDeliveryOutcome: z.string().optional(), lastCycleOutcome: z.string().optional(), activeTask: entitySchema.optional(), activeAttempt: entitySchema.optional(), activeLease: entitySchema.optional(), nextQueuedTask: entitySchema.optional(), activeRelease: entitySchema.optional(), hostShutdown: hostShutdownSchema.optional(),
});
const configurationSummarySchema = z.object({
  source: z.enum(["explicit_profile", "default_profile", "database_override"]),
  serviceManaged: z.boolean(),
});
const statusOutputSchema = z.union([
  z.object({ outcome: z.literal("success"), configured: z.literal(true), configuration: configurationSummarySchema.optional(), snapshot: snapshotSchema }),
  z.object({ outcome: z.enum(["unconfigured", "unavailable"]), configured: z.boolean(), configuration: configurationSummarySchema.optional(), configurationCode: z.string().optional(), message: z.string() }),
]);
const controlOutputSchema = z.union([
  z.object({ outcome: z.enum(["applied", "replayed"]), operationId: z.string(), requestedMode: z.enum(["running", "paused"]), version: z.number().int().positive(), message: z.string() }),
  z.object({ outcome: z.enum(["authorization_required", "unconfigured", "conflict", "invalid_request", "unavailable"]), operationId: z.string(), message: z.string() }),
]);
const operationIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const operatorQuestionSchema = z.object({ schemaVersion: z.literal(1), id: z.string(), taskId: z.string(), sourceAttemptId: z.string(), checkpointId: z.string(), prompt: z.string(), state: z.enum(["open", "answered", "expired", "cancelled"]), openedAt: z.string(), updatedAt: z.string(), expiresAt: z.string().optional(), version: z.number().int().positive() });
const workIntakeSchema = z.object({ schemaVersion: z.literal(1), id: z.string(), operationId: z.string(), repository: z.string(), issueNumber: z.number().int().positive(), goal: z.string(), acceptanceCriteria: z.array(z.string()), priority: z.enum(["P0", "P1", "P2", "P3"]), risk: z.enum(["Low", "Medium", "High", "Prod-sensitive"]), area: z.string(), workType: z.enum(["Task", "Bug", "Experiment"]), queueOrder: z.number().int().positive(), state: z.enum(["accepted", "linking", "linked", "rejected", "uncertain"]), issueNodeId: z.string().optional(), taskId: z.string().optional(), acceptedAt: z.string(), updatedAt: z.string(), version: z.number().int().positive(), lastError: z.string().optional(), contentHash: z.string() });
const shutdownInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("arm"), operationId: operationIdSchema, target: z.enum(["queue_drained", "next_checkpoint"]), reason: z.string().trim().min(1).max(256) }).strict(),
  z.object({ action: z.literal("cancel"), operationId: operationIdSchema, requestOperationId: operationIdSchema, reason: z.string().trim().min(1).max(256) }).strict(),
]);
const shutdownOutputSchema = z.union([
  z.object({ outcome: z.enum(["applied", "replayed"]), operationId: z.string(), request: hostShutdownSchema, message: z.string() }),
  z.object({ outcome: z.enum(["authorization_required", "unconfigured", "conflict", "invalid_request", "not_found", "not_cancellable", "unavailable"]), operationId: z.string(), message: z.string() }),
]);
const reportInputSchema = z.object({
  from: z.iso.datetime({ offset: false }).optional(),
  to: z.iso.datetime({ offset: false }).optional(),
  recentEventLimit: z.number().int().min(1).max(50).optional(),
  sourceRowLimit: z.number().int().min(1).max(10_000).optional(),
}).strict().refine((value) => (value.from === undefined) === (value.to === undefined), { message: "from and to must be supplied together" });
const reportOutputSchema = z.union([
  z.object({
    outcome: z.literal("success"),
    configured: z.literal(true),
    report: z.object({
      schemaVersion: z.literal(1),
      window: z.object({ from: z.string(), to: z.string() }),
      coverage: z.object({ eventsAvailable: z.number().int().nonnegative(), eventsScanned: z.number().int().nonnegative(), metricsAvailable: z.number().int().nonnegative(), metricsScanned: z.number().int().nonnegative() }),
      partial: z.boolean(),
      notices: z.array(z.string()),
      recentEvents: z.array(z.object({ name: z.string(), occurredAt: z.string(), attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) })),
      latency: z.array(z.object({ name: z.string(), count: z.number().int().positive(), minimumSeconds: z.number().nonnegative(), averageSeconds: z.number().nonnegative(), p50Seconds: z.number().nonnegative(), p95Seconds: z.number().nonnegative(), maximumSeconds: z.number().nonnegative() })),
      repeatedFailures: z.array(z.object({ kind: z.enum(["attempt", "ci"]), outcome: z.string(), provider: z.string(), workflowName: z.string().optional(), count: z.number().positive(), lastObservedAt: z.string() })),
    }),
  }),
  z.object({ outcome: z.enum(["invalid_request", "invalid_data", "unconfigured", "unavailable"]), configured: z.boolean(), message: z.string() }),
]);

function structured(value: unknown, isError = false) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) }; }

export function registerOrchestratorTools(server: McpServer, options: { readonly port: OrchestratorControlToolPort | undefined; readonly observabilityPort: ExecutionObservabilityToolPort | undefined; readonly authorizationSecret: string | undefined; readonly configuration?: { readonly source: "explicit_profile" | "default_profile" | "database_override"; readonly serviceManaged: boolean }; readonly configurationCode?: string; readonly configurationError?: string; readonly now?: () => UtcTimestamp }): void {
  const now = options.now ?? (() => new Date().toISOString() as UtcTimestamp);
  server.registerTool("pirx_orchestrator_status", {
    title: "Read Pirx orchestrator status",
    description: "Read one bounded durable status snapshot for the headless Pirx orchestrator. This never starts work, reads prompts, or streams logs.",
    inputSchema: z.object({ staleAfterMs: z.number().int().min(1_000).max(3_600_000).optional() }).strict(),
    outputSchema: statusOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    if (options.port === undefined) return structured({ outcome: "unconfigured", configured: false, ...(options.configuration === undefined ? {} : { configuration: options.configuration }), ...(options.configurationCode === undefined ? {} : { configurationCode: options.configurationCode }), message: options.configurationError ?? "PIRX_ORCHESTRATOR_DATABASE is not configured." }, true);
    const value = options.port.status(now(), input.staleAfterMs ?? 120_000);
    return value.outcome === "success"
      ? structured({ outcome: "success", configured: true, ...(options.configuration === undefined ? {} : { configuration: options.configuration }), snapshot: value.value })
      : structured({ outcome: "unavailable", configured: true, ...(options.configuration === undefined ? {} : { configuration: options.configuration }), ...(options.configurationCode === undefined ? {} : { configurationCode: options.configurationCode }), message: value.message }, true);
  });

  server.registerTool("pirx_orchestrator_diagnostic", {
    title: "Read complete orchestrator diagnostic details",
    description: "Read a persisted diagnostic by sequence from status. Retrieve every chunk using nextOffset until absent. Contains sanitized source context and full reasons; never infer a cause from outcome alone. Does not run or resume work.",
    inputSchema: z.object({ sequence: z.number().int().positive(), offset: z.number().int().nonnegative().optional(), length: z.number().int().min(1).max(8_000).optional() }).strict(),
    outputSchema: z.union([z.object({ outcome: z.literal("success"), diagnostic: z.object({ sequence: z.number(), offset: z.number(), totalCharacters: z.number(), text: z.string(), nextOffset: z.number().optional() }) }), z.object({ outcome: z.enum(["unconfigured", "unavailable", "not_found", "invalid_request"]), message: z.string() })]),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    if (options.port?.diagnostic === undefined) return structured({ outcome: "unconfigured", message: "Orchestrator diagnostics are not configured." }, true);
    const value = options.port.diagnostic(input.sequence, input.offset ?? 0, input.length ?? 6_000);
    return value.outcome === "success" ? structured({ outcome: "success", diagnostic: value.value }) : structured({ outcome: value.outcome === "not_found" ? "not_found" : value.outcome === "invalid_record" ? "invalid_request" : "unavailable", message: value.message }, true);
  });

  server.registerTool("pirx_operator_questions", {
    title: "List pending Pirx operator questions",
    description: "List bounded durable questions that a worker explicitly left for a human decision. This does not answer questions, resume work, or inspect provider transcripts.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.union([z.object({ outcome: z.literal("success"), questions: z.array(operatorQuestionSchema) }), z.object({ outcome: z.enum(["unconfigured", "unavailable"]), message: z.string() })]),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    if (options.port?.operatorQuestions === undefined) return structured({ outcome: "unconfigured", message: options.configurationError ?? "Operator decisions are not configured." }, true);
    const value = options.port.operatorQuestions();
    return value.outcome === "success" ? structured({ outcome: "success", questions: value.value }) : structured({ outcome: "unavailable", message: value.message }, true);
  });

  server.registerTool("pirx_operator_decision", {
    title: "Answer one Pirx operator question",
    description: "Durably answer one exact pending operator question. The answer creates resume context; the normal daemon must still acquire a Lease and schedule the successor Attempt.",
    inputSchema: z.object({ questionId: operationIdSchema, expectedVersion: z.number().int().positive(), operationId: operationIdSchema, answer: z.string().trim().min(1).max(2_000) }).strict(),
    outputSchema: z.union([
      z.object({ outcome: z.enum(["accepted", "replayed"]), questionId: z.string(), taskId: z.string(), state: z.literal("answered"), version: z.number().int().positive(), resumeCheckpointId: z.string(), message: z.string() }),
      z.object({ outcome: z.enum(["authorization_required", "unconfigured", "not_found", "conflict", "invalid_request", "unavailable"]), questionId: z.string(), message: z.string() }),
    ]),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async (input, context) => {
    const arguments_ = { questionId: input.questionId, expectedVersion: input.expectedVersion, operationId: input.operationId, answer: input.answer };
    if (verifyHostAuthorization(options.authorizationSecret, context.mcpReq._meta, "pirx_operator_decision", arguments_) === undefined) return structured({ outcome: "authorization_required", questionId: input.questionId, message: "Exact host authorization is required for an operator decision." }, true);
    if (options.port?.answerOperatorQuestion === undefined) return structured({ outcome: "unconfigured", questionId: input.questionId, message: options.configurationError ?? "Operator decisions are not configured." }, true);
    const value = options.port.answerOperatorQuestion({ ...arguments_, decidedBy: "mcp-chat", decidedAt: now() });
    if (value.outcome === "success") return structured({ outcome: value.value.replayed ? "replayed" : "accepted", questionId: value.value.question.id, taskId: value.value.question.taskId, state: "answered", version: value.value.question.version, resumeCheckpointId: value.value.checkpoint.id, message: value.value.replayed ? "The same durable operator decision was already accepted." : "The operator decision was accepted; the normal scheduler may resume the Task after acquiring a Lease." });
    return structured({ outcome: value.outcome === "not_found" ? "not_found" : value.outcome === "conflict" ? "conflict" : value.outcome === "invalid_record" ? "invalid_request" : "unavailable", questionId: input.questionId, message: value.message }, true);
  });

  server.registerTool("pirx_task_unblock", {
    title: "Unblock a Task stopped by the resume failure limit",
    description: "Durably approve one more resume Attempt for a Task blocked after repeated FAILED or QUOTA_EXHAUSTED resumes. Read pirx_task_history and the latest Attempt diagnostic first and state the reason. Ambiguous or operator-question blocks are refused. The daemon still validates the workspace and acquires a Lease; another failure escalates again. Pass workspaceRevision (full SHA) only after the operator moved the Task worktree to that clean commit, e.g. merged a fixed base branch; the recorded base must stay its ancestor.",
    inputSchema: z.object({ taskId: operationIdSchema, operationId: operationIdSchema, reason: z.string().trim().min(1).max(256), workspaceRevision: z.string().regex(/^[0-9a-f]{40}$/u).optional() }).strict(),
    outputSchema: z.union([
      z.object({ outcome: z.enum(["unblocked", "replayed"]), taskId: z.string(), checkpointId: z.string(), message: z.string() }),
      z.object({ outcome: z.enum(["authorization_required", "unconfigured", "not_found", "conflict", "invalid_request", "unavailable"]), taskId: z.string(), message: z.string() }),
    ]),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async (input, context) => {
    const arguments_ = { taskId: input.taskId, operationId: input.operationId, reason: input.reason, ...(input.workspaceRevision === undefined ? {} : { workspaceRevision: input.workspaceRevision }) };
    if (verifyHostAuthorization(options.authorizationSecret, context.mcpReq._meta, "pirx_task_unblock", arguments_) === undefined) return structured({ outcome: "authorization_required", taskId: input.taskId, message: "Exact host authorization is required to unblock a Task." }, true);
    if (options.port?.unblockTask === undefined) return structured({ outcome: "unconfigured", taskId: input.taskId, message: options.configurationError ?? "Task unblock is not configured." }, true);
    const value = options.port.unblockTask({ ...arguments_, unblockedAt: now() });
    if (value.outcome === "success") return structured({ outcome: value.value.replayed ? "replayed" : "unblocked", taskId: value.value.taskId, checkpointId: value.value.checkpointId, message: value.value.replayed ? "The same unblock was already recorded." : "The Task is approved for one more resume; the daemon starts it on its next cycle after workspace validation and a Lease." });
    return structured({ outcome: value.outcome === "not_found" ? "not_found" : value.outcome === "conflict" ? "conflict" : value.outcome === "invalid_record" ? "invalid_request" : "unavailable", taskId: input.taskId, message: value.message }, true);
  });

  server.registerTool("pirx_work_submit", {
    title: "Submit tracked engineering work",
    description: "Durably accept one already-refined GitHub Issue for later daemon intake. Acceptance is not Queue linkage, a Lease, an Attempt, or worker start. The daemon remains the sole consumer and scheduler.",
    inputSchema: z.object({ operationId: operationIdSchema, repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u), issueNumber: z.number().int().positive(), goal: z.string().trim().min(1).max(2_000), acceptanceCriteria: z.array(z.string().trim().min(1).max(512)).min(1).max(40), priority: z.enum(["P0", "P1", "P2", "P3"]), risk: z.enum(["Low", "Medium", "High", "Prod-sensitive"]), area: z.enum(["Pirx Core", "GitHub", "Orchestrator", "Scheduler", "Checkpoint", "Agent Adapter", "Security", "Architecture Lab", "Research"]), workType: z.enum(["Task", "Bug", "Experiment"]), queueOrder: z.number().int().positive() }).strict(),
    outputSchema: z.union([z.object({ outcome: z.literal("accepted_pending"), intake: workIntakeSchema, message: z.string() }), z.object({ outcome: z.enum(["authorization_required", "unconfigured", "conflict", "invalid_request", "unavailable"]), operationId: z.string(), message: z.string() })]),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async (input, context) => {
    const arguments_ = { ...input, acceptanceCriteria: [...input.acceptanceCriteria] };
    if (verifyHostAuthorization(options.authorizationSecret, context.mcpReq._meta, "pirx_work_submit", arguments_) === undefined) return structured({ outcome: "authorization_required", operationId: input.operationId, message: "Exact host authorization is required to submit tracked work." }, true);
    if (options.port?.submitWork === undefined) return structured({ outcome: "unconfigured", operationId: input.operationId, message: options.configurationError ?? "Work intake is not configured." }, true);
    const value = options.port.submitWork({ ...arguments_, acceptedAt: now() });
    if (value.outcome === "success") return structured({ outcome: "accepted_pending", intake: value.value, message: "Pirx durably accepted the request. The daemon may be offline; no Queue linkage, Lease, Attempt, or worker start is implied. Read pirx_work_status later." });
    return structured({ outcome: value.outcome === "conflict" ? "conflict" : value.outcome === "invalid_record" ? "invalid_request" : "unavailable", operationId: input.operationId, message: value.message }, true);
  });

  server.registerTool("pirx_work_status", {
    title: "Read tracked work intake status",
    description: "Read one durable work-intake receipt after chat restart. accepted means only local durability; linking means Project metadata was applied; linked includes the runtime Task identity. uncertain and rejected are explicit.",
    inputSchema: z.object({ intakeId: operationIdSchema }).strict(),
    outputSchema: z.union([z.object({ outcome: z.literal("success"), intake: workIntakeSchema, message: z.string() }), z.object({ outcome: z.enum(["unconfigured", "not_found", "invalid_request", "unavailable"]), intakeId: z.string(), message: z.string() })]),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    if (options.port?.workStatus === undefined) return structured({ outcome: "unconfigured", intakeId: input.intakeId, message: options.configurationError ?? "Work intake is not configured." }, true);
    const value = options.port.workStatus(input.intakeId);
    if (value.outcome === "success") return structured({ outcome: "success", intake: value.value, message: value.value.state === "accepted" ? "The request is durable but not yet linked; the daemon may be offline." : value.value.state === "linked" ? "The request is linked to the runtime Task; scheduling still follows Queue and Lease policy." : `The durable intake is ${value.value.state}.` });
    return structured({ outcome: value.outcome === "not_found" ? "not_found" : value.outcome === "invalid_record" ? "invalid_request" : "unavailable", intakeId: input.intakeId, message: value.message }, true);
  });

  server.registerTool("pirx_execution_report", {
    title: "Read Pirx execution report",
    description: "Read a bounded report of normalized lifecycle outcomes, latency, and repeated failures. This never starts work, mutates orchestration, or reads raw logs and prompts.",
    inputSchema: reportInputSchema,
    outputSchema: reportOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    if (options.observabilityPort === undefined) return structured({ outcome: "unconfigured", configured: false, message: options.configurationError ?? "PIRX_ORCHESTRATOR_DATABASE is not configured." }, true);
    const to = (input.to ?? now()) as UtcTimestamp;
    const from = (input.from ?? new Date(Date.parse(to) - 86_400_000).toISOString()) as UtcTimestamp;
    const value = options.observabilityPort.report({ from, to, ...(input.recentEventLimit === undefined ? {} : { recentEventLimit: input.recentEventLimit }), ...(input.sourceRowLimit === undefined ? {} : { sourceRowLimit: input.sourceRowLimit }) });
    if (value.outcome === "success") return structured({ outcome: "success", configured: true, report: value.report });
    return structured({ outcome: value.outcome === "storage_error" ? "unavailable" : value.outcome, configured: true, message: value.message }, true);
  });

  server.registerTool("pirx_orchestrator_control", {
    title: "Pause or resume Pirx orchestration",
    description: "Durably request a graceful pause or resume. The command cannot select Tasks, cancel Attempts, bypass Leases, approve production, or power off the host.",
    inputSchema: z.object({ action: z.enum(["pause", "resume"]), reason: z.string().trim().min(1).max(256), operationId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u) }).strict(),
    outputSchema: controlOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async (input, context) => {
    const operationId = input.operationId;
    const arguments_ = { action: input.action, reason: input.reason, operationId };
    if (verifyHostAuthorization(options.authorizationSecret, context.mcpReq._meta, "pirx_orchestrator_control", arguments_) === undefined) return structured({ outcome: "authorization_required", operationId, message: "Exact host authorization is required for orchestrator control." }, true);
    if (options.port === undefined) return structured({ outcome: "unconfigured", operationId, message: options.configurationError ?? "PIRX_ORCHESTRATOR_DATABASE is not configured." }, true);
    const value = options.port.request({ operationId, action: input.action, reason: input.reason, requestedBy: "mcp-chat", requestedAt: now() });
    if (value.outcome === "applied" || value.outcome === "replayed") return structured({ outcome: value.outcome, operationId, requestedMode: value.record.requestedMode, version: value.record.version, message: value.message });
    return structured({ outcome: value.outcome === "storage_error" ? "unavailable" : value.outcome, operationId, message: value.message }, true);
  });

  server.registerTool("pirx_orchestrator_shutdown", {
    title: "Arm or cancel safe host shutdown",
    description: "Durably arm a one-shot host shutdown after the Queue is safely drained or after the next new Checkpoint, or cancel it while still armed. MCP never invokes the host command directly.",
    inputSchema: shutdownInputSchema,
    outputSchema: shutdownOutputSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async (input, context) => {
    const operationId = input.operationId;
    const arguments_ = input.action === "arm" ? { action: input.action, operationId, target: input.target, reason: input.reason } : { action: input.action, operationId, requestOperationId: input.requestOperationId, reason: input.reason };
    if (verifyHostAuthorization(options.authorizationSecret, context.mcpReq._meta, "pirx_orchestrator_shutdown", arguments_) === undefined) return structured({ outcome: "authorization_required", operationId, message: "Exact host authorization is required for host shutdown control." }, true);
    if (options.port === undefined) return structured({ outcome: "unconfigured", operationId, message: options.configurationError ?? "PIRX_ORCHESTRATOR_DATABASE is not configured." }, true);
    const value = options.port.shutdown(input.action === "arm" ? { ...arguments_, requestedBy: "mcp-chat", requestedAt: now() } : { ...arguments_, requestedBy: "mcp-chat", requestedAt: now() });
    if (value.outcome === "applied" || value.outcome === "replayed") {
      const record = value.record;
      const request = { requestOperationId: record.requestOperationId, target: record.target, state: record.state, requestedAt: record.requestedAt, version: record.version, ...(record.triggeredAt === undefined ? {} : { triggeredAt: record.triggeredAt }), ...(record.terminalAt === undefined ? {} : { terminalAt: record.terminalAt }), ...(record.terminalOutcome === undefined ? {} : { terminalOutcome: record.terminalOutcome }) };
      return structured({ outcome: value.outcome, operationId, request, message: value.message });
    }
    return structured({ outcome: value.outcome === "storage_error" ? "unavailable" : value.outcome, operationId, message: value.message }, true);
  });
}
