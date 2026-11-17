import { isRepositoryRejection, PUSH_TIMEOUT_MS } from "../claude/git-state.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import { retryTask, transitionAttempt, type AttemptId, type AttemptSnapshot, type TaskId, type UtcTimestamp } from "./task-domain.js";
import { GitWorkspaceCommandRunner } from "./workspace.js";

/** Pirx, not a Claude worker, produced the Attempt: it merged the base branch into the Task branch. */
export const BRANCH_SYNC_WORKER = "pirx";
export const BRANCH_SYNC_PROVIDER = "pirx-branch-sync";
/** Consecutive syncs without a merge mean the base moves faster than CI finishes; a human decides then. */
export const MAX_CONSECUTIVE_BRANCH_SYNCS = 5;
const GIT_STEP_TIMEOUT_MS = 120_000;

export type FeatureBranchSyncOutcome = "synced" | "conflict" | "rejected" | "retryable" | "limit_reached" | "reconciliation_required";

export interface FeatureBranchSyncRequest {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly remoteName: string;
  readonly baseBranch: string;
  readonly now: UtcTimestamp;
  readonly signal?: AbortSignal;
}

export interface FeatureBranchSyncResult {
  readonly outcome: FeatureBranchSyncOutcome;
  readonly message: string;
  readonly successorAttemptId?: AttemptId;
  readonly commit?: string;
  readonly conflictedFiles?: readonly string[];
}

type GitRunner = Pick<GitWorkspaceCommandRunner, "run">;
type GitOutput = Awaited<ReturnType<GitRunner["run"]>>;

function result(outcome: FeatureBranchSyncOutcome, message: string, extra: Omit<FeatureBranchSyncResult, "outcome" | "message"> = {}): FeatureBranchSyncResult {
  return Object.freeze({ outcome, message: message.slice(0, 1_000), ...extra });
}
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/gu;
function fullOutput(value: GitOutput): string { return `${value.stdout}\n${value.stderr}`.replace(ANSI, "").trim(); }
/** Hooks print the decisive line last and delivery logs keep 256 characters, so the message carries only the tail. */
function output(value: GitOutput): string { return fullOutput(value).slice(-180) || "no output"; }
const SHA = /^[0-9a-f]{40}$/u;

/**
 * Brings a delivered Task branch up to date with its base so a repository that
 * requires up-to-date branches can merge it. Pirx merges the base into the
 * Task worktree it owns, pushes the merge commit without force, and records it
 * as a new CODE_PUSHED Attempt. Every exact-commit rule downstream (CI
 * correlation, merge, release, cleanup) then applies to the merge commit
 * unchanged.
 */
export class FeatureBranchSyncService {
  readonly #store: RuntimeSqliteStore;
  readonly #git: GitRunner;

