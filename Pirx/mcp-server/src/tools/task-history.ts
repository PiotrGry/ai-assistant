import type { RuntimeBindingCheck } from "../runtime-binding.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { diagnosticContext, RuntimeSqliteStore, RuntimeStorageError, type AttemptSnapshot } from "@pirx/orchestrator";
import * as z from "zod/v4";

const id = z.string().trim().min(1).max(256);
const inputSchema = z.object({
  taskId: id.optional(),
  attemptId: id.optional(),
  repository: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u).max(201).optional(),
  issueNumber: z.number().int().positive().optional(),
  afterOrdinal: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict().refine((input) => {
  if (input.attemptId !== undefined) return input.taskId === undefined && input.repository === undefined && input.issueNumber === undefined && input.afterOrdinal === undefined && input.limit === undefined;
  if (input.taskId !== undefined) return input.repository === undefined && input.issueNumber === undefined;
  return input.repository !== undefined && input.issueNumber !== undefined;
}, "Supply either attemptId, taskId, or repository and issueNumber.");

function response(value: Record<string, unknown>) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(value.outcome === "success" ? {} : { isError: true }),
  };
}

function summarizeAttempt(attempt: AttemptSnapshot) {
  const base = { id: attempt.id, taskId: attempt.taskId, ordinal: attempt.ordinal, state: attempt.state, startedAt: attempt.startedAt, worker: attempt.worker, provider: attempt.provider, ...(attempt.branch === undefined ? {} : { branch: attempt.branch }) };
  if (attempt.state === "running") return base;
  const diagnostic = attempt.diagnostic;
  return {
    ...base, result: attempt.result, endedAt: attempt.endedAt,
    ...(attempt.finalCommit === undefined ? {} : { finalCommit: attempt.finalCommit }),
    ...(attempt.blockingReason === undefined ? {} : { blockingReason: diagnosticContext(attempt.blockingReason) }),
    ...(diagnostic === undefined ? { diagnosticAvailable: false } : {
      diagnosticAvailable: true,
      diagnosticReference: { attemptId: attempt.id },
      diagnosticCode: diagnostic.code,
      ...(diagnostic.stage === undefined ? {} : { diagnosticStage: diagnostic.stage }),
      ...(diagnostic.correlationId === undefined ? {} : { correlationId: diagnostic.correlationId }),
    }),
  };
}

export function registerTaskHistory(server: McpServer, filename: string | undefined, configurationError?: string, checkBinding: RuntimeBindingCheck = () => {}): void {
  server.registerTool("pirx_task_history", {
    description: "Read the durable state and Attempts of a specific Task, including Tasks outside Queue. Use taskId or repository plus issueNumber. Without afterOrdinal it returns the newest Attempts and totalAttempts; pass afterOrdinal: 0 to read from the first Attempt, then nextAfterOrdinal for the next page. Use attemptId alone for its sanitized diagnostic, when available; diagnostic.providerMessage holds the bounded Claude CLI error output when it was recorded (Attempts run before 2026-11-04 have none). No work is started.",
    inputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    if (filename === undefined) return response({ outcome: "unconfigured", message: configurationError ?? "Runtime SQLite is not configured." });
    let store: RuntimeSqliteStore | undefined;
    try {
      checkBinding();
      const runtime = RuntimeSqliteStore.open({ filename, mode: "read_only", busyTimeoutMs: 1_000 });
      store = runtime;
      const snapshot = runtime.transaction<Record<string, unknown>>(() => {
        if (input.attemptId !== undefined) {
          const attempt = runtime.attempts.get(input.attemptId);
          if (attempt.outcome !== "success") return attempt;
          const diagnostic = attempt.value.state === "terminal" ? attempt.value.diagnostic : undefined;
          return { outcome: "success", value: {
            outcome: "success", attempt: summarizeAttempt(attempt.value),
            diagnostic: diagnostic === undefined ? null : diagnosticContext(diagnostic),
          } };
        }

        let taskId = input.taskId;
        if (taskId === undefined && input.repository !== undefined && input.issueNumber !== undefined) {
          const [owner, repository] = input.repository.split("/");
          const candidates = runtime.database.prepare(`
            SELECT t.id FROM runtime_tasks t LEFT JOIN runtime_task_issue_links l ON l.task_id = t.id
            WHERE COALESCE(l.owner, t.github_owner) = ? COLLATE NOCASE
              AND COALESCE(l.repository, t.github_repository) = ? COLLATE NOCASE
              AND COALESCE(l.issue_number, t.github_issue_number) = ?
            ORDER BY t.id LIMIT 21`).all(owner!, repository!, input.issueNumber) as Array<{ id: string }>;
          if (candidates.length > 1) return { outcome: "success", value: { outcome: "ambiguous", taskIds: candidates.slice(0, 20).map((row) => row.id), truncated: candidates.length > 20 } };
          taskId = candidates[0]?.id;
        }
        if (taskId === undefined) return { outcome: "not_found", message: "Task was not found." };
        const task = runtime.tasks.get(taskId);
        if (task.outcome !== "success") return task;
        const limit = input.limit ?? 5;
        const totalAttempts = (runtime.database.prepare("SELECT COUNT(*) AS n FROM runtime_attempts WHERE task_id = ?").get(taskId) as { n: number }).n;
        // gh-462: a status question read the five oldest of 14 Attempts as the whole history.
        // Without afterOrdinal, show the newest page; paging forward from there finds nothing.
        const rows = (input.afterOrdinal === undefined
          ? (runtime.database.prepare("SELECT id FROM runtime_attempts WHERE task_id = ? ORDER BY ordinal DESC LIMIT ?").all(taskId, limit) as Array<{ id: string }>).reverse()
          : runtime.database.prepare("SELECT id FROM runtime_attempts WHERE task_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?").all(taskId, input.afterOrdinal, limit + 1)) as Array<{ id: string }>;
        const attempts: ReturnType<typeof summarizeAttempt>[] = [];
        for (const row of rows.slice(0, limit)) {
          const attempt = runtime.attempts.get(row.id);
          if (attempt.outcome !== "success") return { outcome: "storage_error", message: "Attempt history could not be read." };
          attempts.push(summarizeAttempt(attempt.value));
        }
        const { id, state, createdAt, updatedAt, blockingReason, githubReference } = task.value;
        return { outcome: "success", value: {
          outcome: "success",
          task: { id, state, createdAt, updatedAt, ...(githubReference === undefined ? {} : { githubReference }), ...(blockingReason === undefined ? {} : { blockingReason: diagnosticContext(blockingReason) }) },
          totalAttempts,
          attempts,
          ...(rows.length > limit ? { nextAfterOrdinal: attempts.at(-1)?.ordinal } : {}),
        } };
      });
      if (snapshot.outcome === "success") return response(snapshot.value);
      return response({ outcome: snapshot.outcome === "not_found" ? "not_found" : "unavailable", message: snapshot.outcome === "not_found" ? "Task or Attempt was not found." : "Task history could not be read." });
    } catch (error: unknown) {
      return response({ outcome: "unavailable", message: error instanceof RuntimeStorageError ? error.message : "Runtime SQLite could not be opened." });
    } finally { store?.close(); }
  });
}
