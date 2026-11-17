import { diagnosticContext } from "./diagnostic-context.js";
import type { HeadlessServiceEvent } from "./headless-service.js";
import type { RuntimeSqliteStore } from "./sqlite.js";

// The service reports a cycle by Task, Lease and Attempt id plus a fixed sentence such as
// "Worker process ended unsuccessfully." This adds what an operator reading the journal needs
// next: which Issue, what the worker itself reported, and until when a cooldown lasts. It only
// reads, and it is applied to the journal line alone, never to what the runtime stores.

export interface JournalContextOptions {
  readonly workerId: string;
  readonly provider: string;
  readonly now?: () => string;
}

function bounded(value: string): string { return String(diagnosticContext(value)).replace(/\s+/gu, " ").trim().slice(0, 600); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Returns the event with a `context` object when the runtime knows more; otherwise the event itself. */
/** The three reads the context needs; the runtime store satisfies it. */
export interface JournalContextSource {
  readonly tasks: Pick<RuntimeSqliteStore["tasks"], "get">;
  readonly attempts: Pick<RuntimeSqliteStore["attempts"], "get">;
  readonly workerAvailability: Pick<RuntimeSqliteStore["workerAvailability"], "evaluate">;
}

export function withJournalContext(store: JournalContextSource, event: HeadlessServiceEvent, options: JournalContextOptions): HeadlessServiceEvent | (HeadlessServiceEvent & { readonly context: Record<string, unknown> }) {
  if (event.event !== "cycle") return event;
  try {
    const context: Record<string, unknown> = {};
    const details = record(event.details) ? event.details : {};
    if (typeof details.taskId === "string") {
      const task = store.tasks.get(details.taskId);
      const reference = task.outcome === "success" ? task.value.githubReference : undefined;
      if (reference !== undefined) context.issue = `${reference.owner}/${reference.repository}#${reference.issueNumber}`;
    }
    if (typeof details.attemptId === "string") {
      const attempt = store.attempts.get(details.attemptId);
      if (attempt.outcome === "success" && attempt.value.state === "terminal") {
        context.result = attempt.value.result;
        const diagnostic = attempt.value.diagnostic;
        if (diagnostic !== undefined) {
          context.code = diagnostic.code;
          if (diagnostic.providerMessage !== undefined) context.providerMessage = bounded(diagnostic.providerMessage);
          if (diagnostic.exitCode !== undefined) context.exitCode = diagnostic.exitCode;
          if (diagnostic.stage !== undefined) context.stage = diagnostic.stage;
          if (diagnostic.providerRecovery !== undefined) context.providerRecovery = diagnostic.providerRecovery;
        }
      }
    }
    if (event.reason === "worker_unavailable" || context.code === "quota_exhausted" || context.code === "auth_required") {
      const now = (options.now ?? (() => new Date().toISOString()))();
      const availability = store.workerAvailability.evaluate(options.workerId, options.provider, now as never);
      if (availability.outcome === "success" && availability.value.availability === "unavailable") {
        context.workerState = availability.value.recordedState;
        if (availability.value.cooldownUntil !== undefined) context.cooldownUntil = availability.value.cooldownUntil;
        if (availability.value.reason !== undefined) context.cooldownReason = bounded(availability.value.reason);
      }
    }
    return Object.keys(context).length === 0 ? event : Object.freeze({ ...event, context: Object.freeze(context) });
  } catch {
    // The journal line is a convenience; a failed lookup must not hide the event itself.
    return event;
  }
}
