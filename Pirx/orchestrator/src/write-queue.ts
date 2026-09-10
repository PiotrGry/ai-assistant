import { randomUUID } from "node:crypto";

import { failure, type GitHubOperationResult } from "./outcome.js";
import { executeWithGitHubRetry, type GitHubRetryPolicyOptions } from "./retry-policy.js";

export interface GitHubWriteExecutionContext {
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export interface GitHubWriteOperation<T> {
  readonly operationKind: string;
  readonly idempotencyKey: string;
  readonly target: string;
  readonly timeoutMs: number;
  /** Enables #52 retry handling for this mutation when explicitly true. */
  readonly idempotent?: boolean;
  readonly retryPolicy?: GitHubRetryPolicyOptions;
  /** A stable digest or canonical identity of the mutation payload. */
  readonly payloadIdentity?: string;
  readonly execute: (context: GitHubWriteExecutionContext) => Promise<GitHubOperationResult<T>>;
}

export interface GitHubWriteQueueOptions {
  readonly capacity?: number;
  readonly correlationIdFactory?: () => string;
}

interface QueueEntry {
  readonly operationKind: string;
  readonly target: string;
  readonly payloadIdentity: string;
  readonly correlationId: string;
  readonly controller: AbortController;
  readonly operation: GitHubWriteOperation<unknown>;
  readonly promise: Promise<GitHubOperationResult<unknown>>;
  resolve: (result: GitHubOperationResult<unknown>) => void;
  settled: boolean;
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function operationFingerprint(operation: GitHubWriteOperation<unknown>): string {
  return `${operation.operationKind}\u0000${operation.target}\u0000${operation.payloadIdentity ?? ""}`;
}

function invalidOperation(correlationId: string, message: string): GitHubOperationResult<never> {
  return failure("permanent_error", "invalid_request", message, correlationId, "not_accepted");
}

/**
 * A bounded single-process FIFO for GitHub mutations.
 *
 * The queue remembers completed keys for the lifetime of the queue, so an
 * in-process replay receives the exact same result and correlation ID. It is
 * deliberately not durable; uncertain remote writes are returned as unknown
 * and must be reconciled by a later domain operation.
 */
export class GitHubWriteQueue {
  readonly #capacity: number;
  readonly #correlationIdFactory: () => string;
  readonly #entries = new Map<string, QueueEntry>();
  readonly #pending: QueueEntry[] = [];
  readonly #idleWaiters: Array<() => void> = [];
  #active: QueueEntry | undefined;
  #closed = false;
  #closing = false;
  #pumping = false;

  constructor(options: GitHubWriteQueueOptions = {}) {
    this.#capacity = options.capacity ?? 32;
    this.#correlationIdFactory = options.correlationIdFactory ?? randomUUID;
    if (!validPositiveInteger(this.#capacity)) {
      throw new RangeError("GitHub write queue capacity must be a positive integer.");
    }
  }

  get size(): number {
    return this.#pending.length + (this.#active === undefined ? 0 : 1);
  }

  get capacity(): number {
    return this.#capacity;
  }

  get closed(): boolean {
    return this.#closed;
  }

  submit<T>(operation: GitHubWriteOperation<T>): Promise<GitHubOperationResult<T>> {
    const correlationId = this.#correlationIdFactory();
    const key = operation.idempotencyKey;
    if (typeof key !== "string" || key.trim().length === 0) {
      return Promise.resolve(invalidOperation(correlationId, "GitHub mutation idempotencyKey is required."));
    }
    if (typeof operation.operationKind !== "string" || operation.operationKind.trim().length === 0) {
      return Promise.resolve(invalidOperation(correlationId, "GitHub mutation operationKind is required."));
    }
    if (typeof operation.target !== "string" || operation.target.trim().length === 0) {
      return Promise.resolve(invalidOperation(correlationId, "GitHub mutation target is required."));
    }
    if (!validPositiveInteger(operation.timeoutMs)) {
      return Promise.resolve(invalidOperation(correlationId, "GitHub mutation timeoutMs must be a positive integer."));
    }

    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (operationFingerprint(operation as GitHubWriteOperation<unknown>) !== `${existing.operationKind}\u0000${existing.target}\u0000${existing.payloadIdentity}`) {
        return Promise.resolve(failure(
          "permanent_error",
          "duplicate_conflict",
          "GitHub mutation idempotency key is already associated with a different operation.",
          correlationId,
          "not_accepted",
        ));
      }
      return existing.promise as Promise<GitHubOperationResult<T>>;
    }

    if (this.#closed || this.#closing) {
      return Promise.resolve(failure("permanent_error", "shutdown", "GitHub write queue is closed.", correlationId, "not_accepted"));
    }
    if (this.size >= this.#capacity) {
      return Promise.resolve(failure("permanent_error", "queue_full", "GitHub write queue capacity has been reached.", correlationId, "not_accepted"));
    }

    let resolveEntry: (result: GitHubOperationResult<unknown>) => void = () => undefined;
    const promise = new Promise<GitHubOperationResult<unknown>>((resolve) => {
      resolveEntry = resolve;
    });
    const entry: QueueEntry = {
      operationKind: operation.operationKind,
      target: operation.target,
      payloadIdentity: operation.payloadIdentity ?? "",
      correlationId,
      controller: new AbortController(),
      operation: operation as GitHubWriteOperation<unknown>,
      promise,
      resolve: resolveEntry,
      settled: false,
    };
    this.#entries.set(key, entry);
    this.#pending.push(entry);
    void this.#pump();
    return promise as Promise<GitHubOperationResult<T>>;
  }

