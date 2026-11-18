import { GitWorkspaceCommandRunner, gitCause } from "./workspace.js";
import { WorkspaceCleanupCoordinator } from "./workspace-cleanup.js";
import type { RuntimeSqliteStore } from "./sqlite.js";
import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";

export type TaskBranchCleanupOutcome = "deleted" | "kept_unmerged" | "kept_moved" | "workspace_kept" | "failed";
export interface TaskBranchCleanupRequest { readonly taskId: TaskId; readonly attemptId: AttemptId; readonly remoteName: string; readonly baseBranch: string; readonly now: UtcTimestamp; readonly signal?: AbortSignal }
export interface TaskBranchCleanupResult { readonly outcome: TaskBranchCleanupOutcome; readonly message: string }

const TIMEOUT_MS = 60_000;

/**
 * After a completed Task's pipeline passed, removes its worktree and deletes its branch
 * locally and on the remote. A branch is deleted only when the base branch contains its
 * exact head, and the remote one only while it still points at that head.
 */
export class TaskBranchCleanup {
  readonly #store: RuntimeSqliteStore;
  readonly #git: GitWorkspaceCommandRunner;
  readonly #workspaces: Pick<WorkspaceCleanupCoordinator, "cleanup">;

  public constructor(store: RuntimeSqliteStore, git = new GitWorkspaceCommandRunner(), workspaces: Pick<WorkspaceCleanupCoordinator, "cleanup"> = new WorkspaceCleanupCoordinator(store, git)) {
    this.#store = store; this.#git = git; this.#workspaces = workspaces;
  }

  public async cleanup(request: TaskBranchCleanupRequest): Promise<TaskBranchCleanupResult> {
    const ownership = this.#store.workspaces.getByTaskAttempt(request.taskId, request.attemptId);
    if (ownership.outcome !== "success") return { outcome: "failed", message: `Workspace ownership is unavailable: ${ownership.message}` };
    const { repositoryRoot: root, assignedBranch: branch, currentRevision: head } = ownership.value;
    const removed = await this.#workspaces.cleanup({ taskId: request.taskId, attemptId: request.attemptId, disposition: "task_completed", remoteName: request.remoteName, now: request.now, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    if (removed.outcome !== "removed" && removed.outcome !== "already_removed") return { outcome: "workspace_kept", message: `The worktree was kept (${removed.outcome}): ${removed.message}` };
    const git = (args: readonly string[]) => this.#git.run(args, root, TIMEOUT_MS, request.signal);

    const fetched = await git(["fetch", "--no-tags", request.remoteName, `refs/heads/${request.baseBranch}`]);
    if (fetched.outcome !== "success") return { outcome: "failed", message: `Fetching ${request.baseBranch} failed: ${gitCause(fetched)}` };
    if ((await git(["merge-base", "--is-ancestor", head, "FETCH_HEAD"])).outcome !== "success") return { outcome: "kept_unmerged", message: `${branch} was kept: ${request.baseBranch} does not contain its head ${head.slice(0, 7)}.` };

    // The lease deletes the remote branch only while it is still at the merged head. The push has no
    // commits, so repository pre-push gates have nothing to check.
    const deleted = await git(["push", "--no-verify", `--force-with-lease=refs/heads/${branch}:${head}`, request.remoteName, `:refs/heads/${branch}`]);
    if (deleted.outcome !== "success") {
      const remote = await git(["ls-remote", request.remoteName, `refs/heads/${branch}`]);
      if (remote.outcome !== "success" || remote.stdout.trim() !== "") return { outcome: "kept_moved", message: `${branch} was kept on ${request.remoteName}: ${gitCause(deleted)}` };
    }
    if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).outcome === "success") {
      const local = await git(["branch", "-D", branch]);
      if (local.outcome !== "success") return { outcome: "failed", message: `The local branch ${branch} could not be deleted: ${gitCause(local)}` };
    }
    return { outcome: "deleted", message: `Deleted ${branch} (${head.slice(0, 7)}, on ${request.baseBranch}) and its worktree.` };
  }
}