  public constructor(store: RuntimeSqliteStore, git: GitRunner = new GitWorkspaceCommandRunner()) { this.#store = store; this.#git = git; }

  public async sync(request: FeatureBranchSyncRequest): Promise<FeatureBranchSyncResult> {
    const task = this.#store.tasks.get(request.taskId);
    const history = this.#store.attempts.listByTask(request.taskId);
    if (task.outcome !== "success" || history.outcome !== "success") return result("reconciliation_required", "Task or Attempt history is unavailable for branch sync.");
    const latest = history.value.at(-1);
    if (latest === undefined || latest.id !== request.attemptId || latest.state !== "terminal" || latest.result !== "CODE_PUSHED" || latest.branch === undefined || latest.finalCommit === undefined || !SHA.test(latest.finalCommit)) return result("reconciliation_required", "Branch sync requires the latest Attempt to be a CODE_PUSHED Attempt with a full commit.");
    if (consecutiveSyncs(history.value) >= MAX_CONSECUTIVE_BRANCH_SYNCS) return result("limit_reached", `${request.baseBranch} moved ${MAX_CONSECUTIVE_BRANCH_SYNCS} times before CI finished on the synced branch; a human decides how to deliver it.`);
    const ownership = this.#store.workspaces.getByTaskAttempt(request.taskId, request.attemptId);
    if (ownership.outcome !== "success" || ownership.value.state !== "active" || ownership.value.assignedBranch !== latest.branch) return result("reconciliation_required", "Branch sync requires active workspace ownership by the latest Attempt.");
    const worktree = ownership.value.worktreePath;
    const from = latest.finalCommit;
    const git = (args: readonly string[], timeoutMs = GIT_STEP_TIMEOUT_MS) => this.#git.run(args, worktree, timeoutMs, request.signal);

    const fetched = await git(["fetch", "--no-tags", request.remoteName, `refs/heads/${request.baseBranch}`]);
    if (fetched.outcome !== "success") return result("retryable", `Fetching ${request.baseBranch} failed: ${output(fetched)}`);
    const base = (await git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
    if (!SHA.test(base)) return result("retryable", `Could not read the fetched ${request.baseBranch} revision.`);
    const head = await git(["rev-parse", "HEAD"]);
    if (head.outcome !== "success") return result("reconciliation_required", "The Task worktree HEAD could not be read.");
    let merged = head.stdout.trim();

    if (merged === from) {
      // GitHub recomputes "behind" lazily; right after a sync it may still say so.
      if ((await git(["merge-base", "--is-ancestor", base, from])).outcome === "success") return result("retryable", `${latest.branch} already contains ${request.baseBranch} (${base.slice(0, 7)}); waiting for GitHub to recompute the PR state.`);
      const status = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
      if (status.outcome !== "success" || status.stdout.length !== 0) return result("reconciliation_required", "The Task worktree is not clean; Pirx does not merge into uncommitted changes.");
      const merge = await git(["merge", "--no-ff", "--no-edit", "-m", `Merge ${request.baseBranch} into ${latest.branch}`, base]);
      if (merge.outcome !== "success") {
        const conflicted = (await git(["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 50);
        await git(["merge", "--abort"]);
        return conflicted.length > 0
          ? result("conflict", `Merging ${request.baseBranch} into ${latest.branch} conflicts in ${conflicted.length} file(s); a worker or human must resolve them.`, { conflictedFiles: conflicted })
          : result("reconciliation_required", `Merging ${request.baseBranch} failed: ${output(merge)}`);
      }
      merged = (await git(["rev-parse", "HEAD"])).stdout.trim();
    }

    // Either the merge just made, or one made before a crash: its parents must be the delivered commit and a base commit.
    const parents = (await git(["rev-list", "--parents", "-n", "1", merged])).stdout.trim().split(/\s+/u);
    if (!SHA.test(merged) || parents.length !== 3 || parents[0] !== merged || parents[1] !== from) return result("reconciliation_required", `The Task worktree HEAD ${merged.slice(0, 12)} is not a Pirx merge of ${from.slice(0, 12)}.`);
    const onBase = await git(["merge-base", "--is-ancestor", parents[2]!, base]);
    if (onBase.outcome !== "success") return result("reconciliation_required", `The merged parent ${parents[2]!.slice(0, 12)} is not on ${request.baseBranch}.`);

    // No force: a branch someone else moved is a conflict for a human. Repository hooks run on this push.
    const pushed = await git(["push", request.remoteName, `${merged}:refs/heads/${latest.branch}`], PUSH_TIMEOUT_MS);
    if (pushed.outcome !== "success") {
      const text = output(pushed);
      return isRepositoryRejection(pushed.outcome, pushed.exitCode, fullOutput(pushed))
        ? result("rejected", `The repository rejected the pushed merge of ${request.baseBranch}: ${text}`, { commit: merged })
        : result("retryable", `Pushing the merge of ${request.baseBranch} failed (${pushed.outcome}): ${text}`, { commit: merged });
    }

    const recorded = this.#record(request, latest, merged);
    if (recorded.outcome !== "success") return result("reconciliation_required", `The merge ${merged.slice(0, 12)} was pushed but not recorded: ${recorded.message}`, { commit: merged });
    return result("synced", `Pirx merged ${request.baseBranch} (${parents[2]!.slice(0, 7)}) into ${latest.branch} as ${merged.slice(0, 7)}; CI runs on the merge commit next.`, { successorAttemptId: recorded.value, commit: merged });
  }

  #record(request: FeatureBranchSyncRequest, predecessor: AttemptSnapshot & { readonly state: "terminal" }, merged: string): StorageResult<AttemptId> {
    return this.#store.transaction<AttemptId>(({ tasks, attempts, workspaces }) => {
      const task = tasks.get(request.taskId);
      const history = attempts.listByTask(request.taskId);
      if (task.outcome !== "success") return task;
      if (history.outcome !== "success") return history;
      const id = `attempt:${request.taskId}:${history.value.length + 1}:${Date.parse(request.now)}`.slice(0, 128) as AttemptId;
      const started = retryTask(task.value, history.value, { id, worker: BRANCH_SYNC_WORKER, provider: BRANCH_SYNC_PROVIDER, predecessorAttemptId: predecessor.id, branch: predecessor.branch!, worktree: predecessor.worktree!, currentCommit: predecessor.finalCommit!, progress: `merging ${request.baseBranch}` }, request.now);
      if (!started.ok) return { outcome: "conflict" as const, message: started.error.message };
      const updated = tasks.update(started.value.task, { state: task.value.state, updatedAt: task.value.updatedAt });
      if (updated.outcome !== "success") return updated;
      const created = attempts.create(started.value.attempt);
      if (created.outcome !== "success") return created;
      // Ownership moves only to a running Attempt, so transfer before the Attempt finishes.
      const transferred = workspaces.transfer({ taskId: request.taskId, fromAttemptId: predecessor.id, toAttemptId: id, transferredAt: request.now });
      if (transferred.outcome !== "success") return transferred;
      const moved = workspaces.updateCurrentRevision(id, transferred.value.ownershipToken, transferred.value.version, merged, request.now);
      if (moved.outcome !== "success") return moved;
      const finished = transitionAttempt(started.value.attempt, "running", { type: "finish", result: "CODE_PUSHED", branch: predecessor.branch!, finalCommit: merged, currentCommit: merged, progress: `Pirx merged ${request.baseBranch} into the branch` }, request.now);
      if (!finished.ok) return { outcome: "conflict" as const, message: finished.error.message };
      const saved = attempts.update(finished.value, "running");
      if (saved.outcome !== "success") return saved;
      return { outcome: "success" as const, value: id };
    });
  }
}

function consecutiveSyncs(history: readonly AttemptSnapshot[]): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0 && history[index]!.provider === BRANCH_SYNC_PROVIDER; index -= 1) count += 1;
  return count;
}