  async drain(): Promise<void> {
    if (this.#active === undefined && this.#pending.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  async close(options: { readonly drain?: boolean } = {}): Promise<void> {
    if (options.drain === true) {
      this.#closing = true;
      await this.drain();
      this.#closed = true;
      return;
    }
    this.#closing = true;
    this.#closed = true;
    const pending = this.#pending.splice(0);
    for (const entry of pending) {
      this.#settle(entry, failure("permanent_error", "shutdown", "GitHub write queue was closed before the mutation started.", entry.correlationId, "not_accepted"));
    }
    this.#active?.controller.abort(new DOMException("GitHub write queue closed.", "AbortError"));
    await this.drain();
  }

  async #pump(): Promise<void> {
    if (this.#pumping) {
      return;
    }
    this.#pumping = true;
    try {
      while (!this.#closed && this.#active === undefined && this.#pending.length > 0) {
        const entry = this.#pending.shift();
        if (entry === undefined) {
          break;
        }
        this.#active = entry;
        const result = await this.#execute(entry);
        this.#settle(entry, result);
        this.#active = undefined;
        this.#notifyIdle();
      }
    } finally {
      this.#pumping = false;
      this.#notifyIdle();
    }
  }

  async #execute(entry: QueueEntry): Promise<GitHubOperationResult<unknown>> {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      entry.controller.abort(new DOMException("GitHub mutation timed out.", "TimeoutError"));
    }, entry.operation.timeoutMs);
    timeout.unref?.();
    try {
      const decision = await executeWithGitHubRetry(
        {
          operation: "write",
          ...(entry.operation.idempotent === undefined ? {} : { idempotent: entry.operation.idempotent }),
          correlationId: entry.correlationId,
          signal: entry.controller.signal,
          execute: async ({ signal }) => entry.operation.execute({
            ...(signal === undefined ? {} : { signal }),
            correlationId: entry.correlationId,
          } as GitHubWriteExecutionContext),
        },
        entry.operation.retryPolicy,
      );
      const result = decision.finalOutcome;
      if (timedOut) {
        return failure("unknown", "timeout", "GitHub mutation timed out and may have reached GitHub.", entry.correlationId, "unknown");
      }
      if (this.#closed && entry.controller.signal.aborted) {
        return failure("permanent_error", "shutdown", "GitHub mutation was cancelled during queue shutdown.", entry.correlationId, "unknown");
      }
      return result;
    } catch {
      if (timedOut) {
        return failure("unknown", "timeout", "GitHub mutation timed out and may have reached GitHub.", entry.correlationId, "unknown");
      }
      if (this.#closed || entry.controller.signal.aborted) {
        return failure("permanent_error", "shutdown", "GitHub mutation was cancelled during queue shutdown.", entry.correlationId, "unknown");
      }
      return failure("unknown", "execution_failed", "GitHub mutation execution failed with an uncertain outcome.", entry.correlationId, "unknown");
    } finally {
      clearTimeout(timeout);
    }
  }

  #settle(entry: QueueEntry, result: GitHubOperationResult<unknown>): void {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    entry.resolve(result);
  }

  #notifyIdle(): void {
    if (this.#active !== undefined || this.#pending.length > 0) {
      return;
    }
    const waiters = this.#idleWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }
}
