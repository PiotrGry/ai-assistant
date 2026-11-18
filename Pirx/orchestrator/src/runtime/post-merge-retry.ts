import { createHash } from "node:crypto";

import { createCheckpoint, type Checkpoint } from "./checkpoint.js";
import { BRANCH_SYNC_PROVIDER } from "./feature-branch-sync.js";
import type { GitHubActionsWorkflowRun } from "../github/ci-watch.js";
import type { RuntimeSqliteStore } from "./sqlite.js";
import type { CiRunQueryContext, ProviderIndependentCiGateway } from "./ci-contract.js";
import { retryTask, type AttemptId, type TaskId, type TaskSnapshot, type TerminalAttemptSnapshot, type UtcTimestamp } from "./task-domain.js";

/** Fixes for one Task's failed release pipeline before a human decides. */
export const MAX_POST_MERGE_RETRIES = 2;
const FINDING = 2_000;

export type PostMergeRetryOutcome = "created" | "already_created" | "limit_reached" | "conflict";
export interface PostMergeRetryRequest {
  readonly task: TaskSnapshot;
  /** The latest terminal Attempt: it owns the branch and worktree the fix continues in. */
  readonly attempt: TerminalAttemptSnapshot;
  readonly mergeSha: string;
  readonly baseBranch: string;
  readonly failedRun: GitHubActionsWorkflowRun;
  readonly message: string;
  /** Failed jobs, steps and a log excerpt of the run; best effort. */
  readonly facts: readonly string[];
  readonly now: UtcTimestamp;
}
export interface PostMergeRetryResult { readonly outcome: PostMergeRetryOutcome; readonly message: string; readonly attemptId?: AttemptId }

export function postMergeRetryIds(taskId: TaskId, runId: number): { readonly attemptId: AttemptId; readonly checkpointId: Checkpoint["id"] } {
  const digest = createHash("sha256").update(`${taskId}\u0000${runId}`, "utf8").digest("hex").slice(0, 40);
  return { attemptId: `pm-retry-${digest}` as AttemptId, checkpointId: `pm-retry-${digest}-checkpoint` as Checkpoint["id"] };
}

/**
 * The repository's own pipeline failed after the Task branch was merged into the base.
 * The fix continues on the same branch and worktree: one successor Attempt for the worker,
 * with the failed run as its Checkpoint findings. Its PR is new; the branch keeps its history.
 */
