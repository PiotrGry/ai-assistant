import { createHash, randomUUID } from "node:crypto";

import {
  type ActionEventState,
  SqliteStore,
} from "./storage/sqlite.js";

export interface ActionPlanInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly target: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly authorization: Record<string, unknown>;
}

export interface ActionPlan {
  readonly mutationId: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly target: string;
  readonly authorization: Record<string, unknown>;
  readonly alreadySucceeded: boolean;
  readonly requiresReconciliation: boolean;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Cannot serialize action argument.");
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

export function mutationId(input: ActionPlanInput): string {
  const operation = [
    input.sessionId,
    input.turnId,
    input.toolName,
    stableSerialize(input.arguments),
  ].join("\u0000");
  return createHash("sha256").update(operation).digest("hex");
}

export class SqliteActionLedger {
  readonly #store: SqliteStore;

  constructor(store: SqliteStore) {
    this.#store = store;
  }

  plan(input: ActionPlanInput): ActionPlan {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new Error(`Action sequence must be a non-negative safe integer: ${input.sequence}`);
    }

    const id = mutationId(input);
    const previous = this.#store.latestActionState(id);
    if (previous?.state === "succeeded") {
      return {
        mutationId: id,
        operationId: "",
        attempt: previous.attempt,
        target: input.target,
        authorization: input.authorization,
        alreadySucceeded: true,
        requiresReconciliation: false,
      };
    }
    if (
      previous !== undefined &&
      (previous.state === "planned" ||
        previous.state === "started" ||
        previous.state === "unknown")
    ) {
      return {
        mutationId: id,
        operationId: "",
        attempt: previous.attempt,
        target: input.target,
        authorization: input.authorization,
        alreadySucceeded: false,
        requiresReconciliation: true,
      };
    }

    const operationId = randomUUID();
    const attempt = (previous?.attempt ?? 0) + 1;
    const createdAt = new Date().toISOString();
    this.#store.insertOperation({
      id: operationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      sequence: input.sequence,
      kind: "mcp",
      startedAt: createdAt,
      status: "started",
      payload: {
        schema_version: 1,
        tool_name: input.toolName,
        arguments: input.arguments,
      },
    });
    this.#store.insertActionEvent({
      id: randomUUID(),
      operationId,
      mutationId: id,
      target: input.target,
      attempt,
      authorization: input.authorization,
      state: "planned",
      createdAt,
    });

    return {
      mutationId: id,
      operationId,
      attempt,
      target: input.target,
      authorization: input.authorization,
      alreadySucceeded: false,
      requiresReconciliation: false,
    };
  }

  start(plan: ActionPlan): void {
    this.#transition(plan, "started");
  }

  finish(
    plan: ActionPlan,
    state: Exclude<ActionEventState, "planned" | "started">,
    confirmation?: Record<string, unknown>,
    error?: string,
  ): void {
    if (plan.operationId.length === 0) {
      throw new Error("Cannot finish an action without a new operation.");
    }
    this.#transition(plan, state, confirmation);
    this.#store.finishOperation(
      plan.operationId,
      new Date().toISOString(),
      state,
      error,
    );
  }

  #transition(
    plan: ActionPlan,
    state: ActionEventState,
    confirmation?: Record<string, unknown>,
  ): void {
    if (plan.operationId.length === 0) {
      throw new Error("Cannot transition an action without a new operation.");
    }
    this.#store.insertActionEvent({
      id: randomUUID(),
      operationId: plan.operationId,
      mutationId: plan.mutationId,
      target: plan.target,
      attempt: plan.attempt,
      authorization: plan.authorization,
      state,
      ...(confirmation === undefined ? {} : { confirmation }),
      createdAt: new Date().toISOString(),
    });
  }
}
