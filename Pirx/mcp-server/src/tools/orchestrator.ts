import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  OrchestratorControlRepository,
  HostShutdownRepository,
  RuntimeSqliteStore,
  type HostShutdownCommand,
  type HostShutdownCommandResult,
  type OrchestratorControlRequest,
  type OrchestratorControlRequestResult,
  type OrchestratorStatusSnapshot,
  type StorageResult,
  type UtcTimestamp,
} from "@pirx/orchestrator";

import { verifyHostAuthorization } from "../authorization.js";

export interface OrchestratorControlToolPort {
  status(now: UtcTimestamp, staleAfterMs: number): StorageResult<OrchestratorStatusSnapshot>;
  request(input: OrchestratorControlRequest): OrchestratorControlRequestResult;
  shutdown(input: HostShutdownCommand): HostShutdownCommandResult;
}

export class SqliteOrchestratorControlToolPort implements OrchestratorControlToolPort {
  readonly #filename: string;
  public constructor(filename: string) { this.#filename = filename; }
  public status(now: UtcTimestamp, staleAfterMs: number): StorageResult<OrchestratorStatusSnapshot> { return this.#withStore((_store, repository) => repository.status(now, staleAfterMs)); }
  public request(input: OrchestratorControlRequest): OrchestratorControlRequestResult {
    const value = this.#withStore((_store, repository) => ({ outcome: "success" as const, value: repository.request(input) }));
    return value.outcome === "success" ? value.value : { outcome: "storage_error", operationId: input.operationId, message: value.message };
  }
  public shutdown(input: HostShutdownCommand): HostShutdownCommandResult {
    const value = this.#withStore((store) => ({ outcome: "success" as const, value: new HostShutdownRepository(store).command(input) }));
    return value.outcome === "success" ? value.value : { outcome: "storage_error", operationId: input.operationId, message: value.message };
  }
  #withStore<T>(operation: (store: RuntimeSqliteStore, repository: OrchestratorControlRepository) => StorageResult<T>): StorageResult<T> {
    let store: RuntimeSqliteStore | undefined;
    try { store = RuntimeSqliteStore.open({ filename: this.#filename, busyTimeoutMs: 1_000 }); return operation(store, new OrchestratorControlRepository(store)); }
    catch { return { outcome: "storage_error", message: "Orchestrator runtime database is unavailable." }; }
    finally { try { store?.close(); } catch { /* preserve bounded operation result */ } }
  }
}

const entitySchema = z.object({ id: z.string(), state: z.string(), issueNumber: z.number().int().positive().optional(), ordinal: z.number().int().positive().optional(), result: z.string().optional(), queueOrder: z.number().int().positive().optional(), expiresAt: z.string().optional() });
const hostShutdownSchema = z.object({ requestOperationId: z.string(), target: z.enum(["queue_drained", "next_checkpoint"]), state: z.enum(["armed", "triggered", "draining", "poweroff_requested", "accepted", "cancelled", "failed"]), requestedAt: z.string(), version: z.number().int().positive(), triggeredAt: z.string().optional(), terminalAt: z.string().optional(), terminalOutcome: z.string().optional() });
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), requestedMode: z.enum(["running", "paused"]), observedState: z.enum(["starting", "running", "paused", "stopping", "stopped", "error"]), version: z.number().int().nonnegative(), heartbeatAt: z.string().optional(), heartbeatStale: z.boolean(), lastQueueOutcome: z.string().optional(), lastDeliveryOutcome: z.string().optional(), lastCycleOutcome: z.string().optional(), activeTask: entitySchema.optional(), activeAttempt: entitySchema.optional(), activeLease: entitySchema.optional(), nextQueuedTask: entitySchema.optional(), activeRelease: entitySchema.optional(), hostShutdown: hostShutdownSchema.optional(),
});
const statusOutputSchema = z.union([
  z.object({ outcome: z.literal("success"), configured: z.literal(true), snapshot: snapshotSchema }),
  z.object({ outcome: z.enum(["unconfigured", "unavailable"]), configured: z.boolean(), message: z.string() }),
]);
const controlOutputSchema = z.union([
  z.object({ outcome: z.enum(["applied", "replayed"]), operationId: z.string(), requestedMode: z.enum(["running", "paused"]), version: z.number().int().positive(), message: z.string() }),
  z.object({ outcome: z.enum(["authorization_required", "unconfigured", "conflict", "invalid_request", "unavailable"]), operationId: z.string(), message: z.string() }),
]);
const operationIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const shutdownInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("arm"), operationId: operationIdSchema, target: z.enum(["queue_drained", "next_checkpoint"]), reason: z.string().trim().min(1).max(256) }).strict(),
  z.object({ action: z.literal("cancel"), operationId: operationIdSchema, requestOperationId: operationIdSchema, reason: z.string().trim().min(1).max(256) }).strict(),
]);
const shutdownOutputSchema = z.union([
  z.object({ outcome: z.enum(["applied", "replayed"]), operationId: z.string(), request: hostShutdownSchema, message: z.string() }),
  z.object({ outcome: z.enum(["authorization_required", "unconfigured", "conflict", "invalid_request", "not_found", "not_cancellable", "unavailable"]), operationId: z.string(), message: z.string() }),
]);

function structured(value: unknown, isError = false) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) }; }

export function registerOrchestratorTools(server: McpServer, options: { readonly port: OrchestratorControlToolPort | undefined; readonly authorizationSecret: string | undefined; readonly configurationError?: string; readonly now?: () => UtcTimestamp }): void {
  const now = options.now ?? (() => new Date().toISOString() as UtcTimestamp);
  server.registerTool("pirx_orchestrator_status", {
    title: "Read Pirx orchestrator status",
    description: "Read one bounded durable status snapshot for the headless Pirx orchestrator. This never starts work, reads prompts, or streams logs.",
    inputSchema: z.object({ staleAfterMs: z.number().int().min(1_000).max(3_600_000).optional() }).strict(),
    outputSchema: statusOutputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    if (options.port === undefined) return structured({ outcome: "unconfigured", configured: false, message: options.configurationError ?? "PIRX_ORCHESTRATOR_DATABASE is not configured." }, true);
    const value = options.port.status(now(), input.staleAfterMs ?? 120_000);
    return value.outcome === "success" ? structured({ outcome: "success", configured: true, snapshot: value.value }) : structured({ outcome: "unavailable", configured: true, message: value.message }, true);
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
