import { randomUUID } from "node:crypto";

import type { ContextBuildRecord, SqliteStore } from "./storage/sqlite.js";

export type RecordedOperationKind = "llm" | "mcp";
export type RecordedOperationStatus = "succeeded" | "failed" | "unknown";

export interface OperationStartInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly kind: RecordedOperationKind;
  readonly startedAt: string;
  readonly payload: Record<string, unknown>;
}

export interface OperationHandle {
  readonly id: string;
}

export interface OperationFinishInput {
  readonly endedAt: string;
  readonly status: RecordedOperationStatus;
  readonly payload: Record<string, unknown>;
  readonly error?: string;
}

export interface ContextBuildInput {
  readonly policyVersion: string;
  readonly estimatedInputTokens: number;
  readonly budgetTokens: number;
  readonly selected: Record<string, unknown>;
  readonly omitted: Record<string, unknown>;
  readonly createdAt: string;
}

export interface OperationRecorder {
  start(input: OperationStartInput): OperationHandle;
  finish(handle: OperationHandle, input: OperationFinishInput): void;
  recordContextBuild?(handle: OperationHandle, input: ContextBuildInput): void;
}

export class SqliteOperationRecorder implements OperationRecorder {
  readonly #store: SqliteStore;

  constructor(store: SqliteStore) {
    this.#store = store;
  }

  start(input: OperationStartInput): OperationHandle {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new Error(`Operation sequence must be a non-negative safe integer: ${input.sequence}`);
    }
    const handle = { id: randomUUID() };
    this.#store.insertOperation({
      id: handle.id,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sequence: input.sequence,
      kind: input.kind,
      startedAt: input.startedAt,
      status: "started",
      payload: input.payload,
    });
    return handle;
  }

  finish(handle: OperationHandle, input: OperationFinishInput): void {
    this.#store.finishOperation(
      handle.id,
      input.endedAt,
      input.status,
      input.error,
      input.payload,
    );
  }

  recordContextBuild(
    handle: OperationHandle,
    input: ContextBuildInput,
  ): void {
    const record: ContextBuildRecord = {
      id: randomUUID(),
      operationId: handle.id,
      policyVersion: input.policyVersion,
      estimatedInputTokens: input.estimatedInputTokens,
      budgetTokens: input.budgetTokens,
      selected: input.selected,
      omitted: input.omitted,
      createdAt: input.createdAt,
    };
    this.#store.insertContextBuild(record);
  }
}