export function createPostMergeRetry(store: RuntimeSqliteStore, request: PostMergeRetryRequest): PostMergeRetryResult {
  const { task, attempt, failedRun } = request;
  const ids = postMergeRetryIds(task.id, failedRun.id);
  const created = store.transaction<PostMergeRetryResult>(({ tasks, attempts, checkpoints }) => {
    const history = attempts.listByTask(task.id);
    const current = tasks.get(task.id);
    if (history.outcome !== "success") return history;
    if (current.outcome !== "success") return current;
    if (history.value.some((item) => item.id === ids.attemptId)) return { outcome: "success" as const, value: { outcome: "already_created" as const, message: `A fix for run ${failedRun.id} was already handed to the worker.`, attemptId: ids.attemptId } };
    const previous = history.value.at(-1);
    if (previous?.id !== attempt.id || previous.state !== "terminal" || previous.branch === undefined || previous.worktree === undefined || previous.finalCommit === undefined) return { outcome: "success" as const, value: { outcome: "conflict" as const, message: "The post-merge fix needs the latest terminal Attempt and its branch." } };
    const fixes = history.value.filter((item) => item.id.startsWith("pm-retry-")).length;
    if (fixes >= MAX_POST_MERGE_RETRIES) return { outcome: "success" as const, value: { outcome: "limit_reached" as const, message: `The pipeline failed again after ${fixes} fixes; a human decides. ${request.message}` } };
    // Branch-sync Attempts belong to Pirx; the fix goes to the worker that wrote the branch.
    const worker = [...history.value].reverse().find((item) => item.provider !== BRANCH_SYNC_PROVIDER);
    if (worker === undefined) return { outcome: "success" as const, value: { outcome: "conflict" as const, message: "No worker Attempt wrote this branch." } };
    const checkpoint = createCheckpoint({
      id: ids.checkpointId, taskId: task.id, previousAttemptId: previous.id, trigger: "REQUIRED_ATTEMPT", createdAt: request.now, goal: current.value.goal, currentState: current.value.state,
      ...(task.githubReference === undefined ? {} : { repository: `${task.githubReference.owner}/${task.githubReference.repository}`, branch: previous.branch, worktree: previous.worktree, currentCommit: previous.finalCommit }),
      completedWork: [`Branch ${previous.branch} (${previous.finalCommit.slice(0, 7)}) was merged into ${request.baseBranch} as ${request.mergeSha.slice(0, 7)}.`],
      remainingWork: [`The repository's release pipeline failed for that merge. Fix the cause on the same branch ${previous.branch}, commit and push; Pirx opens a new pull request from it.`],
      changedFiles: [],
      findings: [request.message, ...request.facts].map((fact) => fact.slice(0, FINDING)).slice(0, 50),
      hypotheses: [],
      tests: [{ command: failedRun.name ?? `workflow run ${failedRun.id}`, result: `run ${failedRun.id} ended ${failedRun.conclusion ?? "without a conclusion"} for ${failedRun.headSha}: ${failedRun.url}` }],
      evidence: [{ reference: `post-merge-run:${failedRun.id}`, summary: `Failed release pipeline run ${failedRun.id} for merge ${request.mergeSha}.` }],
      lastAction: "recorded the failed post-merge pipeline run for a fix Attempt",
      resumeInstruction: `Merge the current ${request.baseBranch} into ${previous.branch} first (it already holds this branch's earlier commits), then fix what the failed run reports.`,
    });
    if (!checkpoint.ok) return { outcome: "success" as const, value: { outcome: "conflict" as const, message: `The fix Checkpoint is invalid: ${checkpoint.violations.map((item) => item.message).join("; ")}` } };
    const saved = checkpoints.save(checkpoint.value);
    if (saved.outcome !== "success") return saved;
    const retried = retryTask(current.value, history.value, { id: ids.attemptId, worker: worker.worker, provider: worker.provider, predecessorAttemptId: previous.id, branch: previous.branch, worktree: previous.worktree, currentCommit: previous.finalCommit, checkpointReference: checkpoint.value.id, progress: `fix for failed post-merge run ${failedRun.id}` }, request.now);
    if (!retried.ok) return { outcome: "success" as const, value: { outcome: "conflict" as const, message: retried.error.message } };
    const updated = tasks.update(retried.value.task, { state: current.value.state, updatedAt: current.value.updatedAt });
    if (updated.outcome !== "success") return updated;
    const inserted = attempts.create(retried.value.attempt);
    if (inserted.outcome !== "success") return inserted;
    return { outcome: "success" as const, value: { outcome: "created" as const, message: `Handed run ${failedRun.id} to the worker as Attempt ${ids.attemptId} on ${previous.branch}.`, attemptId: ids.attemptId } };
  });
  return created.outcome === "success" ? created.value : { outcome: "conflict", message: created.message };
}

/** What the worker needs from a failed run: which jobs and steps failed, and the tail of the log. */
export async function readFailureFacts(ci: Pick<ProviderIndependentCiGateway, "getRun" | "getFailureEvidence" | "getFailureLogExcerpt">, runId: number, context: CiRunQueryContext): Promise<readonly string[]> {
  const run = await ci.getRun(String(runId), context);
  if (run.run === undefined) return [`The failed run ${runId} could not be read: ${run.message}`];
  const facts: string[] = [];
  const evidence = await ci.getFailureEvidence(run.run, context);
  for (const job of evidence.evidence?.failedJobs ?? []) {
    const steps = job.failedSteps.map((step) => step.number === undefined ? step.name : `${step.name} (#${step.number})`).join(", ");
    facts.push(`Failed job ${job.name}${steps.length === 0 ? "" : `; failed steps: ${steps}`}${job.url === undefined ? "" : ` (${job.url})`}.`);
  }
  const excerpt = await ci.getFailureLogExcerpt?.(run.run, context);
  if (excerpt?.excerpt !== undefined) facts.push(`Log excerpt:\n${excerpt.excerpt.slice(-(FINDING - 20))}`);
  return facts;
}
